const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const CORE_DIR = path.join(ROOT, 'middleware-core');
const GO_BIN = process.env.GO_BIN || process.env.GO || 'go';
const SERVER = process.env.SERVER || 'http://127.0.0.1:18080';
const WS_URL = SERVER.replace(/^http/, 'ws');
const SESSION = `e2e-${Date.now()}`;
const TASK = 'task-e2e';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 7000);

let passed = 0;
let failed = 0;
let core = null;
let tmpDir = null;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? ' - ' + detail : ''}`);
    failed++;
  }
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 8080,
      path: parsed.pathname + parsed.search,
      method,
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      let out = '';
      res.on('data', (chunk) => out += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${out}`));
          return;
        }
        resolve(out ? JSON.parse(out) : {});
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForHealth() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await request('GET', `${SERVER}/health`);
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error('middleware core health check timed out');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOpen(ws, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} connect timeout`)), TIMEOUT_MS);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(ws, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      reject(new Error(`${label} timed out`));
    }, TIMEOUT_MS);

    function onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.removeListener('message', onMessage);
        resolve(msg);
      }
    }

    ws.on('message', onMessage);
  });
}

function startCore(dbPath) {
  const serverUrl = new URL(SERVER);
  const addr = process.env.AGENTBRIDGE_ADDR || `${serverUrl.hostname}:${serverUrl.port || '8080'}`;
  const child = spawn(GO_BIN, ['run', './cmd/server'], {
    cwd: CORE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      AGENTBRIDGE_EVENT_DB: dbPath,
      AGENTBRIDGE_ADDR: addr,
      GOPATH: process.env.GOPATH || path.join(os.tmpdir(), 'go-path'),
      GOCACHE: process.env.GOCACHE || path.join(os.tmpdir(), 'go-build'),
      GOMODCACHE: process.env.GOMODCACHE || path.join(os.tmpdir(), 'go-mod'),
    },
  });

  child.stdout.on('data', (data) => process.stdout.write(`[core] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[core] ${data}`));
  child.on('error', (err) => {
    console.error(`[core] failed to start: ${err.message}`);
  });
  return child;
}

async function stopCore() {
  if (!core || core.killed) return;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      killCoreProcess('SIGKILL');
      resolve();
    }, 3000);
    core.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    killCoreProcess('SIGTERM');
  });
  core = null;
}

function killCoreProcess(signal) {
  if (!core || core.killed) return;
  try {
    process.kill(-core.pid, signal);
  } catch {
    try {
      core.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

async function postEvent(eventType, id, extra = {}) {
  return request('POST', `${SERVER}/api/v1/events`, {
    id,
    task_id: TASK,
    session_id: SESSION,
    event_type: eventType,
    title: extra.title || eventType,
    body: extra.body || eventType,
    severity: extra.severity || 'info',
    risk_score: extra.risk_score || 0,
    risk_blocked: false,
    available_actions: extra.available_actions || [],
    timestamp: new Date().toISOString(),
    agent_id: 'e2e',
  });
}

async function run() {
  console.log('\n  AgentBridge E2E - Replay + User Action Relay\n');
  console.log(`  Session: ${SESSION}`);

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbridge-e2e-'));
  const dbPath = path.join(tmpDir, 'events.db');

  core = startCore(dbPath);
  core.once('exit', (code) => {
    if (code !== null && code !== 0 && !core?.killed) {
      console.error(`[core] exited with code ${code}`);
    }
  });
  await waitForHealth();
  check('middleware core started with SQLite', true);

  await postEvent('task_started', 'evt-started', { title: 'Started' });
  await postEvent('needs_approval', 'evt-approval', {
    title: 'Approval required',
    body: 'Run deploy command',
    severity: 'warning',
    risk_score: 0.7,
    available_actions: [
      { action_type: 'approve', label: 'Approve', confirmation_required: false },
      { action_type: 'reject', label: 'Reject', confirmation_required: false },
      { action_type: 'view_details', label: 'View Details', confirmation_required: false },
    ],
  });

  const phoneReplay = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=phone&last_acked_seq=0`);
  const replayStartedPromise = waitForMessage(phoneReplay, (msg) => msg.event?.event_type === 'task_started', 'task_started replay');
  const replayApprovalPromise = waitForMessage(phoneReplay, (msg) => msg.event?.event_type === 'needs_approval', 'needs_approval replay');
  await waitForOpen(phoneReplay, 'phone replay');
  const replayStarted = await replayStartedPromise;
  const replayApproval = await replayApprovalPromise;
  check('replayed task_started has seq=1', replayStarted.seq === 1 && replayStarted.is_replay === true);
  check('replayed needs_approval has seq=2', replayApproval.seq === 2 && replayApproval.is_replay === true);

  const adapter = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=agent_adapter`);
  await waitForOpen(adapter, 'agent adapter');
  const actionPromise = waitForMessage(adapter, (msg) => msg.event?.event_type === 'user_action', 'agent user_action relay');

  phoneReplay.send(JSON.stringify({
    direction: 'client_to_server',
    session_id: SESSION,
    task_id: TASK,
    last_acked_seq: replayApproval.seq,
    action: {
      type: 'approve',
      device_type: 'phone',
      timestamp: Date.now(),
      text: 'approved from e2e',
    },
  }));

  const actionMsg = await actionPromise;
  check('agent_adapter received approve user_action', actionMsg.event?.action?.type === 'approve');
  check('user_action preserves device text', actionMsg.event?.action?.text === 'approved from e2e');
  check('user_action assigned next seq', actionMsg.seq === 3);

  phoneReplay.close();
  adapter.close();
  await stopCore();

  core = startCore(dbPath);
  await waitForHealth();
  check('middleware core restarted on same SQLite DB', true);

  const phoneAfterRestart = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=phone&last_acked_seq=2`);
  const replayAfterRestartPromise = waitForMessage(phoneAfterRestart, (msg) => msg.seq > 2, 'post-restart replay');
  await waitForOpen(phoneAfterRestart, 'phone after restart');
  const replayAfterRestart = await replayAfterRestartPromise;
  check('post-restart replay starts after last_acked_seq', replayAfterRestart.seq === 3);
  check('post-restart replay is marked replay', replayAfterRestart.is_replay === true);
  check('post-restart replay preserves user_action', replayAfterRestart.event?.event_type === 'user_action');
  phoneAfterRestart.close();

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error('Test error:', err.message);
  process.exitCode = 1;
}).finally(async () => {
  await stopCore();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});
