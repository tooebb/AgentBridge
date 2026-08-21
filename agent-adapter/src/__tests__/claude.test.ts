import test from 'node:test';
import assert from 'node:assert/strict';
import type { Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeAdapter, mapClaudeSDKMessage, type ClaudeQueryFactory } from '../adapters/claude.js';

test('mapClaudeSDKMessage converts SDK assistant text and result messages', () => {
  assert.deepEqual(
    mapClaudeSDKMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
      session_id: 'session-1',
    } as SDKMessage, 'task-1'),
    { type: 'text', content: 'hello' }
  );

  assert.deepEqual(
    mapClaudeSDKMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'session-1',
    } as SDKMessage, 'task-1'),
    { type: 'task_completed', taskId: 'task-1', summary: 'done' }
  );

  assert.deepEqual(
    mapClaudeSDKMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['failed'],
      session_id: 'session-1',
    } as SDKMessage, 'task-1'),
    { type: 'task_failed', taskId: 'task-1', error: 'failed' }
  );
});

test('ClaudeCodeAdapter emits needs_approval and resolves approve to SDK allow', async () => {
  const decisions: PermissionResult[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: makeQueryFactory(async function* (options) {
      yield sdkInit('session-1');
      decisions.push(await permissionDecision(options, 'Write', { file_path: 'hello.txt' }, 'req-1'));
      yield sdkResult('session-1', 'wrote file');
    }),
  });

  const iter = adapter.send({ type: 'start_task', text: 'write file', sessionId: 'session-1' })[Symbol.asyncIterator]();

  assert.deepEqual(await nextValue(iter), { type: 'task_started', taskId: 'session-1' });
  assert.deepEqual(await nextValue(iter), {
    type: 'needs_approval',
    tool: 'Write',
    risk: 0.4,
    taskId: 'session-1',
    input: { file_path: 'hello.txt' },
  });

  await adapter.handleUserAction({ type: 'approve', taskId: 'session-1', deviceType: 'glasses' });

  assert.deepEqual(await nextValue(iter), { type: 'task_completed', taskId: 'session-1', summary: 'wrote file' });
  assert.deepEqual(decisions, [{ behavior: 'allow', updatedInput: { file_path: 'hello.txt' } }]);
  assert.equal((await iter.next()).done, true);
});

test('ClaudeCodeAdapter attaches preceding assistant text as reasoning', async () => {
  const decisions: PermissionResult[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: makeQueryFactory(async function* (options) {
      yield sdkInit('session-1');
      yield sdkAssistant('session-1', 'I will write the file now.');
      decisions.push(await permissionDecision(options, 'Write', { file_path: 'hello.txt' }, 'req-5'));
      yield sdkResult('session-1', 'wrote file');
    }),
  });

  const iter = adapter.send({ type: 'start_task', text: 'write file', sessionId: 'session-1' })[Symbol.asyncIterator]();

  assert.deepEqual(await nextValue(iter), { type: 'task_started', taskId: 'session-1' });
  assert.deepEqual(await nextValue(iter), { type: 'text', content: 'I will write the file now.' });
  assert.deepEqual(await nextValue(iter), {
    type: 'needs_approval',
    tool: 'Write',
    risk: 0.4,
    taskId: 'session-1',
    input: { file_path: 'hello.txt' },
    reasoning: 'I will write the file now.',
  });

  await adapter.handleUserAction({ type: 'approve', taskId: 'session-1', deviceType: 'glasses' });
  assert.deepEqual(await nextValue(iter), { type: 'task_completed', taskId: 'session-1', summary: 'wrote file' });
  assert.deepEqual(decisions, [{ behavior: 'allow', updatedInput: { file_path: 'hello.txt' } }]);
});

test('ClaudeCodeAdapter resolves reject to SDK deny', async () => {
  const decisions: PermissionResult[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: makeQueryFactory(async function* (options) {
      decisions.push(await permissionDecision(options, 'Bash', { command: 'git push origin main' }, 'req-2'));
      yield sdkResult('session-1', 'rejected safely');
    }),
  });

  const iter = adapter.send({ type: 'start_task', text: 'push', sessionId: 'session-1' })[Symbol.asyncIterator]();

  assert.deepEqual(await nextValue(iter), {
    type: 'needs_approval',
    tool: 'Bash',
    risk: 0.6,
    taskId: 'session-1',
    input: { command: 'git push origin main' },
  });
  await adapter.handleUserAction({ type: 'reject', taskId: 'session-1', deviceType: 'glasses' });

  assert.deepEqual(await nextValue(iter), { type: 'task_completed', taskId: 'session-1', summary: 'rejected safely' });
  assert.equal(decisions[0]?.behavior, 'deny');
  assert.match(decisions[0]?.behavior === 'deny' ? decisions[0].message : '', /Rejected by the user/);
});

