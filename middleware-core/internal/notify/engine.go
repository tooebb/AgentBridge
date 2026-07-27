package notify

import (
	"sync"
	"time"

	"agentbridge/internal/domain"
)

// Mode controls how notifications are delivered.
type Mode string

const (
	ModeInstant    Mode = "instant"
	ModeAggregated Mode = "aggregated"
	ModeQuiet      Mode = "quiet"
)

// Policy defines notification behavior for a device.
type Policy struct {
	Mode         Mode
	AggInterval  time.Duration
	MinSeverity  domain.Severity
	AllowActions bool
	CoolDown     time.Duration
}

// DefaultPolicies returns sensible defaults per device type.
func DefaultPolicies() map[domain.DeviceType]Policy {
	return map[domain.DeviceType]Policy{
		domain.DevicePhone:        {Mode: ModeInstant, MinSeverity: domain.SeverityInfo, AllowActions: true},
		domain.DeviceWatch:        {Mode: ModeAggregated, AggInterval: 60 * time.Second, MinSeverity: domain.SeverityWarning},
		domain.DeviceGlass:        {Mode: ModeInstant, MinSeverity: domain.SeverityInfo, AllowActions: true, CoolDown: 10 * time.Second},
		domain.DeviceEarbuds:      {Mode: ModeInstant, MinSeverity: domain.SeverityWarning, AllowActions: false},
		domain.DeviceAgentAdapter: {Mode: ModeQuiet},
	}
}

// Engine enforces notification policies per device.
type Engine struct {
	mu         sync.RWMutex
	policies   map[domain.DeviceType]Policy
	lastSent   map[string]time.Time // key: deviceType:sessionID:taskID
	aggregator map[string][]*domain.DeviceMessage
}

// NewEngine creates a notification engine with the given policies.
func NewEngine(policies map[domain.DeviceType]Policy) *Engine {
	return &Engine{
		policies:   policies,
		lastSent:   make(map[string]time.Time),
		aggregator: make(map[string][]*domain.DeviceMessage),
	}
}

// ShouldSend decides whether to send a message to a device based on policy.
func (e *Engine) ShouldSend(deviceType domain.DeviceType, sessionID, taskID string, msg *domain.UnifiedMessage) bool {
	e.mu.RLock()
	defer e.mu.RUnlock()

	policy, ok := e.policies[deviceType]
	if !ok {
		return true // unknown device: allow
	}

	if policy.Mode == ModeQuiet {
		return false
	}

	// Never block terminal events or user-action-required events.
	if msg.EventType == domain.EventTaskCompleted ||
		msg.EventType == domain.EventTaskFailed ||
		msg.EventType == domain.EventNeedsApproval ||
		msg.EventType == domain.EventTaskBlocked {
		return true
	}

	// Filter by severity.
	if severityRank(msg.Severity) < severityRank(policy.MinSeverity) {
		return false
	}

	// Check cooldown.
	if policy.CoolDown > 0 {
		key := string(deviceType) + ":" + sessionID + ":" + taskID
		if last, ok := e.lastSent[key]; ok {
			if time.Since(last) < policy.CoolDown {
				return false
			}
		}
	}

	return true
}

// MarkSent records that a message was sent to a device.
func (e *Engine) MarkSent(deviceType domain.DeviceType, sessionID, taskID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	key := string(deviceType) + ":" + sessionID + ":" + taskID
	e.lastSent[key] = time.Now()
}

func severityRank(s domain.Severity) int {
	switch s {
	case domain.SeverityCritical:
		return 3
	case domain.SeverityWarning:
		return 2
	case domain.SeverityInfo:
		return 1
	default:
		return 0
	}
}
