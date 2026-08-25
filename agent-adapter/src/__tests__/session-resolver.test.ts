import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeProjectDir,
  resolveLatestSessionId,
  resolveSessionFile,
  persistSessionId,
} from '../session-resolver.js';

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

test('encodeProjectDir replaces forward slashes with dashes (matches SDK encoding)', () => {
  assert.equal(
    encodeProjectDir('D:/project/5project/AgentBridge-master'),
    'D--project-5project-AgentBridge-master',
  );
  assert.equal(
    encodeProjectDir('D:/project/5project/AgentBridge-master/agent-adapter'),
    'D--project-5project-AgentBridge-master-agent-adapter',
  );
});

test('encodeProjectDir replaces underscore and dot with dashes (matches SDK encoding)', () => {
  assert.equal(
    encodeProjectDir('C:/Users/_/.agentbridge/glasses-session'),
    'C--Users----agentbridge-glasses-session',
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

test('resolveSessionFile defaults to .agentbridge-current-session under cwd', () => {
  const prev = process.env.AGENTBRIDGE_SESSION_FILE;
  delete process.env.AGENTBRIDGE_SESSION_FILE;
  try {
    assert.equal(
      resolveSessionFile('D:\\proj'),
      join('D:\\proj', '.agentbridge-current-session'),
    );
  } finally {
    if (prev !== undefined) process.env.AGENTBRIDGE_SESSION_FILE = prev;
  }
});

test('resolveSessionFile honors AGENTBRIDGE_SESSION_FILE override', () => {
  const prev = process.env.AGENTBRIDGE_SESSION_FILE;
  process.env.AGENTBRIDGE_SESSION_FILE = 'C:\\tmp\\session.txt';
  try {
    assert.equal(resolveSessionFile('D:\\proj'), 'C:\\tmp\\session.txt');
  } finally {
    if (prev === undefined) delete process.env.AGENTBRIDGE_SESSION_FILE;
    else process.env.AGENTBRIDGE_SESSION_FILE = prev;
  }
});

test('persistSessionId writes the session id to a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abr-session-file-'));
  try {
    const file = join(dir, 'session.txt');
    persistSessionId(file, '1d2f3549-b1e9-4fc9-bea5-cf4fc77fab5c');
    assert.equal(
      readFileSync(file, 'utf8'),
      '1d2f3549-b1e9-4fc9-bea5-cf4fc77fab5c\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistSessionId does not throw when the directory does not exist', () => {
  const file = join(tmpdir(), 'abr-no-such-dir', 'session.txt');
  assert.doesNotThrow(() => {
    persistSessionId(file, '1d2f3549-b1e9-4fc9-bea5-cf4fc77fab5c');
  });
});
