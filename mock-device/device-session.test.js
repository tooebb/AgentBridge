const assert = require('assert');
const { DeviceSession } = require('./device-session');

function testReplayUrlAndAck() {
  const session = new DeviceSession({
    server: 'http://127.0.0.1:18080',
    sessionId: 's1',
    deviceType: 'ar_glasses',
  });

  assert.equal(session.wsUrl(), 'ws://127.0.0.1:18080/ws/s1?device_type=ar_glasses');
  session.ingest({ seq: 7, is_replay: true, event: { task_id: 'task-7' } });
  assert.equal(session.lastAckedSeq, 7);
  assert.equal(session.lastTaskId, 'task-7');
  assert.equal(session.wsUrl(), 'ws://127.0.0.1:18080/ws/s1?device_type=ar_glasses&last_acked_seq=7');
}

function testDedupeAndStats() {
  const session = new DeviceSession({
    server: 'http://localhost:8080',
    sessionId: 's2',
    deviceType: 'phone',
  });

  assert.deepEqual(session.ingest({ seq: 1, event: { task_id: 'task-1' } }).accepted, true);
  assert.deepEqual(session.ingest({ seq: 1, event: { task_id: 'task-1' } }).duplicate, true);
  assert.equal(session.lastAckedSeq, 1);
  assert.equal(session.status().liveCount, 1);
  assert.equal(session.status().duplicateCount, 1);
}

function testActionIncludesAckAndText() {
  const session = new DeviceSession({
    server: 'http://localhost:8080',
    sessionId: 's3',
    deviceType: 'ar_glasses',
  });
  session.ingest({ seq: 11, event: { task_id: 'task-11' } });

  const action = session.actionMessage('task-11', 'continue', 'voice note');
  assert.equal(action.last_acked_seq, 11);
  assert.equal(action.action.device_type, 'ar_glasses');
  assert.equal(action.action.text, 'voice note');
}

testReplayUrlAndAck();
testDedupeAndStats();
testActionIncludesAckAndText();

console.log('device-session tests passed');
