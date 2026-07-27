import { ChildProcess, spawn } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { RawEvent } from '../types';
import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './types';

export interface ClaudeAdapterOptions {
  /** Path to the claude binary. Default: 'claude'. */
  claudePath?: string;
  /** Session identifier used for all emitted events. */
  sessionId: string;
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
  private buffer = '';

  constructor(options: ClaudeAdapterOptions) {
    super();
    this.sessionId = options.sessionId;
    this.claudePath = options.claudePath || 'claude';
  }

  async connect(): Promise<void> {
    return;
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
    const onEvent = (raw: RawEvent) => {
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
      if (code !== 0) {
        this.emitEvent(
          `Claude Code exited with code ${code}`,
          'hook'
        );
      }
      this.emit('close', code);
    });

    // Send initial prompt if provided via stdin.
    if (prompt && this.process.stdin?.writable) {
      this.process.stdin.write(prompt + '\n');
    }
  }

  /**
   * Send a user action back to Claude Code via stdin.
   * For approvals, sends a confirmation message.
   */
  sendAction(actionType: string, taskId: string): void {
    if (!this.process?.stdin?.writable) {
      this.emit('error', new Error('Cannot send action: process stdin not writable'));
      return;
    }

    const messages: Record<string, string> = {
      approve: `/approve`,
      reject: `/reject`,
      continue: `/continue`,
      pause: 'Please pause and wait for further instructions.',
      view_details: 'Show me more details about the current task.',
    };

    const msg = messages[actionType] || actionType;
    this.process.stdin.write(msg + '\n');
    this.emit('action_sent', { actionType, taskId });
  }

  /** Kill the Claude Code process. */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  private emitEvent(rawOutput: string, source: 'stdout' | 'stderr' | 'hook'): void {
    if (!rawOutput) return;

    // Try to parse as stream-json for richer metadata.
    try {
      const parsed = JSON.parse(rawOutput);
      // If it's a structured event from Claude Code, extract the text.
      if (parsed.event || parsed.type) {
        rawOutput = parsed.text || parsed.message || rawOutput;
      }
    } catch {
      // Not JSON — use raw text directly. This is the common case.
    }

    const event: RawEvent = {
      agentId: 'claude-code',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      rawOutput,
      source,
    };

    this.emit('event', event);
  }

  private rawToAgentEvent(raw: RawEvent): AgentEvent {
    if (raw.source === 'stderr') {
      return { type: 'task_failed', taskId: this.sessionId, error: raw.rawOutput };
    }
    return { type: 'text', content: raw.rawOutput };
  }
}
