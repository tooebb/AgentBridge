import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, resolveLatestSessionId } from '../session-resolver.js';

test('encodeProjectDir replaces backslashes and colons with dashes', () => {
  assert.equal(
    encodeProjectDir('D:\\project\\5project\\AgentBridge-master'),
    'D--project-5project-AgentBridge-master',
  );
  assert.equal(
    encodeProjectDir('D:\\project\\5project\\AgentBridge-master\\agent-adapter'),
    'D--project-5project-AgentBridge-master-agent-adapter',
  );
});

test('resolveLatestSessionId returns null when project has no sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'abr-sessions-'));
  try {
    assert.equal(resolveLatestSessionId('D:\\no\\such\\project', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveLatestSessionId returns the most recently modified session', () => {
  const root = mkdtempSync(join(tmpdir(), 'abr-sessions-'));
  try {
    const dir = join(root, 'D--proj');
    mkdirSync(dir, { recursive: true });
    const older = join(dir, '11111111-1111-1111-1111-111111111111.jsonl');
    const newer = join(dir, '22222222-2222-2222-2222-222222222222.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    const now = new Date();
    utimesSync(older, now, new Date(now.getTime() - 10000));
    utimesSync(newer, now, new Date(now.getTime()));
    assert.equal(
      resolveLatestSessionId('D:\\proj', root),
      '22222222-2222-2222-2222-222222222222',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
