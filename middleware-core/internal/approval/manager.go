package approval

import (
	"sync"
	"time"

	"agentbridge/internal/domain"
)

// Status represents the lifecycle status of an approval.
type Status string

const (
	StatusPending  Status = "pending"
	StatusApproved Status = "approved"
	StatusRejected Status = "rejected"
	StatusExpired  Status = "expired"
)

// Approval tracks a single approval request through its lifecycle.
type Approval struct {
	ID          string
	TaskID      string
	SessionID   string
	EventID     string
	RiskScore   float64
	Status      Status
	CreatedAt   time.Time
	TimeoutAt   time.Time
	RetryCount  int
	MaxRetries  int
	RetryDelays []time.Duration
	History     []Attempt
}

// Attempt records a single delivery attempt of an approval to a device.
type Attempt struct {
	DeviceType domain.DeviceType
	SentAt     time.Time
	Result     string // "delivered" | "timeout" | "user_response"
}

// Manager handles approval lifecycle: creation, timeout, retry, resolution.
type Manager struct {
	mu       sync.RWMutex
	active   map[string]*Approval // approvalID -> Approval
	byTask   map[string]string    // taskID -> approvalID
}

// NewManager creates a new Manager.
func NewManager() *Manager {
	return &Manager{
		active: make(map[string]*Approval),
		byTask: make(map[string]string),
	}
}

// Create registers a new pending approval with a 5-minute timeout.
func (m *Manager) Create(taskID, sessionID, eventID string, riskScore float64) *Approval {
	m.mu.Lock()
	defer m.mu.Unlock()

	// De-duplicate: replace existing pending approval for the same task.
	if existingID, ok := m.byTask[taskID]; ok {
		if existing, ok2 := m.active[existingID]; ok2 && existing.Status == StatusPending {
			return existing
		}
	}

	a := &Approval{
		ID:          generateID(),
		TaskID:      taskID,
		SessionID:   sessionID,
		EventID:     eventID,
		RiskScore:   riskScore,
		Status:      StatusPending,
		CreatedAt:   time.Now(),
		TimeoutAt:   time.Now().Add(5 * time.Minute),
		MaxRetries:  3,
		RetryDelays: []time.Duration{1 * time.Minute, 3 * time.Minute, 5 * time.Minute},
	}
	m.active[a.ID] = a
	m.byTask[taskID] = a.ID
	return a
}

// RecordAttempt logs a delivery attempt.
func (m *Manager) RecordAttempt(approvalID string, deviceType domain.DeviceType, result string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.active[approvalID]
	if !ok {
		return
	}
	a.History = append(a.History, Attempt{
		DeviceType: deviceType,
		SentAt:     time.Now(),
		Result:     result,
	})
}

// Resolve transitions an approval to its final status.
func (m *Manager) Resolve(approvalID string, approved bool) (*Approval, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.active[approvalID]
	if !ok {
		return nil, ErrNotFound
	}
	if a.Status != StatusPending {
		return nil, ErrAlreadyResolved
	}

	if approved {
		a.Status = StatusApproved
	} else {
		a.Status = StatusRejected
	}
	return a, nil
}

// NeedsRetry checks if the approval should be retried after a failed delivery.
func (m *Manager) NeedsRetry(approvalID string) (bool, time.Duration) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	a, ok := m.active[approvalID]
	if !ok || a.Status != StatusPending {
		return false, 0
	}
	if a.RetryCount >= a.MaxRetries {
		return false, 0
	}
	delay := a.RetryDelays[a.RetryCount]
	a.RetryCount++
	return true, delay
}

// Expire marks expired approvals and returns their IDs.
func (m *Manager) Expire() []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	var expired []string
	for id, a := range m.active {
		if a.Status == StatusPending && now.After(a.TimeoutAt) {
			a.Status = StatusExpired
			expired = append(expired, id)
		}
	}
	return expired
}

// Get returns an approval by ID.
func (m *Manager) Get(approvalID string) (*Approval, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	a, ok := m.active[approvalID]
	if !ok {
		return nil, ErrNotFound
	}
	return a, nil
}

// GetByTask returns the active approval for a task, if any.
func (m *Manager) GetByTask(taskID string) (*Approval, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	approvalID, ok := m.byTask[taskID]
	if !ok {
		return nil, ErrNotFound
	}
	a, ok := m.active[approvalID]
	if !ok {
		return nil, ErrNotFound
	}
	return a, nil
}

var (
	ErrNotFound        = &AppError{"approval not found"}
	ErrAlreadyResolved = &AppError{"approval already resolved"}
)

type AppError struct{ Msg string }

func (e *AppError) Error() string { return e.Msg }

func generateID() string {
	return time.Now().Format("20060102150405") + "-" + randomHex(8)
}

func randomHex(n int) string {
	const hex = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = hex[time.Now().UnixNano()%int64(len(hex))]
	}
	return string(b)
}
