import test from 'node:test';
import assert from 'node:assert/strict';
import { EventNormalizer } from '../normalizer.js';
import type { AgentEvent } from '../adapters/types.js';

test('fromAgentEvent generates details for needs_approval', () => {
  const normalizer = new EventNormalizer('session-1');
  const result = normalizer.fromAgentEvent({
    type: 'needs_approval',
    tool: 'Bash',
    risk: 0.3,
    taskId: 'session-1',
    input: { command: 'rm regression_test.txt' },
    reasoning: 'I will remove the leftover file.',
  });

  assert.equal(result.event_type, 'needs_approval');
  assert.match(result.details ?? '', /I will remove the leftover file\./);
  assert.match(result.details ?? '', /Command: rm regression_test\.txt/);
  assert.match(result.details ?? '', /Tool input:/);
});

test('fromAgentEvent leaves details empty for non-approval events', () => {
  const normalizer = new EventNormalizer('session-1');
  const result = normalizer.fromAgentEvent({ type: 'task_completed', taskId: 'session-1', summary: 'done' });
  assert.equal(result.details ?? '', '');
});
