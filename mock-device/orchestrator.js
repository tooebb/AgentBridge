#!/usr/bin/env node
const WebSocket = require('ws');

// ── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(n, d) { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; }
function has(n) { return args.includes(`--${n}`); }

if (has('help') || has('h')) {
  console.log(`
  Usage: node orchestrator.js [options]

  Options:
    --server <url>     Core server URL (default: http://localhost:8080)
    --mode auto|step   auto = timed playback | step = press Enter (default: auto)
    --speed fast|normal|slow  playback speed multiplier (default: normal)
    --scenario full|short     full = 8 steps | short = 4 steps (default: full)
    --help

  Example:
    node orchestrator.js --mode step --speed slow
`);
  process.exit(0);
}

const SERVER  = flag('server', process.env.SERVER || 'http://localhost:8080');
const MODE    = flag('mode', 'auto');
const SPEED   = flag('speed', 'normal');
const SCENARIO = flag('scenario', 'full');

const speedMultipliers = { fast: 0.4, normal: 1.0, slow: 2.5 };
const SPEED_X = speedMultipliers[SPEED] || 1.0;

function dly(ms) { return new Promise(r => setTimeout(r, ms * SPEED_X)); }

// ── Terminal helpers ────────────────────────────────────────────────────
const C = {
  R: '\x1b[0m', B: '\x1b[1m', D: '\x1b[2m',
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m',
  b: '\x1b[34m', m: '\x1b[35m', c: '\x1b[36m', w: '\x1b[37m',
};
function p(c, t) { return `${C[c]}${t}${C.R}`; }
function box(width, title, content) {
  const lines = content.split('\n');
  const top = `  ${p('D', '┌─')} ${p('B', title)} ${p('D', '─'.repeat(Math.max(0, width - title.length - 4)) + '┐')}`;
  const mid = lines.map(l => `  ${p('D', '│')} ${l}${' '.repeat(Math.max(0, width - stripAnsi(l).length - 1))}${p('D', '│')}`).join('\n');
  const bot = `  ${p('D', '└' + '─'.repeat(width - 2) + '┘')}`;
  return `${top}\n${mid}\n${bot}`;
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
async function waitEnter() {
  if (MODE !== 'step') return;
  console.log(p('c', '\n  [Press ENTER to continue]'));
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(r => rl.question('', () => { rl.close(); r(); }));
}

// ── Core API ────────────────────────────────────────────────────────────
async function postEvent(body) {
  const resp = await fetch(`${SERVER}/api/v1/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Scenario definitions ─────────────────────────────────────────────────
const SESSION = 'demo-' + Date.now();
const TASK = 'task-auth-refactor';

function makeEvt(id, type, title, body, severity, riskScore, actions) {
  return {
    id: `evt-${id}`, task_id: TASK, session_id: SESSION,
    event_type: type, title, body, severity,
    risk_score: riskScore, risk_blocked: false,
    available_actions: actions || [],
    timestamp: new Date().toISOString(), agent_id: 'claude-code'
  };
}

const SCENARIOS = {
  short: [
    { evt: makeEvt(1, 'task_started', 'Start: JWT auth refactor', 'Replace session auth with JWT across 12 route handlers', 'info', 0), wait: 2, note: 'Agent receives task, starts working. Developer walks away from PC.' },
    { evt: makeEvt(2, 'task_running', 'Reading codebase...', 'Scanning user.model.ts, auth.middleware.ts, jwt.utils.ts...', 'info', 0), wait: 2, note: 'Agent reads and analyzes existing code' },
    { evt: makeEvt(3, 'needs_approval', 'Approve: add rate limit config', 'Agent wants to add rate limiting with threshold 1000 req/min across all routes', 'warning', 0.5, [
      { action_type: 'approve', label: 'Approve', confirmation_required: false },
      { action_type: 'reject', label: 'Reject', confirmation_required: false },
      { action_type: 'view_details', label: 'View Details', confirmation_required: false }
    ]), wait: 3, note: 'Agent hits decision point. Phone buzzes, Glass shows TTS notification.', actions: { approve: true, from: 'ar_glasses' } },
    { evt: makeEvt(4, 'task_completed', 'Done: JWT auth refactored', '12 files changed, 3 new files, 0 test failures', 'info', 0), wait: 3, note: 'Task complete. Full roundtrip: Agent → Core → Device → User → Agent.' },
  ],
  full: [
    { evt: makeEvt(1, 'task_started', 'Start: Auth refactor + rate limiting', 'Replace session auth with JWT, add rate limiting middleware across 12 route handlers', 'info', 0), wait: 2, note: 'Developer starts Claude Code on PC, then walks away from desk' },
    { evt: makeEvt(2, 'task_running', 'Reading codebase...', 'Scanning user.model.ts, auth.middleware.ts, 10 route files...', 'info', 0), wait: 2, note: 'Agent reads and analyzes existing code' },
    { evt: makeEvt(3, 'task_running', 'Generating JWT middleware', 'Creating jwt.utils.ts, auth.guard.ts. Writing tests for token generation and validation.', 'info', 0), wait: 2, note: 'Agent creates new files. Status pushed to all devices.' },
    { evt: makeEvt(4, 'needs_approval', 'Approve: add rate limit config', 'Agent wants to add rate limiting with threshold 1000 req/min across all routes', 'warning', 0.5, [
      { action_type: 'approve', label: 'Approve', confirmation_required: false },
      { action_type: 'reject', label: 'Reject', confirmation_required: false },
      { action_type: 'view_details', label: 'View Details', confirmation_required: false }
    ]), wait: 3, note: 'Agent hits decision point — needs human approval. Phone and Glass both receive notification.', actions: { approve: true, from: 'ar_glasses' } },
    { evt: makeEvt(5, 'task_running', 'Rate limiting applied...', 'Added rate-limiter.ts middleware. All 12 route handlers updated with 1000 req/min cap.', 'info', 0), wait: 2, note: 'Approved from AR Glass. Agent continues. Rate limiting middleware deployed.' },
    { evt: makeEvt(6, 'task_blocked', 'Danger: rm -rf detected', 'Agent attempted: rm -rf node_modules && npm cache clean --force', 'critical', 0.9, [
      { action_type: 'approve', label: 'Approve', confirmation_required: true },
      { action_type: 'reject', label: 'Reject', confirmation_required: true }
    ]), wait: 3, note: 'High-risk operation! Risk score 0.9. All mobile devices show [BLOCKED]. Must return to PC.', actions: { reject: true } },
    { evt: makeEvt(7, 'task_running', 'Safely cleaning up...', 'Using npm ci instead. Installing dependencies cleanly.', 'info', 0), wait: 2, note: 'Agent switched to safe alternative after user rejected dangerous operation from PC.' },
    { evt: makeEvt(8, 'task_completed', 'Done: Auth refactor complete', '12 files changed, 3 new files created. All 47 tests passing. TypeScript strict mode clean.', 'info', 0), wait: 4, note: 'Task complete. Full roundtrip. Developer never had to return to PC.' },
  ],
};

// ── Device display ──────────────────────────────────────────────────────
function renderDeviceOutput(type, name, deviceMsg) {
  const ov = deviceMsg?.device_overrides?.[type] || {};
  const ev = deviceMsg?.event;
  if (!ev) return `${p('D', `  (no message)`)}`;

  const lines = [];
  const sev = ev.severity === 'critical' ? 'r' : ev.severity === 'warning' ? 'y' : 'g';

  switch (type) {
    case 'phone':
      lines.push(`  ${p(sev, ov.card_title || ev.title)}`);
      lines.push(`  ${p('D', (ov.card_body || ev.body).slice(0, 55))}`);
      if (ev.risk_blocked) {
        lines.push(`  ${p('r', '[BLOCKED-FROM-MOBILE]')} ${p('D', 'Return to PC')}`);
      } else if (ov.quick_actions?.length) {
        lines.push(`  ${ov.quick_actions.map(a => `[${a}]`).join(' ')}`);
      }
      lines.push(`  ${p('D', `hint: ${ov.render_hint || '-'}`)}`);
      break;

    case 'ar_glasses':
      if (ov.tts_text) lines.push(`  ${p('m', 'TTS:')} "${ov.tts_text.slice(0, 50)}..."`);
      lines.push(`  ${p(sev, ov.card_title || ev.title).slice(0, 40)}`);
      if (ev.risk_blocked) {
        lines.push(`  ${p('r', '[BLOCKED]')} ${p('D', 'PC only')}`);
      } else if (ov.quick_actions?.length) {
        lines.push(`  ${p('c', `[${ov.quick_actions[0] || 'approve'}]`)} ${p('D', 'tap to act')}`);
      }
      lines.push(`  ${p('D', `hint: ${ov.render_hint || '-'}`)}`);
      break;

    case 'smartwatch':
      lines.push(`  ${p(sev, (ov.card_title || ev.title).slice(0, 28))}`);
      if (ov.quick_actions?.length) {
        lines.push(`  ${p('c', `[${ov.quick_actions[0]}]`)}`);
      }
      lines.push(`  ${p('D', `vibe: ${ov.vibe_pattern || '-'} | hint: ${ov.render_hint || '-'}`)}`);
      break;

    case 'earbuds':
      if (ov.tts_text) {
        lines.push(`  ${p('y', '"' + ov.tts_text.slice(0, 55) + '..."')}`);
      }
      lines.push(`  ${p('D', `hint: ${ov.render_hint || '-'}`)}`);
      break;
  }

  return lines.join('\n');
}

// ── Device connections ──────────────────────────────────────────────────
const DEVICE_TYPES = ['phone', 'smartwatch', 'ar_glasses', 'earbuds'];
const DEVICE_NAMES = { phone: 'Phone', smartwatch: 'Watch', ar_glasses: 'AR Glass', earbuds: 'Earbuds' };

function connectDevice(type, session) {
  const wsUrl = `${SERVER.replace('http', 'ws')}/ws/${session}?device_type=${type}`;
  const ws = new WebSocket(wsUrl);
  let lastMsg = null;

  ws.on('message', (data) => {
    try { lastMsg = JSON.parse(data.toString()); } catch {}
  });

  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, lastMsg: () => lastMsg, clearMsg: () => { lastMsg = null; } }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`connect timeout: ${type}`)), 5000);
  });
}

function sendAction(ws, sessionId, taskId, deviceType, actionType) {
  ws.send(JSON.stringify({
    direction: 'client_to_server',
    session_id: sessionId, task_id: taskId,
    action: { type: actionType, device_type: deviceType, timestamp: Date.now() }
  }));
}

// ── Main display ────────────────────────────────────────────────────────
function clear() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function displayStep(step, total, scenarioStep, deviceMsgs) {
  clear();
  const ev = scenarioStep.evt;

  console.log(p('B', `\n  AgentBridge Demo Orchestrator`));
  console.log(p('D', `  ${'─'.repeat(60)}`));
  console.log(`  ${p('B', `Step ${step}/${total}`)}  ${p('y', '◆')}  ${scenarioStep.evt.title}`);
  console.log(`  ${p('D', scenarioStep.note)}`);
  console.log('');

  // Agent panel
  const sevColor = ev.severity === 'critical' ? 'r' : ev.severity === 'warning' ? 'y' : 'g';
  console.log(`  ${p('D', '┌─')} ${p('c', 'Agent (Claude Code)')} ${p('D', '──────────────────────────────┐')}`);
  console.log(`  ${p('D', '│')}  Event: ${p(sevColor, ev.event_type)}  |  Severity: ${p(sevColor, ev.severity)}  |  Risk: ${ev.risk_score.toFixed(2)}   ${p('D', '│')}`);
  console.log(`  ${p('D', '│')}  ${p('B', ev.title)}${' '.repeat(Math.max(0, 45 - stripAnsi(ev.title).length))}${p('D', '│')}`);
  console.log(`  ${p('D', '│')}  ${p('D', (ev.body || '').slice(0, 50))}${' '.repeat(Math.max(0, 45 - stripAnsi((ev.body || '').slice(0, 50)).length))}${p('D', '│')}`);
  if (ev.risk_blocked) {
    console.log(`  ${p('D', '│')}  ${p('r', '[!] HIGH RISK — Mobile actions blocked')}             ${p('D', '│')}`);
  }
  console.log(`  ${p('D', '└──────────────────────────────────────────────┘')}`);
  console.log('');

  // 4 device panels
  const panelWidth = 28;
  const panels = DEVICE_TYPES.map(type => {
    const name = DEVICE_NAMES[type];
    const render = renderDeviceOutput(type, name, deviceMsgs[type]);
    return box(panelWidth, name, render);
  });

  // Print panels side by side: phone + glass on row 1, watch + buds on row 2
  const rows = [
    [panels[0], panels[2]],  // phone, glass
    [panels[1], panels[3]],  // watch, buds
  ];

  for (const row of rows) {
    const left = row[0].split('\n');
    const right = row[1].split('\n');
    const maxH = Math.max(left.length, right.length);
    for (let i = 0; i < maxH; i++) {
      const l = left[i] || ' '.repeat(panelWidth + 4);
      const r = right[i] || '';
      console.log(`${l}  ${r}`);
    }
  }

  // Actions bar
  console.log('');
  if (ev.available_actions?.length && !ev.risk_blocked) {
    const actList = ev.available_actions.map(a => `[${a.action_type}]`).join('  ');
    console.log(`  ${p('c', 'Available actions:')} ${actList}`);
  }
  if (scenarioStep.actions) {
    const act = scenarioStep.actions;
    if (act.approve) {
      console.log(`  ${p('g', '→')} ${p('B', `Will auto-approve from ${act.from || 'phone'} in ${(scenarioStep.wait * SPEED_X).toFixed(0)}s`)}`);
    } else if (act.reject) {
      console.log(`  ${p('r', '→')} ${p('B', `Will auto-reject in ${(scenarioStep.wait * SPEED_X).toFixed(0)}s`)}`);
    }
  }
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const scenario = SCENARIOS[SCENARIO];
  if (!scenario) { console.error(`Unknown scenario: ${SCENARIO}. Use full or short.`); process.exit(1); }

  clear();
  console.log(p('B', '\n  AgentBridge Demo Orchestrator\n'));
  console.log(p('D', `  Session: ${SESSION}`));
  console.log(p('D', `  Scenario: ${SCENARIO} (${scenario.length} steps)`));
  console.log(p('D', `  Mode: ${MODE} | Speed: ${SPEED}\n`));

  // Connect all 4 devices
  console.log(p('D', '  Connecting 4 mock devices...'));
  const devices = {};
  for (const type of DEVICE_TYPES) {
    devices[type] = await connectDevice(type, SESSION);
    console.log(p('D', `    ${DEVICE_NAMES[type]}: ${p('g', 'connected')}`));
  }

  await waitEnter();

  // Run scenario
  for (let i = 0; i < scenario.length; i++) {
    const step = scenario[i];
    const deviceMsgs = {};

    // Clear previous messages and send event
    for (const type of DEVICE_TYPES) {
      devices[type].clearMsg();
    }
    const resp = await postEvent(step.evt);
    await dly(800);

    // Collect device messages
    for (const type of DEVICE_TYPES) {
      deviceMsgs[type] = devices[type].lastMsg();
    }

    // Display
    displayStep(i + 1, scenario.length, step, deviceMsgs);

    // Handle actions
    if (step.actions) {
      await dly(step.wait * 1000 * 0.4); // show the message first, then act
      const fromDevice = step.actions.from || 'phone';
      const actionType = step.actions.approve ? 'approve' : 'reject';
      console.log(p('m', `  >>> Sending ${actionType} from ${DEVICE_NAMES[fromDevice]} >>>\n`));
      sendAction(devices[fromDevice].ws, SESSION, TASK, fromDevice, actionType);
      await dly(600);
    } else {
      await dly(step.wait * 1000);
    }

    if (MODE === 'step' && i < scenario.length - 1) {
      await waitEnter();
    } else if (i < scenario.length - 1) {
      // brief gap between steps in auto mode
      await dly(500);
    }
  }

  // Closing
  clear();
  console.log(p('B', '\n  AgentBridge Demo — Complete\n'));
  console.log(p('g', '  All steps executed successfully.\n'));
  console.log(p('D', `  Session: ${SESSION}`));
  console.log(p('D', `  Events: ${scenario.map(s => s.evt.event_type).join(' → ')}`));
  console.log('');
  console.log(p('B', '  Key takeaways:'));
  console.log(p('D', '  1. Agent events classified into 6 standard types'));
  console.log(p('D', '  2. Same event rendered differently for each device (device_overrides)'));
  console.log(p('D', '  3. Risk assessment blocks dangerous operations on mobile'));
  console.log(p('D', '  4. Full roundtrip: Agent → Core → Device → User → Agent'));
  console.log('');

  // Cleanup
  for (const d of Object.values(devices)) d.ws.close();
  process.exit(0);
}

main().catch(err => {
  console.error(p('r', '\n  Fatal: ' + err.message + '\n'));
  console.error(p('D', '  Make sure the Core is running: cd middleware-core && go run cmd/server/main.go'));
  process.exit(1);
});
