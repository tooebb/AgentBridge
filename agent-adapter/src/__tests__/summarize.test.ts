import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../summarize.js';
import type { ChatClient } from '../summarize.js';

function mockClient(result: string | Error): ChatClient {
  return {
    create: async () => {
      if (result instanceof Error) throw result;
      return { content: [{ type: 'text', text: result }] };
    },
  };
}

test('summarize returns LLM summary', async () => {
  const summary = await summarize('some long text', {}, mockClient('一句话摘要'));
  assert.equal(summary, '一句话摘要');
});

test('summarize falls back to truncation on LLM error', async () => {
  const text = 'a'.repeat(200);
  const summary = await summarize(text, { maxLen: 80 }, mockClient(new Error('boom')));
  assert.equal(summary, 'a'.repeat(80) + '…');
});

test('summarize keeps short text unchanged on error', async () => {
  const summary = await summarize('short', { maxLen: 80 }, mockClient(new Error('boom')));
  assert.equal(summary, 'short');
});

test('summarize falls back to truncation on empty LLM result', async () => {
  const text = 'b'.repeat(100);
  const summary = await summarize(text, { maxLen: 50 }, mockClient(''));
  assert.equal(summary, 'b'.repeat(50) + '…');
});
