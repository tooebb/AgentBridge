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
	switch msg.EventType {
	case domain.EventTaskStarted:
		return d.glassTaskStarted(msg)
	case domain.EventTaskRunning:
		return d.glassTaskRunning(msg)
	case domain.EventTaskBlocked:
		return d.glassTaskBlocked(msg)
	case domain.EventNeedsApproval:
		return d.glassNeedsApproval(msg)
	case domain.EventTaskFailed:
		return d.glassTaskFailed(msg)
	case domain.EventTaskCompleted:
		return d.glassTaskCompleted(msg)
	default:
		return d.glassDefault(msg)
	}
}

func (d *Dispatcher) glassTaskStarted(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	return &domain.DeviceOutput{
		TTSText:      "",
		CardTitle:    "◤ " + truncate(msg.Title, 50),
		CardBody:     glassSummary(msg.Body, 150),
		CardDetails:  msg.Body,
		QuickActions: nil,
		RenderHint:   "status_card",
	}
}

func (d *Dispatcher) glassTaskRunning(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	return &domain.DeviceOutput{
		TTSText:      "",
		CardTitle:    "◉ " + truncate(msg.Title, 50),
		CardBody:     glassSummary(msg.Body, 150),
		CardDetails:  msg.Body,
		QuickActions: nil,
		RenderHint:   "status_card",
	}
}

func (d *Dispatcher) glassTaskBlocked(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	actions := watchActions(msg.AvailableActions, 2)
	if len(actions) == 0 {
		actions = []string{"continue", "view_details"}
	}
	return &domain.DeviceOutput{
		TTSText:      fmt.Sprintf("任务阻塞: %s", msg.Title),
		CardTitle:    "⚠ 阻塞: " + truncate(msg.Title, 45),
		CardBody:     glassSummary(msg.Body, 180),
		CardDetails:  msg.Body,
		QuickActions: actions,
		RenderHint:   "actionable_card",
	}
}

func (d *Dispatcher) glassNeedsApproval(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	tts := fmt.Sprintf("需要审批: %s", msg.Title)
	if msg.RiskScore >= 0.7 {
		tts = fmt.Sprintf("高风险操作: %s", msg.Title)
	}

	actions := watchActions(msg.AvailableActions, 2)
	if len(actions) == 0 {
		actions = []string{"approve", "reject"}
	}

	riskLine := ""
	if msg.RiskScore > 0 {
		riskLine = fmt.Sprintf("风险: %.0f%% | ", msg.RiskScore*100)
	}
	details := msg.Details
	if details == "" {
		details = msg.Body
	}

	return &domain.DeviceOutput{
		TTSText:      tts,
		CardTitle:    "⛔ 审批: " + truncate(msg.Title, 42),
		CardBody:     riskLine + glassSummary(msg.Body, 140),
		CardDetails:  details,
		QuickActions: actions,
		RenderHint:   "actionable_card",
	}
}

func (d *Dispatcher) glassTaskFailed(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	return &domain.DeviceOutput{
		TTSText:      fmt.Sprintf("任务失败: %s", msg.Title),
		CardTitle:    "✕ 失败: " + truncate(msg.Title, 48),
		CardBody:     glassSummary(msg.Body, 200),
		CardDetails:  msg.Body,
		QuickActions: []string{"view_details"},
		RenderHint:   "alert_card",
	}
}

func (d *Dispatcher) glassTaskCompleted(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	return &domain.DeviceOutput{
		TTSText:      fmt.Sprintf("完成: %s", msg.Title),
		CardTitle:    "✓ " + truncate(msg.Title, 52),
		CardBody:     glassSummary(msg.Body, 120),
		CardDetails:  msg.Body,
		QuickActions: nil,
		RenderHint:   "status_card",
	}
}

func (d *Dispatcher) glassDefault(msg *domain.UnifiedMessage) *domain.DeviceOutput {
	tts := ""
	if msg.Severity == domain.SeverityCritical || msg.Severity == domain.SeverityWarning {
		tts = severityPrefix(msg.Severity) + msg.Title
	}
	actions := watchActions(msg.AvailableActions, 1)
	return &domain.DeviceOutput{
		TTSText:      tts,
		CardTitle:    truncate(msg.Title, 52),
		CardBody:     truncate(msg.Body, 150),
		CardDetails:  msg.Body,
		QuickActions: actions,
		RenderHint:   "card",
	}
}

// glassSummary extracts a compact summary from the event body,
// preferring the first non-empty line and trimming to max chars.
func glassSummary(body string, max int) string {
	lines := strings.Split(body, "\n")
	var first string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			first = trimmed
			break
		}
	}
	if first == "" {
		first = body
	}
	return truncate(first, max)
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
