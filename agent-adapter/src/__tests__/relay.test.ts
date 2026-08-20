import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApprovalRelay, handleApprove, handleSummary } from '../relay.js';
import type { UnifiedMessage } from '../types.js';

function makeRelay(timeoutMs: number, sent: UnifiedMessage[] = []) {
  const relay = new ApprovalRelay({
    sendEvent: async (msg) => { sent.push(msg); },
    sessionId: 'default',
    timeoutMs,
  });
  return { relay, sent };
}

const req = { toolUseId: 'tu_1', toolName: 'Write', toolInput: { file_path: 'x.txt' }, risk: 0.4 };

test('requestApproval sends needs_approval with task_id = toolUseId', async () => {
  const { relay, sent } = makeRelay(0);
  const p = relay.requestApproval(req);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event_type, 'needs_approval');
  assert.equal(sent[0].task_id, 'tu_1');
  assert.equal(sent[0].risk_score, 0.4);
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });
  assert.equal(await p, 'allow');
});

test('handleUserAction approve resolves allow', async () => {
  const { relay } = makeRelay(0);
  const p = relay.requestApproval(req);
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });
  assert.equal(await p, 'allow');
});

test('handleUserAction reject resolves deny', async () => {
  const { relay } = makeRelay(0);
  const p = relay.requestApproval(req);
  relay.handleUserAction({ type: 'reject', taskId: 'tu_1' });
  assert.equal(await p, 'deny');
});

test('non-decision action does not resolve', async () => {
  const { relay } = makeRelay(0);
  const p = relay.requestApproval(req);
  relay.handleUserAction({ type: 'view_details', taskId: 'tu_1' });
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });
  assert.equal(await p, 'allow');
});

test('timeout auto-allows', async () => {
  const { relay } = makeRelay(30);
  const p = relay.requestApproval(req);
  assert.equal(await p, 'allow');
});

test('concurrent requests resolve independently', async () => {
  const { relay } = makeRelay(0);
  const p1 = relay.requestApproval({ ...req, toolUseId: 'tu_a' });
  const p2 = relay.requestApproval({ ...req, toolUseId: 'tu_b' });
  relay.handleUserAction({ type: 'reject', taskId: 'tu_a' });
  relay.handleUserAction({ type: 'approve', taskId: 'tu_b' });
  assert.equal(await p1, 'deny');
  assert.equal(await p2, 'allow');
});

test('POST /approve returns allow after user action', async () => {
  let eventSent!: () => void;
  const eventSentPromise = new Promise<void>((r) => { eventSent = r; });

  const relay = new ApprovalRelay({
    sendEvent: async () => { eventSent(); },
    sessionId: 'default',
    timeoutMs: 0,
  });

  const server = createServer((req, res) => { void handleApprove(req, res, relay); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const respPromise = fetch(`http://127.0.0.1:${port}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool_use_id: 'tu_1', tool_name: 'Write', tool_input: { file_path: 'x' }, risk: 0.4, cwd: '/tmp' }),
  });

  await eventSentPromise;
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });

  const resp = await respPromise;
  const body = await resp.json() as { decision: string };
  assert.equal(resp.status, 200);
  assert.equal(body.decision, 'allow');

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test('handleSummaryText sends task_completed with summary', async () => {
  const sent: UnifiedMessage[] = [];
  const relay = new ApprovalRelay({
    sendEvent: async (m) => { sent.push(m); },
    sessionId: 'default',
    timeoutMs: 0,
    summarize: async () => 'mock summary',
  });
  await relay.handleSummaryText('some raw text');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event_type, 'task_completed');
  assert.equal(sent[0].body, 'mock summary');
});

test('handleSummaryText dedupes identical text', async () => {
  const sent: UnifiedMessage[] = [];
  const relay = new ApprovalRelay({
    sendEvent: async (m) => { sent.push(m); },
    sessionId: 'default',
    timeoutMs: 0,
    summarize: async () => 'mock summary',
  });
  await relay.handleSummaryText('same text');
  await relay.handleSummaryText('same text');
  assert.equal(sent.length, 1);
});

test('POST /summary returns 200 and sends card', async () => {
  let eventSent!: (m: UnifiedMessage) => void;
  const sentPromise = new Promise<UnifiedMessage>((r) => { eventSent = r; });
  const relay = new ApprovalRelay({
    sendEvent: async (m) => eventSent(m),
    sessionId: 'default',
    timeoutMs: 0,
    summarize: async () => 'mock summary',
  });

  const server = createServer((req, res) => { void handleSummary(req, res, relay); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const resp = await fetch(`http://127.0.0.1:${port}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'some text' }),
  });
  assert.equal(resp.status, 200);

  const msg = await sentPromise;
  assert.equal(msg.event_type, 'task_completed');
  assert.equal(msg.body, 'mock summary');

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
