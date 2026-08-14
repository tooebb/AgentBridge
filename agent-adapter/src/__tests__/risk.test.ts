import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../risk.js';

test('assessRisk treats read-only tools as safe', () => {
  assert.equal(assessRisk('Read', { path: 'README.md' }), 0);
  assert.equal(assessRisk('Grep', { pattern: 'TODO' }), 0);
});

test('assessRisk escalates command and publish operations', () => {
  assert.equal(assessRisk('Bash', { command: 'git push origin main' }), 0.6);
  assert.equal(assessRisk('run_shell', { command: 'rm -rf /tmp/example' }), 0.9);
  assert.equal(assessRisk('run_shell', { command: 'rm -fr /tmp/example' }), 0.9);
  assert.equal(assessRisk('run_shell', { command: 'rm --recursive --force /tmp/example' }), 0.9);
  assert.equal(assessRisk('execute_command', { command: 'git push --force origin main' }), 0.85);
});

test('assessRisk marks writes and unknown tools as approval-worthy', () => {
  assert.equal(assessRisk('Write', { path: 'src/index.ts' }), 0.4);
  assert.equal(assessRisk('unknown_tool', {}), 0.4);
});
