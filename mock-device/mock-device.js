#!/usr/bin/env node

const WebSocket = require('ws');
const readline = require('readline');
const { DeviceSession } = require('./device-session');

// ── CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : fallback;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

if (hasFlag('help') || hasFlag('h')) {
  console.log(`
  Usage: node mock-device.js [options]

  Options:
    --server <url>       Core server URL (default: http://localhost:8080)
    --session <id>       Session ID (default: auto-generated mock-<ts>)
    --device-type <type> One of: phone, smartwatch, ar_glasses, earbuds (default: phone)
    --simulate-all       Connect as all 4 device types simultaneously
    --auto               Auto-approve needs_approval events
    --help               Show this help

  Interactive commands after connection:
    a[pprove] [task_id]  Approve a pending approval
    r[eject]  [task_id]  Reject
    c[ontinue] [task_id] Continue blocked/paused task
    p[ause]   [task_id]  Pause running task
    v[iew]    [task_id]  Request detail view
    send [type] [title] [body]  Submit test event via REST
    reconnect             Reconnect with last_acked_seq
    status                Show device ack/replay state
    q[uit]               Exit
`);
  process.exit(0);
}

const SERVER    = flag('server', process.env.SERVER || 'http://localhost:8080');
const SESSION   = flag('session', `mock-${Date.now()}`);
const DEV_TYPE  = flag('device-type', 'phone');
const SIM_ALL   = hasFlag('simulate-all');
const AUTO      = hasFlag('auto');

const VALID_TYPES = ['phone', 'smartwatch', 'ar_glasses', 'earbuds'];

