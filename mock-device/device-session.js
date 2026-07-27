class DeviceSession {
  constructor({ server, sessionId, deviceType }) {
    this.server = server;
    this.sessionId = sessionId;
    this.deviceType = deviceType;
    this.lastAckedSeq = 0;
    this.lastTaskId = null;
    this.seenSeqs = new Set();
    this.seenMessageIds = new Set();
    this.replayCount = 0;
    this.liveCount = 0;
    this.duplicateCount = 0;
    this.connected = false;
  }

  wsUrl() {
    const url = `${this.server.replace(/^http/, 'ws')}/ws/${this.sessionId}`;
    const params = new URLSearchParams({
      device_type: this.deviceType,
    });
    if (this.lastAckedSeq > 0) {
      params.set('last_acked_seq', String(this.lastAckedSeq));
    }
    return `${url}?${params.toString()}`;
  }

  markConnected() {
    this.connected = true;
  }

  markDisconnected() {
    this.connected = false;
  }

  ingest(message) {
    const seq = Number(message.seq || 0);
    if (seq > 0) {
      if (this.seenSeqs.has(seq) || seq <= this.lastAckedSeq) {
        this.duplicateCount++;
        return { accepted: false, duplicate: true, reason: `duplicate seq ${seq}` };
      }
      this.seenSeqs.add(seq);
      this.lastAckedSeq = Math.max(this.lastAckedSeq, seq);
    } else if (message.message_id) {
      if (this.seenMessageIds.has(message.message_id)) {
        this.duplicateCount++;
        return { accepted: false, duplicate: true, reason: `duplicate message ${message.message_id}` };
      }
      this.seenMessageIds.add(message.message_id);
    }

    if (message.is_replay) {
      this.replayCount++;
    } else {
      this.liveCount++;
    }

    if (message.event?.task_id) {
      this.lastTaskId = message.event.task_id;
    }

    return { accepted: true, duplicate: false, seq };
  }

  actionMessage(taskId, actionType, text) {
    return {
      direction: 'client_to_server',
      session_id: this.sessionId,
      task_id: taskId,
      last_acked_seq: this.lastAckedSeq,
      action: {
        type: actionType,
        device_type: this.deviceType,
        timestamp: Date.now(),
        ...(text ? { text } : {}),
      },
    };
  }

  status() {
    return {
      deviceType: this.deviceType,
      connected: this.connected,
      lastAckedSeq: this.lastAckedSeq,
      lastTaskId: this.lastTaskId,
      liveCount: this.liveCount,
      replayCount: this.replayCount,
      duplicateCount: this.duplicateCount,
    };
  }
}

module.exports = { DeviceSession };
