import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRelay } from '../relay.js';
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
