package approval

import (
	"testing"
	"time"
)

func TestCreateUsesDefaultCoreTimeout(t *testing.T) {
	t.Setenv("AGENTBRIDGE_CORE_TIMEOUT", "")
	m := NewManager()
	before := time.Now()

	a := m.Create("task-1", "session-1", "event-1", 0.7)

	wantMin := before.Add(120 * time.Second)
	wantMax := time.Now().Add(120*time.Second + time.Second)
	if a.TimeoutAt.Before(wantMin) || a.TimeoutAt.After(wantMax) {
		t.Fatalf("TimeoutAt = %v, want approximately now+120s [%v, %v]", a.TimeoutAt, wantMin, wantMax)
	}
}

func TestCreateUsesConfiguredCoreTimeoutMillis(t *testing.T) {
	t.Setenv("AGENTBRIDGE_CORE_TIMEOUT", "2500")
	m := NewManager()
	before := time.Now()

	a := m.Create("task-1", "session-1", "event-1", 0.7)

	wantMin := before.Add(2500 * time.Millisecond)
	wantMax := time.Now().Add(2500*time.Millisecond + time.Second)
	if a.TimeoutAt.Before(wantMin) || a.TimeoutAt.After(wantMax) {
		t.Fatalf("TimeoutAt = %v, want approximately now+2500ms [%v, %v]", a.TimeoutAt, wantMin, wantMax)
	}
}

func TestExpireMarksAndReturnsExpiredApprovals(t *testing.T) {
	m := NewManager()
	expired := m.Create("task-expired", "session-1", "event-1", 0.8)
	active := m.Create("task-active", "session-1", "event-2", 0.8)
	expired.TimeoutAt = time.Now().Add(-time.Second)
	active.TimeoutAt = time.Now().Add(time.Minute)

	got := m.Expire()

	if len(got) != 1 {
		t.Fatalf("Expire returned %d approvals, want 1", len(got))
	}
	if got[0] != expired {
		t.Fatalf("Expire returned approval %q, want %q", got[0].ID, expired.ID)
	}
	if expired.Status != StatusExpired {
		t.Fatalf("expired approval status = %s, want %s", expired.Status, StatusExpired)
	}
	if active.Status != StatusPending {
		t.Fatalf("active approval status = %s, want %s", active.Status, StatusPending)
	}
}

func TestResolveAlreadyTerminalApprovalReturnsErrAlreadyResolved(t *testing.T) {
	m := NewManager()
	a := m.Create("task-1", "session-1", "event-1", 0.8)
	if _, err := m.Resolve(a.ID, true); err != nil {
		t.Fatalf("first Resolve returned error: %v", err)
	}

	if _, err := m.Resolve(a.ID, false); err != ErrAlreadyResolved {
		t.Fatalf("second Resolve error = %v, want %v", err, ErrAlreadyResolved)
	}
}
