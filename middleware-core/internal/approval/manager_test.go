package approval

import (
	"fmt"
	"sync"
	"sync/atomic"
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

func TestConcurrentResolveSameApproval(t *testing.T) {
	m := NewManager()
	a := m.Create("task-1", "session-1", "event-1", 0.8)

	const workers = 64
	var wg sync.WaitGroup
	var successCount int64
	var alreadyResolvedCount int64
	var unexpectedErrCount int64

	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()

			if _, err := m.Resolve(a.ID, true); err != nil {
				if err == ErrAlreadyResolved {
					atomic.AddInt64(&alreadyResolvedCount, 1)
					return
				}
				atomic.AddInt64(&unexpectedErrCount, 1)
				return
			}
			atomic.AddInt64(&successCount, 1)
		}()
	}
	wg.Wait()

	if successCount != 1 {
		t.Fatalf("successful Resolve calls = %d, want 1", successCount)
	}
	if alreadyResolvedCount != workers-1 {
		t.Fatalf("ErrAlreadyResolved calls = %d, want %d", alreadyResolvedCount, workers-1)
	}
	if unexpectedErrCount != 0 {
		t.Fatalf("unexpected Resolve errors = %d, want 0", unexpectedErrCount)
	}

	got, err := m.Get(a.ID)
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if got.Status != StatusApproved {
		t.Fatalf("approval status = %s, want %s", got.Status, StatusApproved)
	}
}

func TestConcurrentCreateSameTaskReturnsSameApproval(t *testing.T) {
	m := NewManager()

	const workers = 64
	var wg sync.WaitGroup
	approvals := make([]*Approval, workers)

	wg.Add(workers)
	for i := 0; i < workers; i++ {
		i := i
		go func() {
			defer wg.Done()

			approvals[i] = m.Create("task-1", "session-1", fmt.Sprintf("event-%d", i), 0.8)
		}()
	}
	wg.Wait()

	first := approvals[0]
	if first == nil {
		t.Fatal("first approval is nil")
	}
	for i, got := range approvals {
		if got != first {
			t.Fatalf("approval[%d] = %p, want %p", i, got, first)
		}
	}

	got, err := m.GetByTask("task-1")
	if err != nil {
		t.Fatalf("GetByTask returned error: %v", err)
	}
	if got != first {
		t.Fatalf("GetByTask returned %p, want %p", got, first)
	}
}

func TestConcurrentCreateResolveDeleteDifferentTasks(t *testing.T) {
	m := NewManager()

	const workers = 32
	const iterations = 50
	var wg sync.WaitGroup
	var errorCount int64

	wg.Add(workers)
	for worker := 0; worker < workers; worker++ {
		worker := worker
		go func() {
			defer wg.Done()

			for i := 0; i < iterations; i++ {
				taskID := fmt.Sprintf("task-%d-%d", worker, i)
				a := m.Create(taskID, "session-1", fmt.Sprintf("event-%d-%d", worker, i), 0.8)
				if _, err := m.Resolve(a.ID, true); err != nil {
					atomic.AddInt64(&errorCount, 1)
				}
				m.Delete(a.ID)
				if _, err := m.Get(a.ID); err != ErrNotFound {
					atomic.AddInt64(&errorCount, 1)
				}
				if _, err := m.GetByTask(taskID); err != ErrNotFound {
					atomic.AddInt64(&errorCount, 1)
				}
			}
		}()
	}
	wg.Wait()

	if errorCount != 0 {
		t.Fatalf("concurrent create/resolve/delete errors = %d, want 0", errorCount)
	}
}
