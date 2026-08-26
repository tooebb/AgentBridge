package ws

import (
	"testing"
	"time"

	"agentbridge/internal/domain"
)

func TestRegisterReplacingDeviceClosesOldChannel(t *testing.T) {
	hub := NewHub()
	oldCh, err := hub.Register("session-1", "", domain.DeviceGlasses)
	if err != nil {
		t.Fatalf("Register old: %v", err)
	}

	newCh, err := hub.Register("session-1", "", domain.DeviceGlasses)
	if err != nil {
		t.Fatalf("Register new: %v", err)
	}
	if oldCh == newCh {
		t.Fatal("expected replacement to return a new channel")
	}

	select {
	case _, ok := <-oldCh:
		if ok {
			t.Fatal("expected old channel to be closed")
		}
	case <-time.After(time.Second):
		t.Fatal("old channel was not closed")
	}
}

func TestUnregisterOldChannelDoesNotRemoveReplacement(t *testing.T) {
	hub := NewHub()
	oldCh, err := hub.Register("session-1", "", domain.DeviceGlasses)
	if err != nil {
		t.Fatalf("Register old: %v", err)
	}
	newCh, err := hub.Register("session-1", "", domain.DeviceGlasses)
	if err != nil {
		t.Fatalf("Register new: %v", err)
	}

	hub.Unregister("session-1", domain.DeviceGlasses, oldCh)
	err = hub.SendToDevice("session-1", domain.DeviceGlasses, &domain.DeviceMessage{
		ID:        "msg-1",
		SessionID: "session-1",
		EventType: "task_running",
	})
	if err != nil {
		t.Fatalf("SendToDevice after stale unregister: %v", err)
	}

	select {
	case <-newCh:
	case <-time.After(time.Second):
		t.Fatal("replacement channel did not receive message")
	}
}

func TestUnregisterOnlyAffectsMatchingSession(t *testing.T) {
	hub := NewHub()
	ch1, err := hub.Register("session-1", "", domain.DeviceGlasses)
	if err != nil {
		t.Fatalf("Register session-1: %v", err)
	}
	ch2, err := hub.Register("session-2", "", domain.DeviceGlasses)
	if err != nil {
		t.Fatalf("Register session-2: %v", err)
	}

	hub.Unregister("session-1", domain.DeviceGlasses, ch1)
	if err := hub.SendToDevice("session-2", domain.DeviceGlasses, &domain.DeviceMessage{
		ID:        "msg-2",
		SessionID: "session-2",
		EventType: "task_running",
	}); err != nil {
		t.Fatalf("SendToDevice session-2: %v", err)
	}

	select {
	case <-ch2:
	case <-time.After(time.Second):
		t.Fatal("session-2 channel did not receive message")
	}
}
