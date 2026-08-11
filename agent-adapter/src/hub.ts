import { ClaudeCodeAdapter } from './adapters/claude';
import { ClaudeAPIAdapter } from './adapters/claude-api';
import { GenericCLIAdapter } from './adapters/generic-cli';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible';
import type { AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './adapters/types';

export class AgentHub {
  private readonly adapters = new Map<string, AgentAdapter>();
  private active: AgentAdapter | null = null;

  constructor() {
    this.register(new ClaudeCodeAdapter({
      claudePath: process.env.CLAUDE_PATH || 'claude',
      sessionId: process.env.AGENTBRIDGE_SESSION || `session-${Date.now()}`,
    }));
    this.register(new ClaudeAPIAdapter());
    this.register(new OpenAICompatibleAdapter());
    this.register(new GenericCLIAdapter({
      sessionId: process.env.AGENTBRIDGE_SESSION || `session-${Date.now()}`,
    }));
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  async select(preferred?: string): Promise<AgentAdapter> {
    const order = preferred
      ? [preferred]
      : ['claude-cli', 'claude-api', 'openai-compatible', 'generic-cli'];

    for (const name of order) {
      const adapter = this.adapters.get(name);
      if (!adapter) continue;

      try {
        await adapter.connect();
        this.active = adapter;
        console.log(`[AgentHub] active adapter: ${adapter.name}`);
        return adapter;
      } catch (err) {
        console.warn(`[AgentHub] adapter ${name} unavailable: ${this.errorMessage(err)}`);
      }
    }

    throw new Error('No available Agent adapter');
  }

  async *execute(input: AgentInput): AsyncIterable<AgentEvent> {
    if (!this.active) {
      throw new Error('No active Agent adapter');
    }
    yield* this.active.send(input);
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    if (!this.active) {
      throw new Error('No active Agent adapter');
    }
    await this.active.handleUserAction(action);
  }

  activeName(): string {
    return this.active?.name || 'none';
  }

  async shutdown(): Promise<void> {
    if (this.active) {
      await this.active.disconnect();
    }
    this.active = null;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
