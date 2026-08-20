import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLastAssistantText } from '../hooks/summary-relay.js';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

test('extracts text from last end_turn assistant', () => {
  const jsonl = [
    line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done here' }], stop_reason: 'end_turn' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'done here');
});

test('returns empty when last assistant has no text (pure tool turn)', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'end_turn' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), '');
});

test('joins only text blocks, skipping tool_use', () => {
  const jsonl = [
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'part1' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'text', text: 'part2' },
        ],
        stop_reason: 'end_turn',
      },
    }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'part1\npart2');
});

test('returns empty for empty jsonl', () => {
  assert.equal(extractLastAssistantText(''), '');
});

test('skips invalid json lines', () => {
  const jsonl = [
    'not json',
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'ok');
});

test('skips non-end_turn assistant and finds earlier end_turn', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }], stop_reason: 'end_turn' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }], stop_reason: 'tool_use' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'first');
});
