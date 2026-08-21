#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { AgentBridgeClient } from './ws-client.js';
import { EventNormalizer } from './normalizer.js';
import type { AgentEvent, AgentInput, DeviceAction } from './adapters/types.js';
import type { UnifiedMessage } from './types.js';

export interface SessionBridgeOptions {
  adapter: {
    send(input: AgentInput): AsyncIterable<AgentEvent>;
    handleUserAction(action: DeviceAction): Promise<void>;
    disconnect?(): Promise<void>;
  };
  sendEvent: (msg: UnifiedMessage) => Promise<void>;
  normalizer?: { fromAgentEvent(event: AgentEvent): UnifiedMessage };
  sessionId?: string;
}

export interface UserActionInput {
  type: string;
  taskId?: string;
  text?: string;
  deviceType?: string;
}

export class SessionBridge {
  private readonly adapter: SessionBridgeOptions['adapter'];
  private readonly sendEvent: SessionBridgeOptions['sendEvent'];
  private readonly normalizer?: SessionBridgeOptions['normalizer'];
  private readonly sessionId: string;
  private running = false;
  private queue: { type: 'user_message'; text: string; taskId?: string }[] = [];

  constructor(options: SessionBridgeOptions) {
    this.adapter = options.adapter;
    this.sendEvent = options.sendEvent;
    this.normalizer = options.normalizer;
    this.sessionId = options.sessionId || 'default';
  }

  async handleUserAction(action: UserActionInput): Promise<void> {
    if (action.type === 'user_message') {
      this.queue.push({ type: 'user_message', text: action.text ?? '', taskId: action.taskId });
      await this.drain();
      return;
    }

    await this.adapter.handleUserAction({
      type: action.type,
      taskId: action.taskId,
      deviceType: action.deviceType ?? 'glasses',
      text: action.text,
    });
  }

  async close(): Promise<void> {
    await this.adapter.disconnect?.();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        const input: AgentInput = {
          type: 'user_message',
          text: next.text,
          taskId: next.taskId,
          sessionId: this.sessionId,
        };
        for await (const event of this.adapter.send(input)) {
          await this.forward(event);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async forward(event: AgentEvent): Promise<void> {
    const msg = this.normalizer ? this.normalizer.fromAgentEvent(event) : eventToMessage(event, this.sessionId);
    await this.sendEvent(msg);
  }
}

export async function main(): Promise<void> {
  const serverUrl = process.env.AGENTBRIDGE_URL || 'http://localhost:8088';
  const sessionId = process.env.AGENTBRIDGE_SESSION || 'default';
  const claudePath = process.env.CLAUDE_PATH || 'claude';

  const wsClient = new AgentBridgeClient({ serverUrl, sessionId });
  const adapter = new ClaudeCodeAdapter({ claudePath, sessionId });
  const normalizer = new EventNormalizer(sessionId, adapter.name);
  const bridge = new SessionBridge({
    adapter,
    normalizer,
    sessionId,
    sendEvent: (msg) => wsClient.sendEvent(msg),
  });

  wsClient.on('user_action', (action) => {
    void bridge.handleUserAction(action as UserActionInput).catch((err) => {
      console.error('[session] failed to handle user action:', err instanceof Error ? err.message : err);
    });
  });
  wsClient.on('connected', () => console.log(`[session] connected to ${serverUrl} (session=${sessionId})`));
  wsClient.on('disconnected', () => console.warn('[session] disconnected from middleware core, will retry...'));
  wsClient.on('error', (err) => console.error('[session] ws error:', err.message));

  process.on('SIGINT', async () => {
    await bridge.close();
    wsClient.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await bridge.close();
    wsClient.close();
    process.exit(0);
  });

  wsClient.connect();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

function eventToMessage(event: AgentEvent, sessionId: string): UnifiedMessage {
  const body = 'content' in event ? event.content
    : 'summary' in event ? event.summary
    : 'error' in event ? event.error
    : 'reason' in event ? event.reason
    : event.type;
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task_id: ('taskId' in event ? event.taskId : '') || sessionId,
    session_id: sessionId,
    event_type: event.type === 'needs_approval' ? 'needs_approval'
      : event.type === 'task_completed' || event.type === 'done' ? 'task_completed'
      : event.type === 'task_failed' ? 'task_failed'
      : event.type === 'task_blocked' ? 'task_blocked'
      : event.type === 'task_started' ? 'task_started'
      : 'task_running',
    title: event.type,
    body,
    severity: event.type === 'task_failed' ? 'critical'
      : event.type === 'needs_approval' || event.type === 'task_blocked' ? 'warning'
      : 'info',
    risk_score: 'risk' in event ? event.risk : 0,
    risk_blocked: false,
    available_actions: [],
    timestamp: new Date().toISOString(),
    agent_id: 'claude-cli',
  };
}
