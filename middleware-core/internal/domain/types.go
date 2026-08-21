package domain

import (
	"encoding/json"
	"time"
)

// EventType represents the 6 agent event types + 2 internal management events.
type EventType string

const (
	EventTaskStarted   EventType = "task_started"
	EventTaskRunning   EventType = "task_running"
	EventTaskBlocked   EventType = "task_blocked"
	EventNeedsApproval EventType = "needs_approval"
	EventTaskFailed    EventType = "task_failed"
	EventTaskCompleted EventType = "task_completed"
	EventHeartbeat     EventType = "heartbeat"
	EventUserAction    EventType = "user_action"
)

// TaskState represents the lifecycle state of a task.
type TaskState string

const (
	TaskStateIdle             TaskState = "idle"
	TaskStateStarting         TaskState = "starting"
	TaskStateRunning          TaskState = "running"
	TaskStateBlocked          TaskState = "blocked"
	TaskStateAwaitingApproval TaskState = "awaiting_approval"
	TaskStateFailed           TaskState = "failed"
	TaskStateCompleted        TaskState = "completed"
	TaskStatePaused           TaskState = "paused"
	TaskStateFailedTimeout    TaskState = "failed_timeout"
	TaskStateExpired          TaskState = "expired"
)

// Severity indicates the urgency level of an event.
type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityCritical Severity = "critical"
)

// DeviceType enumerates supported target devices.
type DeviceType string

const (
	DevicePhone        DeviceType = "phone"
	DeviceWatch        DeviceType = "smartwatch"
	DeviceGlass        DeviceType = "ar_glasses"
	DeviceEarbuds      DeviceType = "earbuds"
	DeviceAgentAdapter DeviceType = "agent_adapter"
)

// ActionType enumerates user actions that can be performed on a device.
type ActionType string

const (
	ActionContinue    ActionType = "continue"
	ActionPause       ActionType = "pause"
	ActionApprove     ActionType = "approve"
	ActionReject      ActionType = "reject"
	ActionViewDetails ActionType = "view_details"
	ActionUserMessage ActionType = "user_message"
)

// AvailableAction describes a single action the user can take.
type AvailableAction struct {
	ActionType           ActionType `json:"action_type"`
	Label                string     `json:"label"`
	ConfirmationRequired bool       `json:"confirmation_required"`
}

// RawEvidence holds a link to the original agent output for deep inspection.
type RawEvidence struct {
	LogURL     string `json:"log_url,omitempty"`
	CodeChange string `json:"code_change,omitempty"`
	FilePath   string `json:"file_path,omitempty"`
}

// UnifiedMessage is the canonical internal representation of an agent event.
type UnifiedMessage struct {
	ID               string            `json:"id"`
	TaskID           string            `json:"task_id"`
	SessionID        string            `json:"session_id"`
	EventType        EventType         `json:"event_type"`
	Title            string            `json:"title"`
	Body             string            `json:"body"`
	Details          string            `json:"details,omitempty"`
	Severity         Severity          `json:"severity"`
	RiskScore        float64           `json:"risk_score"`
	RiskBlocked      bool              `json:"risk_blocked"`
	AvailableActions []AvailableAction `json:"available_actions"`
	Timestamp        time.Time         `json:"timestamp"`
	AgentID          string            `json:"agent_id"`
	RawEvidence      *RawEvidence      `json:"raw_evidence,omitempty"`
	Metadata         map[string]any    `json:"metadata,omitempty"`
	Action           *ClientAction     `json:"action,omitempty"`
}

// DeviceMessage is the final per-device output ready for delivery.
type DeviceMessage struct {
	Direction string                       `json:"direction"`
	MessageID string                       `json:"message_id"`
	SessionID string                       `json:"session_id"`
	Seq       int64                        `json:"seq,omitempty"`
	IsReplay  bool                         `json:"is_replay,omitempty"`
	Timestamp int64                        `json:"timestamp"`
	Event     *UnifiedMessage              `json:"event"`
	Overrides map[DeviceType]*DeviceOutput `json:"device_overrides"`
}

// DeviceOutput is the device-specific rendering of an event.
type DeviceOutput struct {
	TTSText      string   `json:"tts_text,omitempty"`
	CardTitle    string   `json:"card_title,omitempty"`
	CardBody     string   `json:"card_body,omitempty"`
	CardDetails  string   `json:"card_details,omitempty"`
	QuickActions []string `json:"quick_actions,omitempty"`
	VibePattern  string   `json:"vibe_pattern,omitempty"`
	RenderHint   string   `json:"render_hint"`
}

// ClientMessage is an incoming action from a device back to the middleware.
type ClientMessage struct {
	Direction    string       `json:"direction"`
	SessionID    string       `json:"session_id"`
	TaskID       string       `json:"task_id"`
	LastAckedSeq int64        `json:"last_acked_seq,omitempty"`
	Action       ClientAction `json:"action"`
}

// ClientAction is the user action payload from a device.
type ClientAction struct {
	Type       ActionType `json:"type"`
	DeviceType DeviceType `json:"device_type"`
	Timestamp  int64      `json:"timestamp"`
	Text       string     `json:"text,omitempty"`
}

// Session holds the runtime state of one agent session.
type Session struct {
	ID           string                     `json:"id"`
	UserID       string                     `json:"user_id"`
	AgentType    string                     `json:"agent_type"`
	CurrentState TaskState                  `json:"current_state"`
	Devices      map[DeviceType]*DeviceConn `json:"devices"`
	CreatedAt    time.Time                  `json:"created_at"`
	UpdatedAt    time.Time                  `json:"updated_at"`
}

// DeviceConn tracks a connected device within a session.
type DeviceConn struct {
	DeviceType DeviceType `json:"device_type"`
	Connected  bool       `json:"connected"`
	LastSeen   time.Time  `json:"last_seen"`
}

// MarshalJSON helper for wire protocol.
func (u *UnifiedMessage) Marshal() ([]byte, error) {
	return json.Marshal(u)
}
