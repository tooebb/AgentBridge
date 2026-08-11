import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { assessRisk, DEFAULT_RISK_THRESHOLD } from '../risk';
import { RawEvent } from '../types';
import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './types';

export interface ClaudeAdapterOptions {
  /** Path to the claude binary. Default: 'claude'. */
  claudePath?: string;
  /** Session identifier used for all emitted events. */
  sessionId: string;
  riskThreshold?: number;
  approvalTimeoutMs?: number;
}

type ClaudeStreamEvent = Record<string, any>;
type ToolPermissionDecision = 'allow' | 'deny';

interface PendingPermission {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  risk: number;
  timer: NodeJS.Timeout;
}

interface RawEventWithAgentEvent extends RawEvent {
  agentEvent?: AgentEvent;
}

/**
 * ClaudeCodeAdapter spawns a Claude Code process and emits structured
 * RawEvents for every line of stdout / stderr output.
 *
 * Claude Code is spawned in --print mode with stream-json output format
 * for structured event parsing when available, falling back to plain-text
 * line-by-line processing.
 */
export class ClaudeCodeAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'claude-cli';
  readonly capabilities: AdapterCapability[] = ['file_ops', 'shell_exec', 'code_search', 'conversation'];

  private process: ChildProcess | null = null;
  private sessionId: string;
  private claudePath: string;
  private pendingPermission: PendingPermission | null = null;
  private readonly riskThreshold: number;
  private readonly approvalTimeoutMs: number;

  constructor(options: ClaudeAdapterOptions) {
    super();
    this.sessionId = options.sessionId;
    this.claudePath = options.claudePath || 'claude';
    this.riskThreshold = options.riskThreshold ?? Number(process.env.AGENTBRIDGE_RISK_THRESHOLD || DEFAULT_RISK_THRESHOLD);
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? Number(process.env.AGENTBRIDGE_CORE_TIMEOUT || 30_000);
  }

  async connect(): Promise<void> {
    await checkClaudeAvailable(this.claudePath);
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    if (input.type === 'action_response') {
      return;
    }

    const queue: AgentEvent[] = [];
    let closed = false;
    let error: Error | null = null;
    let notify: (() => void) | null = null;

    const wake = () => {
      notify?.();
      notify = null;
    };
    const onEvent = (raw: RawEventWithAgentEvent) => {
      queue.push(this.rawToAgentEvent(raw));
      wake();
    };
    const onClose = () => {
      closed = true;
      wake();
    };
    const onError = (err: Error) => {
      error = err;
      wake();
    };

    this.on('event', onEvent);
    this.once('close', onClose);
    this.once('error', onError);

    this.start(input.text);
    yield { type: 'task_started', taskId: input.taskId || input.sessionId || this.sessionId };

    try {
      while (!closed || queue.length > 0) {
        if (error) {
          throw error;
        }
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } finally {
      this.off('event', onEvent);
      this.off('close', onClose);
      this.off('error', onError);
    }
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    if (this.pendingPermission && (!action.taskId || action.taskId === this.pendingPermission.requestId)) {
      const approved = action.type === 'approve' || action.type === 'continue';
      this.resolvePendingPermission(approved ? 'allow' : 'deny', 'device_action');
      this.emit('action_sent', { actionType: action.type, taskId: action.taskId || this.sessionId });
      return;
    }

    this.sendAction(action.type, action.taskId || this.sessionId);
  }

  async disconnect(): Promise<void> {
    await this.stop();
  }

  /** Launch Claude Code and begin capturing output. */
  start(prompt?: string): void {
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-mode', 'default',
    ];
    if (prompt) {
      args.push('-p', prompt);
    }

    this.process = spawn(this.claudePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // stdout: structured JSON or plain text.
    const stdout = createInterface({ input: this.process.stdout! });
    stdout.on('line', (line: string) => {
      this.emitEvent(line.trim(), 'stdout');
    });

    // stderr: error output.
    const stderr = createInterface({ input: this.process.stderr! });
    stderr.on('line', (line: string) => {
      this.emitEvent(line.trim(), 'stderr');
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    this.process.on('close', (code) => {
      this.clearPendingPermission();
      if (code !== 0) {
        this.emitEvent(
          `Claude Code exited with code ${code}`,
          'hook'
        );
      }
      this.emit('close', code);
    });

    // Prompt is passed through -p in print mode; stdin is reserved for JSON control responses.
  }

  /**
   * Send a user action back to Claude Code via stdin.
   * Stream-json mode expects JSON lines on stdin.
   */
  sendAction(actionType: string, taskId: string): void {
    if (!this.process?.stdin?.writable) {
      this.emit('error', new Error('Cannot send action: process stdin not writable'));
      return;
    }

    const messages: Record<string, unknown> = {
      approve: { type: 'user', message: { role: 'user', content: 'Approved. Continue.' } },
      reject: { type: 'user', message: { role: 'user', content: 'Rejected. Stop this action and propose a safer alternative.' } },
      continue: { type: 'user', message: { role: 'user', content: 'Continue.' } },
      pause: { type: 'user', message: { role: 'user', content: 'Pause and wait for further instructions.' } },
      view_details: { type: 'user', message: { role: 'user', content: 'Show more details about the current task.' } },
    };

    const msg = messages[actionType] || { type: 'user', message: { role: 'user', content: actionType } };
    this.process.stdin.write(JSON.stringify(msg) + '\n');
    this.emit('action_sent', { actionType, taskId });
  }

  /** Kill the Claude Code process. */
  async stop(): Promise<void> {
    this.clearPendingPermission();
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  private emitEvent(rawOutput: string, source: 'stdout' | 'stderr' | 'hook'): void {
    if (!rawOutput) return;

    let agentEvent: AgentEvent | undefined;
    // Try to parse as stream-json for richer metadata.
    try {
      const parsed = JSON.parse(rawOutput);
      agentEvent = this.handleClaudeStreamJsonEvent(parsed);
      if (parsed.event || parsed.type) {
        rawOutput = parsed.text || parsed.message || rawOutput;
      }
    } catch {
      // Not JSON - use raw text directly. This is the common case.
    }

    const event: RawEventWithAgentEvent = {
      agentId: 'claude-code',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      rawOutput,
      source,
      agentEvent,
    };

    this.emit('event', event);
  }

  private handleClaudeStreamJsonEvent(event: ClaudeStreamEvent): AgentEvent | undefined {
    const eventType = event.type || event.event;
    if (eventType !== 'control' || controlType(event) !== 'tool_permission') {
      return parseClaudeStreamJsonEvent(event);
    }

    const requestId = permissionRequestId(event);
    const tool = toolName(event);
    const input = toolInput(event);
    const risk = assessRisk(tool, input);

    if (risk < this.riskThreshold) {
      this.writeToolPermissionDecision(requestId, 'allow');
      return { type: 'tool_call', tool, args: input };
    }

    this.setPendingPermission({ requestId, tool, input, risk });
    return { type: 'needs_approval', tool, risk, taskId: requestId };
  }

  private setPendingPermission(permission: Omit<PendingPermission, 'timer'>): void {
    this.clearPendingPermission();
    const timer = setTimeout(() => {
      if (!this.pendingPermission || this.pendingPermission.requestId !== permission.requestId) {
        return;
      }
      this.emitEvent(`Approval timed out after ${this.approvalTimeoutMs}ms; auto-allowing ${permission.tool}`, 'hook');
      this.resolvePendingPermission('allow', 'timeout');
    }, this.approvalTimeoutMs);
    this.pendingPermission = { ...permission, timer };
  }

  private resolvePendingPermission(decision: ToolPermissionDecision, reason: string): void {
    if (!this.pendingPermission) {
      return;
    }
    const requestId = this.pendingPermission.requestId;
    this.clearPendingPermission();
    this.writeToolPermissionDecision(requestId, decision, reason);
  }

  private writeToolPermissionDecision(requestId: string, decision: ToolPermissionDecision, reason?: string): void {
    if (!this.process?.stdin?.writable) {
      this.emit('error', new Error('Cannot send tool permission: process stdin not writable'));
      return;
    }
    this.process.stdin.write(JSON.stringify(buildToolPermissionDecision(requestId, decision, reason)) + '\n');
  }

  private clearPendingPermission(): void {
    if (this.pendingPermission) {
      clearTimeout(this.pendingPermission.timer);
    }
    this.pendingPermission = null;
  }

  private rawToAgentEvent(raw: RawEventWithAgentEvent): AgentEvent {
    if (raw.agentEvent) {
      return raw.agentEvent;
    }
    if (raw.source === 'stderr') {
      return { type: 'task_failed', taskId: this.sessionId, error: raw.rawOutput };
    }
    return { type: 'text', content: raw.rawOutput };
  }
}

function checkClaudeAvailable(claudePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = spawn(claudePath, ['--version'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });
    let stderr = '';
    probe.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    probe.on('error', (err) => {
      reject(new Error(`Claude Code CLI is unavailable: ${err.message}`));
    });
    probe.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Claude Code CLI version probe failed with code ${code}: ${stderr.trim()}`));
    });
  });
}

export function parseClaudeStreamJsonEvent(event: ClaudeStreamEvent): AgentEvent | undefined {
  const eventType = event.type || event.event;

  if (eventType === 'control' && controlType(event) === 'tool_permission') {
    const tool = toolName(event);
    const input = toolInput(event);
    const risk = assessRisk(tool, input);
    return {
      type: 'needs_approval',
      tool,
      risk,
      taskId: permissionRequestId(event),
    };
  }

  if (eventType === 'assistant') {
    const content = assistantText(event);
    return content ? { type: 'text', content } : undefined;
  }

  if (eventType === 'result') {
    const summary = typeof event.result === 'string'
      ? event.result
      : typeof event.text === 'string'
        ? event.text
        : 'Claude Code task completed';
    return { type: 'task_completed', taskId: event.task_id || event.session_id || 'claude-code', summary };
  }

  if (eventType === 'system') {
    const content = typeof event.text === 'string' ? event.text : undefined;
    return content ? { type: 'text', content } : undefined;
  }

  return undefined;
}

function controlType(event: ClaudeStreamEvent): string | undefined {
  return event.control?.control_type
    || event.control?.type
    || event.control?.subtype
    || event.control_type
    || event.subtype;
}

function permissionRequestId(event: ClaudeStreamEvent): string {
  return event.request_id
    || event.control?.request_id
    || event.task_id
    || event.session_id
    || event.control?.id
    || 'claude-code';
}

function toolName(event: ClaudeStreamEvent): string {
  return event.control?.tool_name
    || event.control?.toolName
    || event.control?.name
    || event.tool_name
    || event.toolName
    || event.name
    || 'unknown';
}

function toolInput(event: ClaudeStreamEvent): Record<string, unknown> {
  return event.control?.tool_input
    || event.control?.input
    || event.control?.arguments
    || event.tool_input
    || event.input
    || event.arguments
    || {};
}

export function buildToolPermissionDecision(requestId: string, decision: ToolPermissionDecision, reason?: string): Record<string, unknown> {
  return {
    type: 'control',
    control_type: 'tool_permission',
    request_id: requestId,
    decision,
    ...(reason ? { reason } : {}),
  };
}

function assistantText(event: ClaudeStreamEvent): string | undefined {
  if (typeof event.text === 'string') return event.text;
  if (typeof event.message === 'string') return event.message;
  if (event.message && typeof event.message === 'object' && 'content' in event.message) {
    const content = event.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) {
            return String(part.text);
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
  }
  return undefined;
}
