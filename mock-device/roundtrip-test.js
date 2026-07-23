const WebSocket = require('ws');

const SERVER = process.env.SERVER || process.argv[2] || 'http://localhost:8080';
const WS_URL = SERVER.replace('http', 'ws');
const SESSION = 'roundtrip-' + Date.now();
const TASK = 'task-rt';
const DEVICE = 'phone';

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function postEvent(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL('/api/v1/events', SERVER);
    const http = require('http');
    const req = http.request({
      hostname: url.hostname, port: url.port || 8080, path: url.pathname,
      method: 'POST', headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}
    }, (res) => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${out}`));
        else resolve({status: res.statusCode, body: JSON.parse(out)});
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function run() {
  console.log('\n  AgentBridge Mock Device — Roundtrip Test\n');
  console.log(`  Session: ${SESSION}`);

  // 1. Connect device
  const ws = new WebSocket(`${WS_URL}/ws/${SESSION}?device_type=${DEVICE}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
  check('device WS connected', true);

  // 2. Send needs_approval event, verify device receives it
  let deviceReceived = null;
  ws.on('message', (data) => {
    deviceReceived = JSON.parse(data.toString());
  });

  const resp1 = await postEvent({
    id: 'evt-1', task_id: TASK, session_id: SESSION,
    event_type: 'task_started', title: 'Task Started', body: 'Starting work',
    severity: 'info', risk_score: 0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'test'
  });
  await new Promise(r => setTimeout(r, 500));
  check('received task_started', deviceReceived?.event?.event_type === 'task_started');
  check('device_overrides present', deviceReceived?.device_overrides?.phone != null);
  check('phone render_hint', deviceReceived?.device_overrides?.phone?.render_hint != null,
    `hint=${deviceReceived?.device_overrides?.phone?.render_hint}`);

  // 3. Send needs_approval, verify phone gets quick_actions
  deviceReceived = null;
  const resp2 = await postEvent({
    id: 'evt-2', task_id: TASK, session_id: SESSION,
    event_type: 'needs_approval', title: 'Approve DB Migration', body: 'Run prisma migrate deploy',
    severity: 'warning', risk_score: 0.7, risk_blocked: false,
    available_actions: [
      {action_type:'approve', label:'Approve', confirmation_required:false},
      {action_type:'reject', label:'Reject', confirmation_required:false},
      {action_type:'view_details', label:'View Details', confirmation_required:false}
    ],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  });
  await new Promise(r => setTimeout(r, 500));
  check('received needs_approval', deviceReceived?.event?.event_type === 'needs_approval');
  check('risk assessed server-side', deviceReceived?.event?.risk_blocked === true,
    `risk_blocked=${deviceReceived?.event?.risk_blocked} risk_score=${deviceReceived?.event?.risk_score}`);
  check('phone has quick_actions', deviceReceived?.device_overrides?.phone?.quick_actions?.length > 0,
    `actions=${deviceReceived?.device_overrides?.phone?.quick_actions}`);

  // 4. Send approval from device back to Core
  const approvalReply = {
    direction: 'client_to_server',
    session_id: SESSION,
    task_id: TASK,
    action: { type: 'approve', device_type: DEVICE, timestamp: Date.now() }
  };
  ws.send(JSON.stringify(approvalReply));

  // 5. Send task_completed
  deviceReceived = null;
  await new Promise(r => setTimeout(r, 300));
  const resp3 = await postEvent({
    id: 'evt-3', task_id: TASK, session_id: SESSION,
    event_type: 'task_completed', title: 'Task Done', body: 'Migration applied',
    severity: 'info', risk_score: 0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  });
  await new Promise(r => setTimeout(r, 500));
  check('received task_completed', deviceReceived?.event?.event_type === 'task_completed');

  // Summary
  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test error:', err.message);
  process.exit(1);
});
