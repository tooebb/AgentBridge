package statemachine

import (
	"fmt"
	"sync"

	"agentbridge/internal/domain"
)

// Machine manages task state transitions.
type Machine struct {
	mu         sync.RWMutex
	taskStates map[string]domain.TaskState // taskID -> state
	sessions   map[string]domain.TaskState // sessionID -> latest task state
}

var validTransitions = map[domain.TaskState]map[domain.EventType]domain.TaskState{
	domain.TaskStateIdle: {
		domain.EventTaskStarted: domain.TaskStateStarting,
	},
	domain.TaskStateStarting: {
		domain.EventTaskRunning: domain.TaskStateRunning,
		domain.EventTaskFailed:  domain.TaskStateFailed,
	},
	domain.TaskStateRunning: {
		domain.EventTaskRunning:   domain.TaskStateRunning,
		domain.EventTaskBlocked:   domain.TaskStateBlocked,
		domain.EventNeedsApproval: domain.TaskStateAwaitingApproval,
		domain.EventTaskFailed:    domain.TaskStateFailed,
		domain.EventTaskCompleted: domain.TaskStateCompleted,
	},
	domain.TaskStateBlocked: {
		domain.EventTaskRunning:   domain.TaskStateRunning,
		domain.EventTaskFailed:    domain.TaskStateFailed,
		domain.EventTaskCompleted: domain.TaskStateCompleted,
	},
	domain.TaskStateAwaitingApproval: {
		domain.EventTaskRunning:   domain.TaskStateRunning,
		domain.EventTaskBlocked:   domain.TaskStateBlocked,
		domain.EventTaskFailed:    domain.TaskStateFailed,
		domain.EventTaskCompleted: domain.TaskStateCompleted,
	},
	domain.TaskStatePaused: {
		domain.EventTaskRunning: domain.TaskStateRunning,
		domain.EventTaskFailed:  domain.TaskStateFailed,
	},
}

// New creates a new state machine.
func New() *Machine {
	return &Machine{
		taskStates: make(map[string]domain.TaskState),
		sessions:   make(map[string]domain.TaskState),
	}
}

// Current returns the current state of a task.
func (m *Machine) Current(taskID string) domain.TaskState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if state, ok := m.taskStates[taskID]; ok {
		return state
	}
	return domain.TaskStateIdle
}

// Transition attempts to move a task from its current state to a new state
// based on the event type. Returns the new state or an error if the transition
// is invalid.
func (m *Machine) Transition(taskID, sessionID string, event domain.EventType) (domain.TaskState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current, ok := m.taskStates[taskID]
	if !ok {
		current = domain.TaskStateIdle
	}

	transitions, ok := validTransitions[current]
	if !ok {
		return current, fmt.Errorf("no transitions defined from state %q", current)
	}

	next, ok := transitions[event]
	if !ok {
		return current, fmt.Errorf("invalid transition: %q + %q (current state: %q)", current, event, current)
	}

	m.taskStates[taskID] = next
	m.sessions[sessionID] = next
	return next, nil
}

// ForceSet allows explicitly setting a task state (for admin/debug use).
func (m *Machine) ForceSet(taskID, sessionID string, state domain.TaskState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.taskStates[taskID] = state
	m.sessions[sessionID] = state
}

// SessionState returns the latest task state for a session.
func (m *Machine) SessionState(sessionID string) domain.TaskState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if state, ok := m.sessions[sessionID]; ok {
		return state
	}
	return domain.TaskStateIdle
}
