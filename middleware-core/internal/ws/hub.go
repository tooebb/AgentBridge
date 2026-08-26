package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"agentbridge/internal/domain"
)

// Hub manages active WebSocket sessions and routes messages.
type Hub struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	dashboards []chan []byte // subscribers that receive all events
}

// Session groups the connections for one agent session.
type Session struct {
	ID      string
	UserID  string
	Devices map[domain.DeviceType]chan []byte
	Created time.Time
}

// NewHub creates a new Hub.
func NewHub() *Hub {
	return &Hub{
		sessions: make(map[string]*Session),
	}
}

// Register adds a new session or a new device to an existing session.
func (h *Hub) Register(sessionID, userID string, deviceType domain.DeviceType) (chan []byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		s = &Session{
			ID:      sessionID,
			UserID:  userID,
			Devices: make(map[domain.DeviceType]chan []byte),
			Created: time.Now(),
		}
		h.sessions[sessionID] = s
	}

	if old, ok := s.Devices[deviceType]; ok {
		close(old)
		log.Printf("hub: replacing existing device %s in session %s", deviceType, sessionID)
	}

	// Buffered channel to avoid blocking on slow consumers.
	ch := make(chan []byte, 256)
	s.Devices[deviceType] = ch
	return ch, nil
}

// Unregister removes a device from a session.
func (h *Hub) Unregister(sessionID string, deviceType domain.DeviceType, ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		return
	}
	if cur, ok2 := s.Devices[deviceType]; ok2 && cur == ch {
		close(cur)
		delete(s.Devices, deviceType)
	}
	if len(s.Devices) == 0 {
		delete(h.sessions, sessionID)
	}
}

// SendToDevice delivers a DeviceMessage to a specific device in a session.
func (h *Hub) SendToDevice(sessionID string, deviceType domain.DeviceType, msg *domain.DeviceMessage) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}

	ch, ok := s.Devices[deviceType]
	if !ok {
		return ErrDeviceNotFound
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	select {
	case ch <- data:
		return nil
	default:
		log.Printf("hub: channel full for session %s device %s, dropping message", sessionID, deviceType)
		return nil
	}
}

// BroadcastToSession sends a message to all connected devices in a session.
func (h *Hub) BroadcastToSession(sessionID string, msg *domain.DeviceMessage) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("hub: failed to marshal broadcast msg: %v", err)
		return
	}

	for deviceType, ch := range s.Devices {
		select {
		case ch <- data:
		default:
			log.Printf("hub: channel full for session %s device %s, dropping broadcast", sessionID, deviceType)
		}
	}
}

// ConnectedDevices returns the device types currently connected for a session.
func (h *Hub) ConnectedDevices(sessionID string) []domain.DeviceType {
	h.mu.RLock()
	defer h.mu.RUnlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		return nil
	}

	devices := make([]domain.DeviceType, 0, len(s.Devices))
	for dt := range s.Devices {
		devices = append(devices, dt)
	}
	return devices
}

// SubscribeDashboard registers a dashboard subscriber that receives all events.
func (h *Hub) SubscribeDashboard() chan []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch := make(chan []byte, 128)
	h.dashboards = append(h.dashboards, ch)
	return ch
}

// UnsubscribeDashboard removes a dashboard subscriber.
func (h *Hub) UnsubscribeDashboard(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, c := range h.dashboards {
		if c == ch {
			h.dashboards = append(h.dashboards[:i], h.dashboards[i+1:]...)
			close(c)
			return
		}
	}
}

// BroadcastToDashboard sends a message to all dashboard subscribers.
func (h *Hub) BroadcastToDashboard(msg *domain.DeviceMessage) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	for _, ch := range h.dashboards {
		select {
		case ch <- data:
		default:
			// skip slow subscribers
		}
	}
}

// GetSessions returns a snapshot of all active sessions.
func (h *Hub) GetSessions() []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()

	out := make([]*Session, 0, len(h.sessions))
	for _, s := range h.sessions {
		out = append(out, s)
	}
	return out
}

var (
	ErrSessionNotFound = &HubError{"session not found"}
	ErrDeviceNotFound  = &HubError{"device not found in session"}
)

type HubError struct{ Msg string }

func (e *HubError) Error() string { return e.Msg }
