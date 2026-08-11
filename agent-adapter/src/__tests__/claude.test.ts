import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolPermissionDecision, parseClaudeStreamJsonEvent } from '../adapters/claude';

test('parseClaudeStreamJsonEvent converts assistant text', () => {
  assert.deepEqual(
    parseClaudeStreamJsonEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
    { type: 'text', content: 'hello' }
  );
});

test('parseClaudeStreamJsonEvent converts tool permission controls', () => {
  assert.deepEqual(
    parseClaudeStreamJsonEvent({
      type: 'control',
      control: {
        control_type: 'tool_permission',
        request_id: 'req-1',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
      },
    }),
    { type: 'needs_approval', tool: 'Bash', risk: 0.6, taskId: 'req-1' }
  );
});

test('buildToolPermissionDecision writes Claude Code control JSON', () => {
  assert.deepEqual(
    buildToolPermissionDecision('req-1', 'deny', 'device_action'),
    {
      type: 'control',
      control_type: 'tool_permission',
      request_id: 'req-1',
      decision: 'deny',
      reason: 'device_action',
    }
  );
});
