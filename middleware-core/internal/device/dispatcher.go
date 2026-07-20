package device

import (
	"fmt"
	"strings"

	"agentbridge/internal/domain"
)

// Dispatcher transforms a UnifiedMessage into device-specific outputs.
type Dispatcher struct{}

// NewDispatcher creates a new Dispatcher.
func NewDispatcher() *Dispatcher {
	return &Dispatcher{}
}

// Transform generates per-device overrides for all supported device types.
func (d *Dispatcher) Transform(msg *domain.UnifiedMessage) map[domain.DeviceType]*domain.DeviceOutput {
	outputs := make(map[domain.DeviceType]*domain.DeviceOutput)
	outputs[domain.DevicePhone] = d.forPhone(msg)
	outputs[domain.DeviceWatch] = d.forWatch(msg)
	outputs[domain.DeviceGlass] = d.forGlass(msg)
	outputs[domain.DeviceEarbuds] = d.forEarbuds(msg)
	return outputs
}

func (d *Dispatcher) forPhone(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	actions := make([]string, len(msg.AvailableActions))
	for i, a := range msg.AvailableActions {
		actions[i] = string(a.ActionType)
	}
	return &domain.DeviceOutput{
		CardTitle:    msg.Title,
		CardBody:     truncate(msg.Body, 500),
		QuickActions: actions,
		RenderHint:   "rich_card",
	}
}

func (d *Dispatcher) forWatch(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	actions := watchActions(msg.AvailableActions, 2)
	body := truncate(msg.Body, 80)
	vibe := "short"
	if msg.Severity == domain.SeverityCritical {
		vibe = "long"
	}
	return &domain.DeviceOutput{
		CardTitle:    truncate(msg.Title, 40),
		CardBody:     body,
		QuickActions: actions,
		RenderHint:   "card",
		VibePattern:  vibe,
	}
}

func (d *Dispatcher) forGlass(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	tts := ttsForGlass(msg)
	actions := watchActions(msg.AvailableActions, 1)
	return &domain.DeviceOutput{
		TTSText:      tts,
		CardTitle:    truncate(msg.Title, 30),
		CardBody:     truncate(msg.Body, 100),
		QuickActions: actions,
		RenderHint:   "toast",
	}
}

func (d *Dispatcher) forEarbuds(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	tts := fmt.Sprintf("%s. %s. %s",
		severityPrefix(msg.Severity),
		msg.Title,
		actionPrompt(msg.AvailableActions),
	)
	return &domain.DeviceOutput{
		TTSText:    tts,
		RenderHint: "tts",
	}
}

func ttsForGlass(msg *domain.UnifiedMessage) string {
	prefix := severityPrefix(msg.Severity)
	return fmt.Sprintf("%s%s", prefix, msg.Title)
}

func severityPrefix(s domain.Severity) string {
	switch s {
	case domain.SeverityCritical:
		return "Critical alert: "
	case domain.SeverityWarning:
		return "Warning: "
	default:
		return ""
	}
}

func actionPrompt(actions []domain.AvailableAction) string {
	labels := make([]string, len(actions))
	for i, a := range actions {
		labels[i] = a.Label
	}
	if len(labels) == 0 {
		return "Tap to acknowledge."
	}
	return "Say " + strings.Join(labels, " or ") + "."
}

func watchActions(actions []domain.AvailableAction, max int) []string {
	if len(actions) > max {
		actions = actions[:max]
	}
	result := make([]string, len(actions))
	for i, a := range actions {
		result[i] = string(a.ActionType)
	}
	return result
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}
