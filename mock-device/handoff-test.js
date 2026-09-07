#!/usr/bin/env node
// Temporary handoff (线B) E2E probe: one ar_glasses connection that
// injects a user_message, auto-approves needs_approval, and logs every
// LIVE event with millisecond timestamps for delay diagnosis.
// Replay messages (is_replay) are skipped to avoid the event-store flood.
const WebSocket = require('ws');

const SERVER = process.env.SERVER || 'http://localhost:8088';
const SESSION = process.env.SESSION || 'default';
const TEXT = process.argv[2] || 'Create a file named handoff-test.txt in the current directory with the content "hello handoff test"';

const wsUrl = `${SERVER.replace(/^http/, 'ws')}/ws/${SESSION}?device_type=ar_glasses`;
const t0 = Date.now();

function ts() {
  return `${new Date().toISOString()} (+${Date.now() - t0}ms)`;
}

const ws = new WebSocket(wsUrl);
let acked = 0;
let sent = false;
let replaySkipped = 0;
const approved = new Set();
let terminalSeen = false;

ws.on('open', () => {
  console.log(`[probe] ${ts()} CONNECTED ${wsUrl}`);
  // Send shortly after connect. This works both on a warm Core (after the
  // replay drain begins) and on a freshly restarted Core with an empty event
  // store (where no replay messages ever arrive).
  setTimeout(() => {
    if (sent) return;
    sent = true;
    console.log(`[probe] ${ts()} SEND user_message: ${TEXT}`);
    ws.send(JSON.stringify({
      direction: 'client_to_server',
      session_id: SESSION,
      task_id: 'default',
      last_acked_seq: acked,
      action: { type: 'user_message', device_type: 'ar_glasses', timestamp: Date.now(), text: TEXT },
    }));
  }, 200);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.seq) acked = msg.seq;

    if (msg.is_replay) {
      replaySkipped++;
      // Send the user_message only after the replay drain has begun (first live-ish moment).
      if (!sent && replaySkipped > 3) {
        sent = true;
        console.log(`[probe] ${ts()} (skipped ${replaySkipped} replay) SEND user_message: ${TEXT}`);
        ws.send(JSON.stringify({
          direction: 'client_to_server',
          session_id: SESSION,
          task_id: 'default',
          last_acked_seq: acked,
          action: { type: 'user_message', device_type: 'ar_glasses', timestamp: Date.now(), text: TEXT },
        }));
      }
      return;
    }

    const ev = msg.event;
    if (!ev) return;
    const body = String(ev.body ?? '').replace(/\s+/g, ' ').slice(0, 160);
    console.log(`[probe] ${ts()} LIVE ${ev.event_type} task=${ev.task_id} risk=${ev.risk_score ?? 'n/a'} body=${body}`);

    if (ev.event_type === 'needs_approval' && !approved.has(ev.task_id)) {
      approved.add(ev.task_id);
      setTimeout(() => {
        console.log(`[probe] ${ts()} AUTO-APPROVE task=${ev.task_id}`);
        ws.send(JSON.stringify({
          direction: 'client_to_server',
          session_id: SESSION,
          task_id: ev.task_id,
          last_acked_seq: acked,
          action: { type: 'approve', device_type: 'ar_glasses', timestamp: Date.now() },
        }));
      }, 300);
    }

    if (!terminalSeen && (ev.event_type === 'task_completed' || ev.event_type === 'task_failed')) {
      // Only stop on a LIVE terminal that is NOT the approval-terminal (body starts with 审批/已).
      const bodyStr = String(ev.body ?? '');
      if (!/^(审批通过|已批准|已拒绝|已超时)/.test(bodyStr)) {
        terminalSeen = true;
        console.log(`[probe] ${ts()} LIVE TERMINAL (real result), exiting in 3s`);
        setTimeout(() => process.exit(0), 3000);
      }
    }
  } catch {}
});

ws.on('close', () => console.log(`[probe] ${ts()} WS CLOSED`));
ws.on('error', (e) => console.error(`[probe] ${ts()} WS ERROR: ${e.message}`));

setTimeout(() => { console.log(`[probe] ${ts()} HARD TIMEOUT, exiting`); process.exit(0); }, 90000);
