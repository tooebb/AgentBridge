#!/usr/bin/env node
const WebSocket = require('ws');

// CLI args
const args = process.argv.slice(2);
function flag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : fallback;
}
function hasFlag(name) { return args.includes(`--${name}`); }

if (hasFlag('help') || hasFlag('h')) {
  console.log(`
  Usage: node demo.js [options]

  Options:
    --server <url>       Core server URL (default: http://localhost:8080)
    --device-type <type> phone | smartwatch | ar_glasses | earbuds (default: phone)
    --help               Show this help

  Runs a 6-step live demo showing the full agent-to-device pipeline.
`);
  process.exit(0);
}

const SERVER = flag('server', process.env.SERVER || 'http://localhost:8080');
const DEVICE = flag('device-type', 'phone');
const SESSION = 'demo-' + Date.now();
const TASK = 'task-demo';

const C = {
  reset:   '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
function p(color, text) { return `${C[color]}${text}${C.reset}`; }
const wait = ms => new Promise(r => setTimeout(r, ms));

async function postEvent(body) {
  const data = JSON.stringify(body);
  const resp = await fetch(`${SERVER}/api/v1/events`, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: data
  });
  return resp.json();
}

function deviceName(type) {
  const names = { phone: 'Phone', smartwatch: 'Watch', ar_glasses: 'Glass', earbuds: 'Earbuds' };
  return names[type] || type;
}

async function main() {
  console.log(p('bright', '\n  AgentBridge Mock Device — Live Demo\n'));

  console.log(p('dim', `  Device: ${deviceName(DEVICE)} | Session: ${SESSION}\n`));

  // ── Step 1: Connect ──────────────────────────────────────────
  console.log(p('cyan', '  [1/6] Connecting to Core...'));
  const ws = new WebSocket(`${SERVER.replace('http','ws')}/ws/${SESSION}?device_type=${DEVICE}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  console.log(p('green', '        Connected.\n'));
  await wait(800);

  // Set up message handler
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const ev = msg.event;
    if (!ev) return;
    const ov = msg.device_overrides?.[DEVICE] || {};

    const icons = {
      task_started: '[START]', task_running: '[*]', task_blocked: '[!]',
      needs_approval: '[?]', task_failed: '[X]', task_completed: '[OK]'
    };
    const icon = icons[ev.event_type] || '[.]';
    const sevColor = ev.severity === 'critical' ? 'red' : ev.severity === 'warning' ? 'yellow' : 'green';

    console.log('');
    console.log(`  ${p('bright', icon)} ${p(sevColor, ev.event_type)}  ${p('dim', '|')}  ${ev.title}`);
    console.log(`  ${p('dim', ev.body)}`);
    console.log(`  Risk: ${ev.risk_score.toFixed(2)}${ev.risk_blocked ? ' ' + p('red', '[BLOCKED]') : ''}`);

    if (Object.keys(ov).length > 0) {
      console.log(`  ${p('dim', `[${DEVICE}]`)} hint=${ov.render_hint || '-'} | actions=[${(ov.quick_actions||[]).join(',')}]`);
    }

    if (ev.available_actions?.length) {
      console.log(`  ${p('cyan', 'Available:')} ${ev.available_actions.map(a=>a.action_type).join(', ')}`);
    }
  });

  // ── Step 2: Task Started ─────────────────────────────────────
  console.log(p('yellow', '  [2/6] Agent starts a task...'));
  await postEvent({
    id: 'evt-1', task_id: TASK, session_id: SESSION,
    event_type: 'task_started',
    title: 'Refactor authentication middleware',
    body: 'Replace session-based auth with JWT tokens across 12 route handlers',
    severity: 'info', risk_score: 0.0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  });
  await wait(1200);

  // ── Step 3: Task Running ─────────────────────────────────────
  console.log(p('yellow', '\n  [3/6] Agent working...'));
  await postEvent({
    id: 'evt-2', task_id: TASK, session_id: SESSION,
    event_type: 'task_running',
    title: 'Modifying auth.ts',
    body: 'Reading 12 files, generating JWT middleware, updating imports...',
    severity: 'info', risk_score: 0.0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  });
  await wait(1500);

  // ── Step 4: Needs Approval ───────────────────────────────────
  console.log(p('yellow', '\n  [4/6] Agent needs your approval!'));
  await postEvent({
    id: 'evt-3', task_id: TASK, session_id: SESSION,
    event_type: 'needs_approval',
    title: 'Approve database migration',
    body: 'Agent wants to run: prisma migrate deploy on production database',
    severity: 'warning', risk_score: 0.7, risk_blocked: false,
    available_actions: [
      {action_type:'approve',label:'Approve',confirmation_required:false},
      {action_type:'reject',label:'Reject',confirmation_required:false},
      {action_type:'view_details',label:'View Details',confirmation_required:false}
    ],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  });
  await wait(2000);

  // ── Step 5: Approve from device ──────────────────────────────
  console.log(p('magenta', '\n  [5/6] Sending APPROVE from device...'));
  ws.send(JSON.stringify({
    direction: 'client_to_server',
    session_id: SESSION, task_id: TASK,
    action: { type: 'approve', device_type: DEVICE, timestamp: Date.now() }
  }));
  console.log(p('green', '        Approval sent back to agent.\n'));
  await wait(1500);

  // ── Step 6: Task Completed ───────────────────────────────────
  console.log(p('yellow', '  [6/6] Agent finishes...'));
  await postEvent({
    id: 'evt-4', task_id: TASK, session_id: SESSION,
    event_type: 'task_completed',
    title: 'Auth middleware refactored successfully',
    body: '12 files changed, 3 new files created, 0 test failures',
    severity: 'info', risk_score: 0.0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  });
  await wait(1200);

  // ── Summary ─────────────────────────────────────────────────
  console.log(p('bright', '\n  ═══════════════════════════════════════════'));
  console.log(p('green', '  Demo complete.'));
  console.log(p('dim', `  Session: ${SESSION}`));
  console.log(p('dim', `  Events: task_started -> task_running -> needs_approval -> approve -> task_completed`));
  console.log(p('dim', '  All messages were delivered via WebSocket to this mock device.'));
  console.log(p('bright', '  ═══════════════════════════════════════════\n'));

  console.log(p('cyan', '  Try it yourself:'));
  console.log(p('dim', '    cd mock-device && npm run phone'));
  console.log(p('dim', '    # then type: send needs_approval "Test" "Test body"'));
  console.log(p('dim', '    # then type: approve'));

  ws.close();
  process.exit(0);
}

main().catch(err => { console.error(p('red', 'Error: ' + err.message)); process.exit(1); });
