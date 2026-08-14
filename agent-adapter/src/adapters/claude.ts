import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { assessRisk, DEFAULT_RISK_THRESHOLD } from '../risk';
import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './types';

export interface ClaudeAdapterOptions {
  /** Path to the claude binary. Default: 'claude'. */
  claudePath?: string;
  /** Session identifier used for all emitted events. */
  sessionId: string;
  riskThreshold?: number;
  approvalTimeoutMs?: number;
  queryFactory?: ClaudeQueryFactory;
}

export type ClaudeQueryFactory = (params: {
  prompt: string;
  options?: Options;
}) => Query;

interface PendingPermission {
  taskId: string;
  tool: string;
  input: Record<string, unknown>;
  risk: number;
  resolve: (decision: PermissionResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * ClaudeCodeAdapter drives Claude Code through the Agent SDK.
 *
 * Dynamic tool approval is handled by the SDK canUseTool callback. The raw CLI
 * stream-json stdin/stdout control protocol is intentionally not used because
 * it does not expose a real per-tool approval response path.
 */
export class ClaudeCodeAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'claude-cli';
  readonly capabilities: AdapterCapability[] = ['file_ops', 'shell_exec', 'code_search', 'conversation'];

  private readonly sessionId: string;
  private readonly claudePath: string;
  private readonly queryFactory: ClaudeQueryFactory;
  private readonly riskThreshold: number;
  private readonly approvalTimeoutMs: number;
  private pendingPermission: PendingPermission | null = null;
  private activeQuery: Query | null = null;

  constructor(options: ClaudeAdapterOptions) {
    super();
    this.sessionId = options.sessionId;
    this.claudePath = options.claudePath || 'claude';
    this.queryFactory = options.queryFactory || query;
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

    const taskId = input.taskId || input.sessionId || this.sessionId;
    const queue: AgentEvent[] = [];
    let closed = false;
    let notify: (() => void) | null = null;
    const wake = () => {
      notify?.();
      notify = null;
    };
    const push = (event: AgentEvent) => {
      queue.push(event);
      wake();
    };
    const onAdapterEvent = (event: AgentEvent) => push(event);

    const abortController = new AbortController();
    let q: Query | null = null;

    this.on('event', onAdapterEvent);
    try {
      q = this.queryFactory({
        prompt: input.text || this.inputFallbackText(input),
        options: {
          abortController,
          canUseTool: this.canUseTool,
          cwd: process.cwd(),
          env: { ...process.env },
          pathToClaudeCodeExecutable: this.claudePath,
          permissionMode: 'default',
        },
      });
      this.activeQuery = q;

      void (async () => {
        try {
          for await (const message of q!) {
            const event = mapClaudeSDKMessage(message, taskId);
            if (event) {
              push(event);
            }
          }
        } catch (err) {
          push({
            type: 'task_failed',
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          closed = true;
          wake();
        }
      })();

      while (!closed || queue.length > 0) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    } catch (err) {
      yield {
        type: 'task_failed',
        taskId,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.clearPendingPermission();
      this.off('event', onAdapterEvent);
      if (q && this.activeQuery === q) {
        this.activeQuery = null;
      }
      abortController.abort();
    }
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    if (!this.pendingPermission) {
      this.emit('action_sent', { actionType: action.type, taskId: action.taskId || this.sessionId });
      return;
    }

    const pending = this.pendingPermission;
    if (action.taskId && action.taskId !== pending.taskId) {
      this.emit('action_sent', { actionType: action.type, taskId: action.taskId });
      return;
    }

    if (action.type === 'approve' || action.type === 'continue') {
      this.resolvePendingPermission({
        behavior: 'allow',
        updatedInput: pending.input,
      });
      this.emit('action_sent', { actionType: action.type, taskId: pending.taskId });
      return;
    }

    if (action.type === 'reject') {
      this.resolvePendingPermission({
        behavior: 'deny',
        message: `Rejected by the user from the connected device: ${pending.tool}`,
      });
      this.emit('action_sent', { actionType: action.type, taskId: pending.taskId });
      return;
    }

    this.emit('action_sent', { actionType: action.type, taskId: pending.taskId });
  }

  async disconnect(): Promise<void> {
    this.clearPendingPermission(new Error('Claude Code adapter disconnected'));
    this.activeQuery?.close();
    this.activeQuery = null;
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const risk = assessRisk(toolName, input);
    if (risk < this.riskThreshold) {
      return { behavior: 'allow', updatedInput: input };
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      const taskId = options.requestId || options.toolUseID || `${this.sessionId}:${Date.now()}`;
      this.clearPendingPermission();

      const timer = this.approvalTimeoutMs > 0
        ? setTimeout(() => {
            if (!this.pendingPermission || this.pendingPermission.taskId !== taskId) {
              return;
            }
            this.emit('event', {
              type: 'text',
              content: `[ClaudeCodeAdapter] approval timed out after ${this.approvalTimeoutMs}ms; auto-allowing ${toolName}`,
            } satisfies AgentEvent);
            this.resolvePendingPermission({ behavior: 'allow', updatedInput: input });
          }, this.approvalTimeoutMs)
        : null;

      this.pendingPermission = {
        taskId,
        tool: toolName,
        input,
        risk,
        resolve,
        reject,
        timer,
      };

      options.signal.addEventListener('abort', () => {
        if (!this.pendingPermission || this.pendingPermission.taskId !== taskId) {
          return;
        }
        this.clearPendingPermission(new Error(`Permission request aborted for ${toolName}`));
      }, { once: true });

      this.emit('event', {
        type: 'needs_approval',
        tool: toolName,
        risk,
        taskId,
      } satisfies AgentEvent);
    });
  };

  private resolvePendingPermission(decision: PermissionResult): void {
    if (!this.pendingPermission) {
      return;
    }

    const pending = this.pendingPermission;
    this.pendingPermission = null;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.resolve(decision);
  }

  private clearPendingPermission(err?: Error): void {
    if (!this.pendingPermission) {
      return;
    }

    const pending = this.pendingPermission;
    this.pendingPermission = null;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (err) {
      pending.reject(err);
    }
  }

  private inputFallbackText(input: AgentInput): string {
    if (input.action?.text) return input.action.text;
    if (input.action?.type) return `Device action received: ${input.action.type}. Continue.`;
    if (input.type === 'start_task') return 'Start the task.';
    return 'Continue.';
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

export function mapClaudeSDKMessage(message: SDKMessage, taskId: string): AgentEvent | undefined {
  if (message.type === 'system' && message.subtype === 'init') {
    return { type: 'task_started', taskId: message.session_id || taskId };
  }

  if (message.type === 'assistant') {
    const content = assistantText(message.message.content);
    return content ? { type: 'text', content } : undefined;
  }

  if (message.type === 'result') {
    if (message.is_error) {
      return {
        type: 'task_failed',
        taskId: message.session_id || taskId,
        error: resultText(message) || 'Claude Code task failed',
      };
    }

    return {
      type: 'task_completed',
      taskId: message.session_id || taskId,
      summary: resultText(message) || 'Claude Code task completed',
    };
  }

  return undefined;
}

function assistantText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
        return String(part.text);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');

  return text || undefined;
}

function resultText(message: SDKMessage): string | undefined {
  if (message.type !== 'result') {
    return undefined;
  }

  if ('result' in message && typeof message.result === 'string') {
    return message.result;
  }

  if ('errors' in message && Array.isArray(message.errors)) {
    return message.errors.join('\n') || undefined;
  }

  return undefined;
}
