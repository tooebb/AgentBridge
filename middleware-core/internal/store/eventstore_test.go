package store

import (
	"path/filepath"
	"testing"
	"time"

	"agentbridge/internal/domain"
)

func testDeviceMessage(id, sessionID, taskID string) *domain.DeviceMessage {
	return &domain.DeviceMessage{
		Direction: "server_to_client",
		MessageID: id,
		SessionID: sessionID,
		Timestamp: time.Now().UnixMilli(),
		Event: &domain.UnifiedMessage{
			ID:        id,
			TaskID:    taskID,
			SessionID: sessionID,
			EventType: domain.EventTaskRunning,
			Title:     "Task update",
			Severity:  domain.SeverityInfo,
			Timestamp: time.Now(),
		},
		Overrides: map[domain.DeviceType]*domain.DeviceOutput{
			domain.DevicePhone: {RenderHint: "card", CardTitle: "Task update"},
		},
	}
}

func TestEventStoreAppendAssignsSeqAndReplay(t *testing.T) {
	es := NewEventStore(10)

	msg1 := testDeviceMessage("m1", "s1", "t1")
	seq1, err := es.Append("s1", msg1)
	if err != nil {
		t.Fatalf("Append msg1: %v", err)
	}
	if seq1 != 1 || msg1.Seq != 1 {
		t.Fatalf("first seq = %d msg.Seq = %d, want 1", seq1, msg1.Seq)
	}

	msg2 := testDeviceMessage("m2", "s1", "t2")
	seq2, err := es.Append("s1", msg2)
	if err != nil {
		t.Fatalf("Append msg2: %v", err)
	}
	if seq2 != 2 || msg2.Seq != 2 {
		t.Fatalf("second seq = %d msg.Seq = %d, want 2", seq2, msg2.Seq)
	}

	replay, err := es.ReplaySince("s1", 1)
	if err != nil {
		t.Fatalf("ReplaySince: %v", err)
	}
	if len(replay) != 1 {
		t.Fatalf("ReplaySince returned %d messages, want 1", len(replay))
	}
	if replay[0].Seq != 2 || !replay[0].IsReplay {
		t.Fatalf("replay seq=%d is_replay=%v, want seq=2 is_replay=true", replay[0].Seq, replay[0].IsReplay)
	}
	if msg2.IsReplay {
		t.Fatal("ReplaySince should not mutate the stored live message")
	}
}

func TestSQLiteEventStorePersistsSeqReplayAndAck(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "events.db")

	es, err := NewSQLiteEventStore(dbPath, 10)
	if err != nil {
		t.Fatalf("NewSQLiteEventStore: %v", err)
	}
	if _, err := es.Append("s1", testDeviceMessage("m1", "s1", "t1")); err != nil {
		t.Fatalf("Append msg1: %v", err)
	}
	if _, err := es.Append("s1", testDeviceMessage("m2", "s1", "t2")); err != nil {
		t.Fatalf("Append msg2: %v", err)
	}
	if err := es.UpdateDeviceAck("s1", domain.DeviceGlass, 1); err != nil {
		t.Fatalf("UpdateDeviceAck: %v", err)
	}
	if err := es.Close(); err != nil {
		t.Fatalf("Close first store: %v", err)
	}

	reopened, err := NewSQLiteEventStore(dbPath, 10)
	if err != nil {
		t.Fatalf("reopen NewSQLiteEventStore: %v", err)
	}
	defer reopened.Close()

	ack, err := reopened.DeviceAck("s1", domain.DeviceGlass)
	if err != nil {
		t.Fatalf("DeviceAck: %v", err)
	}
	if ack != 1 {
		t.Fatalf("DeviceAck = %d, want 1", ack)
	}

	msg3 := testDeviceMessage("m3", "s1", "t3")
	seq3, err := reopened.Append("s1", msg3)
	if err != nil {
		t.Fatalf("Append msg3 after reopen: %v", err)
	}
	if seq3 != 3 {
		t.Fatalf("seq after reopen = %d, want 3", seq3)
	}

	replay, err := reopened.ReplaySince("s1", 1)
	if err != nil {
		t.Fatalf("ReplaySince after reopen: %v", err)
	}
	if len(replay) != 2 {
		t.Fatalf("ReplaySince returned %d messages, want 2", len(replay))
	}
	if replay[0].Seq != 2 || replay[1].Seq != 3 {
		t.Fatalf("replay seqs = [%d %d], want [2 3]", replay[0].Seq, replay[1].Seq)
	}
	for _, msg := range replay {
		if !msg.IsReplay {
			t.Fatalf("replay message seq=%d missing is_replay", msg.Seq)
		}
	}
}
