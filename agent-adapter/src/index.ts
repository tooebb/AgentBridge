#!/usr/bin/env node
/**
 * AgentBridge Agent Adapter
 *
 * Wraps a Claude Code process, captures its output, classifies events
 * through the Context Engine + Normalizer pipeline, and sends
 * UnifiedMessages to the Middleware Core via REST.
 */

import { ClaudeCodeAdapter } from './adapters/claude';
import { AgentBridgeClient } from './ws-client';
import { ContextEngine } from './context/engine';
import { EventNormalizer } from './normalizer';

// ── Configuration (from env vars with sensible defaults) ──
const SERVER_URL = process.env.AGENTBRIDGE_URL || 'http://localhost:8080';
const SESSION_ID = process.env.AGENTBRIDGE_SESSION || `session-${Date.now()}`;
const CLAUDE_PATH = process.env.CLAUDE_PATH || 'claude';
const INITIAL_PROMPT = process.env.AGENTBRIDGE_PROMPT;

// ── Initialize pipeline ──
const contextEngine = new ContextEngine(5);
const normalizer = new EventNormalizer(SESSION_ID, 'claude-code');
const wsClient = new AgentBridgeClient({
  serverUrl: SERVER_URL,
  sessionId: SESSION_ID,
  reconnectInterval: 2000,
});
const adapter = new ClaudeCodeAdapter({
  claudePath: CLAUDE_PATH,
  sessionId: SESSION_ID,
});

// ── Wire the pipeline ──

// 1. Raw event from Claude → push to context engine.
// 2. Context engine provides hints → normalizer classifies.
// 3. UnifiedMessage sent to middleware core via REST.
adapter.on('event', (raw) => {
  // Push raw event into sliding window first.
  contextEngine.push(raw);

  // Build context snapshot.
  const ctx = contextEngine.getContext();

  // Normalize: raw text → structured UnifiedMessage.
  const msg = normalizer.normalize(raw, ctx);

  // Send to middleware core.
  wsClient.sendEvent(msg).catch((err) => {
    console.error('[adapter] failed to send event:', err.message);
  });

  // Log locally.
  console.log(
    `[${new Date(raw.timestamp).toISOString()}] ${msg.event_type}: ${msg.title.slice(0, 80)}`
  );
});

// User actions from middleware core → inject into Claude.
wsClient.on('user_action', (action) => {
  console.log(`[adapter] received user action: ${action.type} for task ${action.taskId}`);
  adapter.sendAction(action.type, action.taskId);
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

adapter.on('close', (code) => {
  console.log(`[adapter] Claude Code exited with code ${code}`);
  wsClient.close();
  process.exit(code || 0);
});

adapter.on('error', (err) => {
  console.error('[adapter] Claude Code error:', err.message);
});

// ── Graceful shutdown ──
process.on('SIGINT', async () => {
  console.log('\n[adapter] shutting down...');
  await adapter.stop();
  wsClient.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await adapter.stop();
  wsClient.close();
  process.exit(0);
});

// ── Start ──
console.log(`[adapter] AgentBridge Agent Adapter starting`);
console.log(`  Server: ${SERVER_URL}`);
console.log(`  Session: ${SESSION_ID}`);
console.log(`  Claude: ${CLAUDE_PATH}`);

wsClient.connect();
adapter.start(INITIAL_PROMPT);
