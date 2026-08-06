#!/usr/bin/env node
/**
 * AgentBridge Agent Adapter
 *
 * Wraps a Claude Code process, captures its output, classifies events
 * through the Context Engine + Normalizer pipeline, and sends
 * UnifiedMessages to the Middleware Core via REST.
 */

import { ClaudeCodeAdapter } from './adapters/claude';
import { GenericCLIAdapter } from './adapters/generic-cli';
import { AgentHub } from './hub';
import { AgentBridgeClient } from './ws-client';
import { EventNormalizer } from './normalizer';
import type { AgentEvent, AgentInput } from './adapters/types';

// ── Configuration (from env vars with sensible defaults) ──
const SERVER_URL = process.env.AGENTBRIDGE_URL || 'http://localhost:8080';
const SESSION_ID = process.env.AGENTBRIDGE_SESSION || `session-${Date.now()}`;
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const INITIAL_PROMPT = process.env.AGENTBRIDGE_PROMPT;
const PREFERRED_AGENT = process.env.AGENTBRIDGE_AGENT;

const wsClient = new AgentBridgeClient({
  serverUrl: SERVER_URL,
  sessionId: SESSION_ID,
  reconnectInterval: 2000,
});

const hub = new AgentHub();
hub.register(new GenericCLIAdapter({ sessionId: SESSION_ID }));
hub.register(new ClaudeCodeAdapter({ claudePath: CLAUDE_PATH, sessionId: SESSION_ID }));

let normalizer = new EventNormalizer(SESSION_ID);
let shuttingDown = false;

async function forwardEvent(event: AgentEvent): Promise<void> {
  const msg = normalizer.fromAgentEvent(event);
  await wsClient.sendEvent(msg);
  console.log(`[${msg.timestamp}] ${msg.event_type}: ${msg.title.slice(0, 80)}`);
}

wsClient.on('user_action', async (action) => {
  console.log(`[adapter] received user action: ${action.type} for task ${action.taskId}`);
  try {
    await hub.handleUserAction(action);
    for await (const event of hub.execute({ type: 'action_response', action })) {
      await forwardEvent(event);
    }
  } catch (err) {
    console.error('[adapter] failed to handle user action:', err instanceof Error ? err.message : err);
  }
});

// Connection events.
wsClient.on('connected', () => {
  console.log(`[adapter] connected to ${SERVER_URL} (session=${SESSION_ID})`);
});

wsClient.on('disconnected', () => {
  console.warn('[adapter] disconnected from middleware core, will retry...');
});

wsClient.on('error', (err) => {
  console.error('[adapter] connection error:', err.message);
});

// ── Graceful shutdown ──
process.on('SIGINT', async () => {
  console.log('\n[adapter] shutting down...');
  shuttingDown = true;
  await hub.shutdown();
  wsClient.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  shuttingDown = true;
  await hub.shutdown();
  wsClient.close();
  process.exit(0);
});

// ── Start ──
console.log(`[adapter] AgentBridge Agent Adapter starting`);
console.log(`  Server: ${SERVER_URL}`);
console.log(`  Session: ${SESSION_ID}`);
console.log(`  Preferred agent: ${PREFERRED_AGENT || 'auto'}`);
console.log(`  Claude CLI: ${CLAUDE_PATH}`);
if (process.env.AGENTBRIDGE_AGENT_CMD) {
  console.log(`  Generic CLI: ${process.env.AGENTBRIDGE_AGENT_CMD}`);
}

async function runAgentLoop(input: AgentInput): Promise<void> {
  for await (const event of hub.execute(input)) {
    await forwardEvent(event);
  }
  console.log('[adapter] agent turn complete, waiting for user actions...');
}

async function main(): Promise<void> {
  const adapter = await hub.select(PREFERRED_AGENT);
  normalizer = new EventNormalizer(SESSION_ID, adapter.name);
  wsClient.connect();

  await runAgentLoop({
    type: 'start_task',
    text: INITIAL_PROMPT,
    sessionId: SESSION_ID,
  });

  // Keep process alive for user actions — do NOT close/shutdown here.
  // The adapter stays connected to Core so approve/reject from glasses
  // can be relayed back to the agent via the user_action handler below.
}

main().catch(async (err) => {
  console.error('[adapter] fatal error:', err instanceof Error ? err.message : err);
  wsClient.close();
  await hub.shutdown();
  process.exit(1);
});
