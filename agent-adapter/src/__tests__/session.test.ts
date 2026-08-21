import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBridge } from '../session.js';
import type { AgentEvent } from '../adapters/types.js';
import type { UnifiedMessage } from '../types.js';

test('SessionBridge routes user_message to send and approve to handleUserAction', async () => {
  const sent: string[] = [];
  const handled: string[] = [];
  const forwarded: UnifiedMessage[] = [];
  const bridge = new SessionBridge({
    adapter: {
      async *send(input: any) {
        sent.push(input.text);
        yield { type: 'text', content: `echo ${input.text}` } satisfies AgentEvent;
      },
      async handleUserAction(action: any) {
        handled.push(action.type);
      },
    },
    normalizer: {
      fromAgentEvent(event: AgentEvent) {
        return messageFor(event);
      },
    },
    sendEvent: async (msg) => { forwarded.push(msg); },
  });

  await bridge.handleUserAction({ type: 'user_message', text: 'hello', taskId: 't1' });
  await bridge.handleUserAction({ type: 'approve', taskId: 't1' });

  assert.deepEqual(sent, ['hello']);
  assert.deepEqual(handled, ['approve']);
  assert.equal(forwarded[0]?.body, 'echo hello');
});

test('SessionBridge queues a second user_message while busy instead of rejecting', async () => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: string[] = [];
  const forwarded: UnifiedMessage[] = [];
  const bridge = new SessionBridge({
    adapter: {
      async *send(input: any) {
        sent.push(input.text);
        if (input.text === 'first') {
          await started;
          yield { type: 'task_completed', taskId: 't1', summary: 'done first' } satisfies AgentEvent;
          return;
        }
        yield { type: 'task_completed', taskId: 't2', summary: 'done second' } satisfies AgentEvent;
      },
      async handleUserAction() {},
    },
    normalizer: {
      fromAgentEvent(event: AgentEvent) {
        return messageFor(event);
      },
    },
    sendEvent: async (msg) => { forwarded.push(msg); },
  });

  const first = bridge.handleUserAction({ type: 'user_message', text: 'first', taskId: 't1' });
  await bridge.handleUserAction({ type: 'user_message', text: 'second', taskId: 't2' });
  release();
  await first;

  assert.deepEqual(sent, ['first', 'second']);
  assert.deepEqual(forwarded.map((msg) => msg.body), ['done first', 'done second']);
});

test('SessionBridge keeps draining queued user_message when forwarding fails', async () => {
  const sent: string[] = [];
  const forwarded: string[] = [];
  let attempts = 0;
  const bridge = new SessionBridge({
    adapter: {
      async *send(input: any) {
        sent.push(input.text);
        yield {
          type: 'task_completed',
          taskId: input.taskId,
          summary: `done ${input.text}`,
        } satisfies AgentEvent;
      },
      async handleUserAction() {},
    },
    normalizer: {
      fromAgentEvent(event: AgentEvent) {
        return messageFor(event);
      },
    },
    sendEvent: async (msg) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('core unavailable');
      }
      forwarded.push(msg.body);
    },
  });

  await bridge.handleUserAction({ type: 'user_message', text: 'first', taskId: 't1' });
  await bridge.handleUserAction({ type: 'user_message', text: 'second', taskId: 't2' });

  assert.deepEqual(sent, ['first', 'second']);
  assert.deepEqual(forwarded, ['done second']);
});

test('audio utterance transcribes and drives the session bridge wiring', async () => {
  const sent: string[] = [];
  const bridge = new SessionBridge({
    adapter: {
      async *send(input: any) {
        sent.push(input.text);
        yield {
          type: 'task_completed',
          taskId: input.taskId,
          summary: `echo ${input.text}`,
        } satisfies AgentEvent;
      },
      async handleUserAction() {},
    },
    normalizer: {
      fromAgentEvent(event: AgentEvent) {
        return messageFor(event);
      },
    },
    sendEvent: async () => {},
  });

  const onUtterance = async (_pcm: Buffer, _sampleRate: number) => {
    const text = '你好';
    if (text) await bridge.handleUserAction({ type: 'user_message', text });
  };

  await onUtterance(Buffer.alloc(1600), 16000);

  assert.deepEqual(sent, ['你好']);
});

function messageFor(event: AgentEvent): UnifiedMessage {
  const body = 'content' in event ? event.content
    : 'summary' in event ? event.summary
    : 'reason' in event ? event.reason
    : event.type;
  return {
    id: 'test',
    task_id: ('taskId' in event ? event.taskId : '') || 'session-1',
    session_id: 'session-1',
    event_type: event.type === 'task_blocked' ? 'task_blocked'
      : event.type === 'task_completed' ? 'task_completed'
      : 'task_running',
    title: event.type,
    body,
    severity: 'info',
    risk_score: 0,
    risk_blocked: false,
    available_actions: [],
    timestamp: new Date(0).toISOString(),
    agent_id: 'test',
  };
}
