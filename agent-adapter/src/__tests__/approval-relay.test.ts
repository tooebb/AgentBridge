import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, permissionDecisionOutput } from '../hooks/approval-relay.js';

test('parseHookInput extracts tool fields from stdin JSON', () => {
  const raw = JSON.stringify({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/x' },
    tool_use_id: 'tu_9',
    cwd: '/repo',
  });
  const input = parseHookInput(raw);
  assert.equal(input.toolName, 'Bash');
  assert.deepEqual(input.toolInput, { command: 'rm -rf /tmp/x' });
  assert.equal(input.toolUseId, 'tu_9');
  assert.equal(input.cwd, '/repo');
});

test('parseHookInput tolerates missing fields', () => {
  const input = parseHookInput('{}');
  assert.equal(input.toolName, '');
  assert.deepEqual(input.toolInput, {});
  assert.equal(input.toolUseId, '');
  assert.equal(input.cwd, undefined);
});

test('permissionDecisionOutput emits hook JSON', () => {
  const out = permissionDecisionOutput('allow', 'approved from glasses');
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'approved from glasses');
});

test('permissionDecisionOutput emits deny', () => {
  const parsed = JSON.parse(permissionDecisionOutput('deny', 'rejected'));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});
