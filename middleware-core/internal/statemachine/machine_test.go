package statemachine

import (
	"testing"

	"agentbridge/internal/domain"
)

func TestTransitionRestartsCompletedTaskID(t *testing.T) {
	machine := New()
	taskID := "default"
	sessionID := "session-1"

	mustTransition(t, machine, taskID, sessionID, domain.EventTaskStarted, domain.TaskStateStarting)
	mustTransition(t, machine, taskID, sessionID, domain.EventTaskRunning, domain.TaskStateRunning)
	mustTransition(t, machine, taskID, sessionID, domain.EventTaskCompleted, domain.TaskStateCompleted)

	mustTransition(t, machine, taskID, sessionID, domain.EventTaskStarted, domain.TaskStateStarting)
	mustTransition(t, machine, taskID, sessionID, domain.EventTaskRunning, domain.TaskStateRunning)
	mustTransition(t, machine, taskID, sessionID, domain.EventNeedsApproval, domain.TaskStateAwaitingApproval)

	if current := machine.Current(taskID); current != domain.TaskStateAwaitingApproval {
		t.Fatalf("expected current state %q, got %q", domain.TaskStateAwaitingApproval, current)
	}
	if sessionState := machine.SessionState(sessionID); sessionState != domain.TaskStateAwaitingApproval {
		t.Fatalf("expected session state %q, got %q", domain.TaskStateAwaitingApproval, sessionState)
	}
}

func TestTransitionRestartsFailedTaskID(t *testing.T) {
	machine := New()
	taskID := "default"
	sessionID := "session-1"

	mustTransition(t, machine, taskID, sessionID, domain.EventTaskStarted, domain.TaskStateStarting)
	mustTransition(t, machine, taskID, sessionID, domain.EventTaskFailed, domain.TaskStateFailed)

	mustTransition(t, machine, taskID, sessionID, domain.EventTaskStarted, domain.TaskStateStarting)
}

func mustTransition(t *testing.T, machine *Machine, taskID, sessionID string, event domain.EventType, want domain.TaskState) {
	t.Helper()

	got, err := machine.Transition(taskID, sessionID, event)
	if err != nil {
		t.Fatalf("transition %q failed: %v", event, err)
	}
	if got != want {
		t.Fatalf("transition %q: expected %q, got %q", event, want, got)
	}
}
