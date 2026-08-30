import test from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceGate } from '../utterance-gate.js';

test('snapshot is current before any new recording', () => {
  const gate = new UtteranceGate();
  const snap = gate.snapshot();
  assert.equal(gate.isCurrent(snap), true);
});

test('markNewRecording invalidates a prior snapshot', () => {
  const gate = new UtteranceGate();
  const snap = gate.snapshot();
  gate.markNewRecording();
  assert.equal(gate.isCurrent(snap), false);
});

test('a snapshot after markNewRecording is current', () => {
  const gate = new UtteranceGate();
  gate.markNewRecording();
  const snap = gate.snapshot();
  assert.equal(gate.isCurrent(snap), true);
});