// ── Helpers ───────────────────────────────────────────────────────────
const colors = {
  reset:   '\x1b[0m',
  bright:  '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};

function c(color, text) { return `${colors[color] || ''}${text}${colors.reset}`; }

function ts() {
  return new Date().toISOString().split('T')[1].slice(0, 12);
}

function log(prefix, color, ...msg) {
  console.log(`${c('dim', `[${ts()}]`)} ${c(color, `[${prefix}]`)}`, ...msg);
}

const eventIcons = {
  task_started:      '[START]',
  task_running:      '[*]',
  task_blocked:      '[!]',
  needs_approval:    '[?]',
  task_failed:       '[X]',
  task_completed:    '[OK]',
  heartbeat:         '[.]',
  user_action:       '[<]',
};

// ── API helpers ───────────────────────────────────────────────────────
async function sendEvent(event) {
  const body = JSON.stringify(event);
  const resp = await fetch(`${SERVER}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST /api/v1/events → ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── Single device client ──────────────────────────────────────────────
function connectDevice(sessionId, deviceType, label) {
  const state = new DeviceSession({ server: SERVER, sessionId, deviceType });
  return openDeviceConnection(state, label);
}

function openDeviceConnection(state, label) {
  const wsUrl = state.wsUrl();
  log(label, 'cyan', `connecting to ${wsUrl}`);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    state.markConnected();
    log(label, 'green', 'connected');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const result = state.ingest(msg);
      if (!result.accepted) {
        log(label, 'dim', `ignored ${result.reason}`);
        return;
      }
      displayMessage(msg, state.deviceType, label);

      if (AUTO && msg.event?.event_type === 'needs_approval' && !msg.event?.risk_blocked) {
        const taskId = msg.event.task_id;
        setTimeout(() => {
          log(label, 'yellow', `auto-approving task ${taskId}`);
          sendAction(ws, state, taskId, 'approve');
        }, 500);
      }
    } catch {
      // non-JSON, ignore
    }
  });

  ws.on('close', () => {
    state.markDisconnected();
    log(label, 'red', 'disconnected');
  });

  ws.on('error', (err) => {
    log(label, 'red', `error: ${err.message}`);
  });

  return { ws, state, lastTaskId: () => state.lastTaskId };
}

function reconnectDevice(conn, label) {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.close();
  }
  const reopened = openDeviceConnection(conn.state, label);
  conn.ws = reopened.ws;
  return conn;
}

function sendAction(ws, state, taskId, actionType, text) {
  const msg = state.actionMessage(taskId, actionType, text);
  ws.send(JSON.stringify(msg));
  log(state.deviceType, 'magenta', `sent: ${actionType} (task: ${taskId}, ack: ${state.lastAckedSeq})`);
}

function displayMessage(msg, deviceType, label) {
  const ev = msg.event;
  if (!ev) return;

  const icon = eventIcons[ev.event_type] || '?';
  const sevColor = ev.severity === 'critical' ? 'red'
    : ev.severity === 'warning' ? 'yellow' : 'green';

  console.log('');
  log(label, 'bright', `${icon} ${c(sevColor, ev.event_type)} ${c('dim', `| ${ev.title}`)}`);
  console.log(`  ${c('dim', ev.body)}`);
  console.log(`  ${c('dim', `risk: ${ev.risk_score.toFixed(2)}`)}${ev.risk_blocked ? ' ' + c('red', '[BLOCKED-FROM-MOBILE]') : ''}`);

  // device-specific overrides
  const ov = msg.device_overrides?.[deviceType];
  if (ov) {
    const parts = [];
    if (ov.render_hint) parts.push(`hint=${ov.render_hint}`);
    if (ov.tts_text)     parts.push(`tts="${ov.tts_text.slice(0, 60)}..."`);
    if (ov.quick_actions?.length) parts.push(`actions=[${ov.quick_actions.join(', ')}]`);
    if (ov.vibe_pattern) parts.push(`vibe=${ov.vibe_pattern}`);
    console.log(`  ${c('dim', `[${deviceType} overrides]`)} ${parts.join(' | ')}`);
  }

  // available actions
  if (ev.available_actions?.length) {
    const acts = ev.available_actions
      .map(a => `${a.action_type}${a.confirmation_required ? ' (confirm)' : ''}`)
      .join(', ');
    console.log(`  ${c('cyan', `actions available: ${acts}`)}`);
  }

  const replay = msg.is_replay ? ' | replay' : '';
  const seq = msg.seq ? ` | seq: ${msg.seq}${replay}` : '';
  console.log(`  ${c('dim', `task_id: ${ev.task_id} | session: ${ev.session_id}${seq}`)}`);
}

// ── Interactive REPL ──────────────────────────────────────────────────
function startRepl(connections) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c('dim', 'device> '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1];
    const arg2 = parts[2];

    // pick which connection to use
    const deviceArg = SIM_ALL ? parts.find(p => VALID_TYPES.includes(p)) : null;
    const conn = deviceArg ? connections.find(c => c.type === deviceArg) : connections[0];
    if (!conn && ['a', 'approve', 'r', 'reject', 'p', 'pause', 'c', 'continue', 'v', 'view'].includes(cmd)) {
      console.log(c('red', 'no connection available'));
      rl.prompt();
      return;
    }

    const { ws, lastTaskId, type, state } = conn;
    const taskId = arg1 && arg1 !== deviceArg ? arg1 : lastTaskId();
    const trailingText = parts.slice(2).filter(p => p !== deviceArg).join(' ');

    switch (cmd) {
      case 'a':
      case 'approve':
        if (!taskId) { console.log(c('red', 'no task_id')); break; }
        sendAction(ws, state, taskId, 'approve', trailingText);
        break;

      case 'r':
      case 'reject':
        if (!taskId) { console.log(c('red', 'no task_id')); break; }
        sendAction(ws, state, taskId, 'reject', trailingText);
        break;

      case 'p':
      case 'pause':
        if (!taskId) { console.log(c('red', 'no task_id')); break; }
        sendAction(ws, state, taskId, 'pause', trailingText);
        break;

      case 'c':
      case 'continue':
        if (!taskId) { console.log(c('red', 'no task_id')); break; }
        sendAction(ws, state, taskId, 'continue', trailingText);
        break;

      case 'v':
      case 'view':
        if (!taskId) { console.log(c('red', 'no task_id')); break; }
        sendAction(ws, state, taskId, 'view_details', trailingText);
        break;

      case 'send': {
        // send <event_type> [title] [body]
        const evType = arg1 || 'needs_approval';
        const title = arg2 || 'Test event from mock device';
        const body = parts.slice(3).join(' ') || `Mock ${evType} event`;
        try {
          const resp = await sendEvent({
            id: `evt-${Date.now()}`,
            task_id: `task-${Date.now()}`,
            session_id: session,
            event_type: evType,
            title,
            body,
            severity: 'warning',
            risk_score: 0.3,
            risk_blocked: false,
            available_actions: [
              { action_type: 'approve', label: 'Approve', confirmation_required: false },
              { action_type: 'reject', label: 'Reject', confirmation_required: false },
            ],
            timestamp: new Date().toISOString(),
            agent_id: 'mock-device',
          });
          console.log(c('green', `event sent: ${resp.event?.id || resp.id || 'ok'}`));
        } catch (err) {
          console.log(c('red', err.message));
        }
        break;
      }

      case 'reconnect':
        reconnectDevice(conn, type);
        break;

      case 'status':
        for (const item of connections) {
          console.log(c('cyan', item.type), JSON.stringify(item.state.status()));
        }
        break;

      case 'h':
      case 'help':
        console.log(`
  ${c('bright', 'Commands:')}
    a[pprove] [task_id] [device] [text] — approve a pending approval
    r[eject]  [task_id] [device] [text] — reject a pending approval
    c[ontinue] [task_id] [device] [text] — continue a blocked/paused task
    p[ause]   [task_id] [device] [text] — pause a running task
    v[iew]    [task_id] [device] [text] — request detail view
    send [event_type] [title] [body] — submit test event via REST
    reconnect                 — reconnect with last_acked_seq
    status                    — show ack/replay/device state
    help                       — this help
    q[uit]                     — exit

  ${c('dim', 'If task_id is omitted, uses the last received task_id.')}
  ${c('dim', 'Device clients dedupe seq, preserve last_acked_seq, and request replay on reconnect.')}
`);
        break;

      case 'q':
      case 'quit':
        console.log(c('dim', 'bye.'));
        connections.forEach(c => c.ws.close());
        rl.close();
        process.exit(0);
        return;

      default:
        console.log(c('red', `unknown command: ${cmd}  (type 'help')`));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    connections.forEach(c => c.ws.close());
  });
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  console.log(c('bright', '\n  AgentBridge Mock Device Client\n'));
  console.log(c('dim', `  Server:  ${SERVER}`));
  console.log(c('dim', `  Session: ${SESSION}`));
  console.log(c('dim', `  Auto:    ${AUTO ? 'yes' : 'no'}`));
  console.log('');

  const connections = [];

  if (SIM_ALL) {
    for (const t of VALID_TYPES) {
      connections.push({
        ...connectDevice(SESSION, t, t),
        type: t,
        session: SESSION,
      });
      // small stagger to avoid thundering herd
      await new Promise(r => setTimeout(r, 200));
    }
    // log aggregated info
    log('all', 'cyan', `${VALID_TYPES.length} devices connecting...`);
  } else {
    if (!VALID_TYPES.includes(DEV_TYPE)) {
      console.log(c('red', `invalid device type: ${DEV_TYPE}. valid: ${VALID_TYPES.join(', ')}`));
      process.exit(1);
    }
    connections.push({
      ...connectDevice(SESSION, DEV_TYPE, DEV_TYPE),
      type: DEV_TYPE,
      session: SESSION,
    });
  }

  // give connections a moment to establish
  await new Promise(r => setTimeout(r, 800));

  startRepl(connections);
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