test('ClaudeCodeAdapter leaves view_details pending until a decision arrives', async () => {
  const decisions: PermissionResult[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: makeQueryFactory(async function* (options) {
      decisions.push(await permissionDecision(options, 'Write', { file_path: 'hello.txt' }, 'req-3'));
      yield sdkResult('session-1', 'done');
    }),
  });

  const iter = adapter.send({ type: 'start_task', text: 'write file', sessionId: 'session-1' })[Symbol.asyncIterator]();

  assert.deepEqual(await nextValue(iter), {
    type: 'needs_approval',
    tool: 'Write',
    risk: 0.4,
    taskId: 'session-1',
    input: { file_path: 'hello.txt' },
  });
  await adapter.handleUserAction({ type: 'view_details', taskId: 'session-1', deviceType: 'glasses' });

  assert.equal(decisions.length, 0);
  const pendingNext = iter.next();
  assert.equal(await settlesWithin(pendingNext, 20), false);

  await adapter.handleUserAction({ type: 'continue', taskId: 'session-1', deviceType: 'glasses' });
  const resumed = await pendingNext;
  assert.equal(resumed.done, false);
  assert.equal(resumed.value.type, 'task_completed');
  assert.equal(decisions[0]?.behavior, 'allow');
});

test('ClaudeCodeAdapter auto-allows pending permissions after timeout', async () => {
  const decisions: PermissionResult[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    approvalTimeoutMs: 10,
    queryFactory: makeQueryFactory(async function* (options) {
      decisions.push(await permissionDecision(options, 'Write', { file_path: 'hello.txt' }, 'req-4'));
      yield sdkResult('session-1', 'done after timeout');
    }),
  });

  const iter = adapter.send({ type: 'start_task', text: 'write file', sessionId: 'session-1' })[Symbol.asyncIterator]();

  assert.deepEqual(await nextValue(iter), {
    type: 'needs_approval',
    tool: 'Write',
    risk: 0.4,
    taskId: 'session-1',
    input: { file_path: 'hello.txt' },
  });
  assert.equal((await nextValue(iter)).type, 'text');
  assert.deepEqual(decisions, [{ behavior: 'allow', updatedInput: { file_path: 'hello.txt' } }]);
  assert.deepEqual(await nextValue(iter), { type: 'task_completed', taskId: 'session-1', summary: 'done after timeout' });
});

test('ClaudeCodeAdapter resumes session for user_message inputs', async () => {
  const resumeIds: (string | undefined)[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: ({ options }) => {
      resumeIds.push(options?.resume);
      const q = (async function* () {
        yield sdkInit('session-abc');
        yield sdkResult('session-abc', 'done');
      })() as Query;
      q.close = () => undefined;
      return q;
    },
  });

  for await (const _ of adapter.send({ type: 'start_task', text: 'first', sessionId: 'session-1' })) {}
  for await (const _ of adapter.send({ type: 'user_message', text: 'second', sessionId: 'session-1' })) {}

  assert.deepEqual(resumeIds, [undefined, 'session-abc']);
});

function makeQueryFactory(generator: (options: Options) => AsyncGenerator<SDKMessage, void>): ClaudeQueryFactory {
  return ({ options }) => {
    const q = generator(options || {}) as Query;
    q.close = () => undefined;
    return q;
  };
}

function sdkInit(sessionId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  } as SDKMessage;
}

function sdkResult(sessionId: string, result: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: sessionId,
  } as SDKMessage;
}

function sdkAssistant(sessionId: string, text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    session_id: sessionId,
  } as SDKMessage;
}

function permissionOptions(requestId: string) {
  return {
    signal: new AbortController().signal,
    requestId,
    toolUseID: requestId,
  };
}

async function permissionDecision(
  options: Options,
  toolName: string,
  input: Record<string, unknown>,
  requestId: string
): Promise<PermissionResult> {
  assert.ok(options.canUseTool);
  const decision = await options.canUseTool(toolName, input, permissionOptions(requestId));
  assert.ok(decision);
  return decision;
}

async function nextValue<T>(iter: AsyncIterator<T>): Promise<T> {
  const result = await iter.next();
  assert.equal(result.done, false);
  return result.value;
}

async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  const sentinel = Symbol('timeout');
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<typeof sentinel>((resolve) => setTimeout(() => resolve(sentinel), ms)),
  ]);
  return result !== sentinel;
}
