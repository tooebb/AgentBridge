import { ClaudeAPIAdapter } from './adapters/claude-api';
import type { AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './adapters/types';

export class AgentHub {
  private readonly adapters = new Map<string, AgentAdapter>();
  private active: AgentAdapter | null = null;

  constructor() {
    this.register(new ClaudeAPIAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  async select(preferred?: string): Promise<AgentAdapter> {
    const order = preferred ? [preferred] : ['claude-api', 'claude-cli'];

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
