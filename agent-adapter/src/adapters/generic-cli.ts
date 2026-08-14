import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './types.js';

interface GenericCLIAdapterOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  sessionId: string;
}

export class GenericCLIAdapter extends EventEmitter implements AgentAdapter {
  readonly name = 'generic-cli';
  readonly capabilities: AdapterCapability[] = ['conversation'];

  private process: ChildProcess | null = null;
  private readonly command?: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly sessionId: string;

  constructor(options: GenericCLIAdapterOptions) {
    super();
    this.command = options.command || process.env.AGENTBRIDGE_AGENT_CMD;
    this.args = options.args || parseArgs(process.env.AGENTBRIDGE_AGENT_ARGS);
    this.env = options.env || parseEnv(process.env.AGENTBRIDGE_AGENT_ENV);
    this.sessionId = options.sessionId;
  }

  async connect(): Promise<void> {
    if (!this.command) {
      throw new Error('AGENTBRIDGE_AGENT_CMD is not configured');
    }
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    if (input.type === 'action_response') {
      return;
    }

    const prompt = input.text || this.inputFallbackText(input);
    const taskId = input.taskId || input.sessionId || this.sessionId;

    yield { type: 'task_started', taskId };

    const queue: AgentEvent[] = [];
    let closed = false;
    let error: Error | null = null;
    let notify: (() => void) | null = null;

    const wake = () => {
      notify?.();
      notify = null;
    };

    this.on('event', onEvent);
    this.once('close', onClose);
    this.once('error', onError);

    this.start(prompt);

    try {
      while (!closed || queue.length > 0) {
        if (error) throw error;

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

    function onEvent(event: AgentEvent): void {
      queue.push(event);
      wake();
    }

    function onClose(): void {
      closed = true;
      wake();
    }

    function onError(err: Error): void {
      error = err;
      wake();
    }
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    if (!this.process?.stdin?.writable) {
      return;
    }

    const msg = action.text || actionToPrompt(action);
    this.process.stdin.write(msg + '\n');
  }

  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  private start(prompt: string): void {
    if (!this.command) {
      this.emit('error', new Error('AGENTBRIDGE_AGENT_CMD is not configured'));
      return;
    }

    const hasPromptPlaceholder = this.args.some((arg) => arg.includes('{prompt}'));
    const args = this.args.map((arg) => arg.replaceAll('{prompt}', prompt));

    this.process = spawn(this.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    const stdout = createInterface({ input: this.process.stdout! });
    stdout.on('line', (line) => this.emitLine(line, false));

    const stderr = createInterface({ input: this.process.stderr! });
    stderr.on('line', (line) => this.emitLine(line, true));

    this.process.on('error', (err) => this.emit('error', err));
    this.process.on('close', (code) => {
      if (code !== 0) {
        this.emit('event', {
          type: 'task_failed',
          taskId: this.sessionId,
          error: `Generic CLI exited with code ${code}`,
        } satisfies AgentEvent);
      }
      this.emit('close', code);
    });

    if (!hasPromptPlaceholder && prompt && this.process.stdin?.writable) {
      this.process.stdin.write(prompt + '\n');
    }
  }

  private emitLine(line: string, isError: boolean): void {
    const text = line.trim();
    if (!text) return;

    if (isError) {
      this.emit('event', { type: 'task_failed', taskId: this.sessionId, error: text } satisfies AgentEvent);
      return;
    }

    this.emit('event', { type: 'text', content: text } satisfies AgentEvent);
  }

  private inputFallbackText(input: AgentInput): string {
    if (input.action?.text) return input.action.text;
    if (input.action?.type) return actionToPrompt(input.action);
    if (input.type === 'start_task') return 'Start the task.';
    return 'Continue.';
  }
}

function actionToPrompt(action: DeviceAction): string {
  const messages: Record<string, string> = {
    approve: 'Approved by the user from the connected device. Continue.',
    reject: 'Rejected by the user from the connected device. Stop this action and propose a safer alternative.',
    continue: 'Continue.',
    pause: 'Pause and wait for further instructions.',
    view_details: 'Show more details about the current task.',
  };
  return messages[action.type] || action.type;
}

function parseArgs(value?: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    return value.split(/\s+/).filter(Boolean);
  }

  return value.split(/\s+/).filter(Boolean);
}

function parseEnv(value?: string): Record<string, string> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, envValue]) => [key, String(envValue)])
    );
  } catch {
    return {};
  }
}
