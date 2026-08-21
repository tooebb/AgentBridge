#!/usr/bin/env node
// Temporary E2E helper: connect to Core as ar_glasses and inject user_message turns.
// Usage: node inject-user-message.js "text1" ["text2" ...]
const WebSocket = require('ws');

const SERVER = process.env.SERVER || 'http://127.0.0.1:8088';
const SESSION = process.env.SESSION || 'default';
const DEV_TYPE = 'ar_glasses';

const texts = process.argv.slice(2).filter(Boolean);
if (texts.length === 0) {
  console.error('usage: node inject-user-message.js "text1" ["text2" ...]');
  process.exit(1);
}

const wsUrl = `${SERVER.replace(/^http/, 'ws')}/ws/${SESSION}?device_type=${DEV_TYPE}`;
console.log(`[inject] connecting ${wsUrl}`);
const ws = new WebSocket(wsUrl);

let acked = 0;
let idx = 0;
let done = false;

function sendNext() {
  if (done || idx >= texts.length) {
    console.log('[inject] all turns sent, waiting for trailing events...');
    setTimeout(() => process.exit(0), 3000);
    return;
  }
  const text = texts[idx++];
  const msg = {
    direction: 'client_to_server',
    session_id: SESSION,
    task_id: 'task-e2e',
    last_acked_seq: acked,
    action: { type: 'user_message', device_type: DEV_TYPE, timestamp: Date.now(), text },
  };
  console.log(`\n>>> [inject] SEND user_message (turn ${idx}): ${text}`);
  ws.send(JSON.stringify(msg));
}

ws.on('open', () => {
  console.log('[inject] connected as ar_glasses');
  sendNext();
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (msg.seq) acked = msg.seq;
    const ev = msg.event;
    if (!ev) return;
    const body = String(ev.body ?? '').replace(/\s+/g, ' ').slice(0, 200);
    console.log(`[event] ${ev.event_type} | task=${ev.task_id} | ${body}`);
    if (ev.event_type === 'task_completed' || ev.event_type === 'task_failed') {
      sendNext();
    }
  } catch {}
});

ws.on('close', () => { console.log('[inject] ws closed'); if (!done) process.exit(0); });
ws.on('error', (e) => { console.error('[inject] ws error:', e.message); process.exit(1); });

// hard stop
setTimeout(() => { console.log('[inject] timeout, exiting'); process.exit(0); }, 120000);
