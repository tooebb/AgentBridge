import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHub } from '../hub';
import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from '../adapters/types';

test('AgentHub prefers claude-cli by default', async () => {
  const previousClaudePath = process.env.CLAUDE_PATH;
  process.env.CLAUDE_PATH = process.execPath;

  const hub = new AgentHub();
  const adapter = await hub.select();

  assert.equal(adapter.name, 'claude-cli');
  assert.equal(hub.activeName(), 'claude-cli');
  await hub.shutdown();
  restoreEnv('CLAUDE_PATH', previousClaudePath);
});

test('AgentHub honors an explicit preferred adapter', async () => {
  const hub = new AgentHub();
  hub.register(new StubAdapter('custom'));

  const adapter = await hub.select('custom');

  assert.equal(adapter.name, 'custom');
});

class StubAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapability[] = ['conversation'];

  constructor(readonly name: string) {}

  async connect(): Promise<void> {
    return;
  }

  async *send(_input: AgentInput): AsyncIterable<AgentEvent> {
    return;
  }

  async handleUserAction(_action: DeviceAction): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    return;
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
