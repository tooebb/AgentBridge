package store

import (
	"sync"

	"agentbridge/internal/domain"
)

// EventStore keeps a sliding window of recent DeviceMessages per session.
type EventStore struct {
	mu        sync.RWMutex
	maxEvents int
	events    map[string][]*domain.DeviceMessage // sessionID → ordered events
}

// NewEventStore creates a store with max events per session.
func NewEventStore(maxEvents int) *EventStore {
	return &EventStore{
		maxEvents: maxEvents,
		events:    make(map[string][]*domain.DeviceMessage),
	}
}

// Append adds an event to the session's ring buffer.
func (es *EventStore) Append(sessionID string, msg *domain.DeviceMessage) {
	es.mu.Lock()
	defer es.mu.Unlock()

	buf := es.events[sessionID]
	buf = append(buf, msg)
	if len(buf) > es.maxEvents {
		buf = buf[len(buf)-es.maxEvents:]
	}
	es.events[sessionID] = buf
}

// Recent returns the most recent events for a session (newest last).
func (es *EventStore) Recent(sessionID string) []*domain.DeviceMessage {
	es.mu.RLock()
	defer es.mu.RUnlock()

	buf := es.events[sessionID]
	out := make([]*domain.DeviceMessage, len(buf))
	copy(out, buf)
	return out
}

// Sessions returns all known session IDs.
func (es *EventStore) Sessions() []string {
	es.mu.RLock()
	defer es.mu.RUnlock()

	ids := make([]string, 0, len(es.events))
	for id := range es.events {
		ids = append(ids, id)
	}
	return ids
}
