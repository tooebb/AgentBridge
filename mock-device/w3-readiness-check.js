const http = require('http');
const WebSocket = require('ws');

const SERVER = process.env.SERVER || 'http://127.0.0.1:8080';
const WS_URL = SERVER.replace(/^http/, 'ws');
const SESSION = process.env.SESSION || `w3-${Date.now()}`;
const TASK = process.env.TASK || 'task-w3-readiness';
const TIMEOUT_MS = Number(process.env.W3_TIMEOUT_MS || 7000);

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? ' - ' + detail : ''}`);
    failed++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  throw new Error(`middleware core is not reachable at ${SERVER}`);
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
    risk_blocked: extra.risk_blocked || false,
    available_actions: extra.available_actions || [],
    timestamp: new Date().toISOString(),
    agent_id: 'w3-readiness',
  });
}

async function run() {
  console.log('\n  AgentBridge W3 Readiness Check\n');
  console.log(`  Server:  ${SERVER}`);
  console.log(`  Session: ${SESSION}`);

  await waitForHealth();
  check('middleware core health endpoint is reachable', true);

  await postEvent('needs_approval', 'evt-w3-approval', {
    title: 'W3 approval required',
    body: 'Validate glasses button/voice approval path',
    severity: 'warning',
    risk_score: 0.45,
    available_actions: [
      { action_type: 'approve', label: 'Approve', confirmation_required: false },
      { action_type: 'reject', label: 'Reject', confirmation_required: false },
      { action_type: 'continue', label: 'Continue', confirmation_required: false },
      { action_type: 'pause', label: 'Pause', confirmation_required: false },
      { action_type: 'view_details', label: 'View Details', confirmation_required: false },
    ],
  });

  const glasses = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=ar_glasses&last_acked_seq=0`);
  const approvalPromise = waitForMessage(glasses, (msg) => msg.event?.event_type === 'needs_approval', 'glasses approval message');
  await waitForOpen(glasses, 'ar_glasses');
  const approval = await approvalPromise;
  check('ar_glasses receives approval event', approval.event?.event_type === 'needs_approval');
  check('approval has seq for ack tracking', Number(approval.seq) > 0);
  check('approval has replay marker on initial backlog', approval.is_replay === true);
  check('glasses override includes quick actions', approval.device_overrides?.ar_glasses?.quick_actions?.includes('approve'));
  check('glasses override includes TTS text', Boolean(approval.device_overrides?.ar_glasses?.tts_text));
  check('glasses override includes actionable render hint', approval.device_overrides?.ar_glasses?.render_hint === 'actionable_card');

  const adapter = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=agent_adapter`);
  await waitForOpen(adapter, 'agent_adapter');
  const actionPromise = waitForMessage(adapter, (msg) => msg.event?.event_type === 'user_action', 'user_action relay');

  glasses.send(JSON.stringify({
    direction: 'client_to_server',
    session_id: SESSION,
    task_id: TASK,
    last_acked_seq: approval.seq,
    action: {
      type: 'approve',
      device_type: 'ar_glasses',
      timestamp: Date.now(),
      text: 'approved by W3 voice path',
    },
  }));

  const actionMsg = await actionPromise;
  check('approve action relays to agent_adapter', actionMsg.event?.action?.type === 'approve');
  check('action relay preserves ar_glasses device type', actionMsg.event?.action?.device_type === 'ar_glasses');
  check('action relay preserves voice text', actionMsg.event?.action?.text === 'approved by W3 voice path');
  check('action relay uses next seq', actionMsg.seq > approval.seq);

  glasses.close();
  await sleep(200);

  const reconnectSeq = approval.seq;
  const reconnected = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=ar_glasses&last_acked_seq=${reconnectSeq}`);
  const replayPromise = waitForMessage(reconnected, (msg) => msg.seq > reconnectSeq, 'post-reconnect replay');
  await waitForOpen(reconnected, 'ar_glasses reconnect');
  const replay = await replayPromise;
  check('reconnect replays messages after last_acked_seq', replay.seq === actionMsg.seq);
  check('reconnect replay is marked replay', replay.is_replay === true);

  adapter.close();
  reconnected.close();

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Readiness check error:', err.message);
  process.exit(1);
});
