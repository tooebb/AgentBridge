package device

import (
	"testing"

	"agentbridge/internal/domain"
)

func newMsg(eventType domain.EventType, title, body string, severity domain.Severity, riskScore float64, actions []domain.AvailableAction) *domain.UnifiedMessage {
	return &domain.UnifiedMessage{
		EventType:        eventType,
		Title:            title,
		Body:             body,
		Severity:         severity,
		RiskScore:        riskScore,
		AvailableActions: actions,
	}
}

func TestForGlass_RoutesToCorrectHandler(t *testing.T) {
	d := NewDispatcher()

	tests := []struct {
		name      string
		eventType domain.EventType
		wantTitle string // substring expected in CardTitle
		wantHint  string
		wantTTS   bool
	}{
		{"task_started routes to glassTaskStarted", domain.EventTaskStarted, "◤", "status_card", false},
		{"task_running routes to glassTaskRunning", domain.EventTaskRunning, "◉", "status_card", false},
		{"task_blocked routes to glassTaskBlocked", domain.EventTaskBlocked, "阻塞", "actionable_card", true},
		{"needs_approval routes to glassNeedsApproval", domain.EventNeedsApproval, "审批", "actionable_card", true},
		{"task_failed routes to glassTaskFailed", domain.EventTaskFailed, "失败", "alert_card", true},
		{"task_completed routes to glassTaskCompleted", domain.EventTaskCompleted, "✓", "status_card", true},
		{"heartbeat routes to glassDefault", domain.EventHeartbeat, "heartbeat_test", "card", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg := newMsg(tt.eventType, "heartbeat_test", "test body", domain.SeverityInfo, 0, nil)
			out := d.forGlass(msg)

			if out == nil {
				t.Fatal("expected non-nil output")
			}
			if tt.wantHint != "" && out.RenderHint != tt.wantHint {
				t.Errorf("RenderHint = %q, want %q", out.RenderHint, tt.wantHint)
			}
			if tt.wantTitle != "" && !contains(out.CardTitle, tt.wantTitle) {
				t.Errorf("CardTitle = %q, want to contain %q", out.CardTitle, tt.wantTitle)
			}
			if tt.wantTTS && out.TTSText == "" {
				t.Error("expected non-empty TTSText")
			}
		})
	}
}

func TestForGlass_TaskBlocked_FallbackActions(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventTaskBlocked, "Build Failed", "Error compiling", domain.SeverityWarning, 0, nil)
	out := d.forGlass(msg)

	if len(out.QuickActions) == 0 {
		t.Fatal("expected fallback quick actions")
	}
	if out.QuickActions[0] != "continue" || out.QuickActions[1] != "view_details" {
		t.Errorf("QuickActions = %v, want [continue view_details]", out.QuickActions)
	}
}

func TestForGlass_TaskBlocked_UsesProvidedActions(t *testing.T) {
	d := NewDispatcher()
	actions := []domain.AvailableAction{
		{ActionType: "retry", Label: "Retry"},
		{ActionType: "skip", Label: "Skip"},
	}
	msg := newMsg(domain.EventTaskBlocked, "Test", "Body", domain.SeverityInfo, 0, actions)
	out := d.forGlass(msg)

	if len(out.QuickActions) != 2 {
		t.Fatalf("got %d actions, want 2", len(out.QuickActions))
	}
	if out.QuickActions[0] != "retry" {
		t.Errorf("QuickActions[0] = %q, want retry", out.QuickActions[0])
	}
}

func TestForGlass_NeedsApproval_HighRisk(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventNeedsApproval, "Dangerous Op", "rm -rf /", domain.SeverityCritical, 0.8, nil)
	out := d.forGlass(msg)

	if !contains(out.TTSText, "高风险") {
		t.Errorf("TTSText = %q, want to contain 高风险", out.TTSText)
	}
}

func TestForGlass_NeedsApproval_NormalRisk(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventNeedsApproval, "Normal Op", "Do something", domain.SeverityWarning, 0.3, nil)
	out := d.forGlass(msg)

	if !contains(out.TTSText, "需要审批") {
		t.Errorf("TTSText = %q, want to contain 需要审批", out.TTSText)
	}
}

func TestForGlass_NeedsApproval_RiskScoreDisplay(t *testing.T) {
	d := NewDispatcher()
	actions := []domain.AvailableAction{
		{ActionType: "approve", Label: "Approve"},
	}
	msg := newMsg(domain.EventNeedsApproval, "Op", "Body", domain.SeverityWarning, 0.5, actions)
	out := d.forGlass(msg)

	if !contains(out.CardBody, "风险: 50%") {
		t.Errorf("CardBody = %q, want to contain risk percentage", out.CardBody)
	}
}

func TestForGlass_NeedsApproval_PopulatesCardDetails(t *testing.T) {
	d := NewDispatcher()
	actions := []domain.AvailableAction{
		{ActionType: "approve", Label: "Approve"},
		{ActionType: "reject", Label: "Reject"},
	}
	msg := newMsg(domain.EventNeedsApproval, "Approval required: Write", "Risk score: 0.4\nCommand: rm foo\nTool input: {...}", domain.SeverityWarning, 0.4, actions)
	msg.Details = "I will remove foo\nCommand: rm foo\nTool input: {\"command\":\"rm foo\"}"

	out := d.forGlass(msg)

	if out.CardDetails != msg.Details {
		t.Errorf("CardDetails = %q, want %q", out.CardDetails, msg.Details)
	}
	if contains(out.CardBody, "Command:") {
		t.Errorf("CardBody = %q, should stay a short summary (no Command line)", out.CardBody)
	}
}

func TestForGlass_NeedsApproval_CardDetailsFallsBackToBody(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventNeedsApproval, "Op", "Do something", domain.SeverityWarning, 0.3, nil)

	out := d.forGlass(msg)

	if out.CardDetails == "" {
		t.Error("CardDetails should fall back to Body when Details is empty")
	}
}

func TestForGlass_NeedsApproval_FallbackActions(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventNeedsApproval, "Approve", "Please approve", domain.SeverityWarning, 0, nil)
	out := d.forGlass(msg)

	if len(out.QuickActions) < 2 {
		t.Fatal("expected fallback approve/reject actions")
	}
	if out.QuickActions[0] != "approve" || out.QuickActions[1] != "reject" {
		t.Errorf("QuickActions = %v, want [approve reject]", out.QuickActions)
	}
}

func TestForGlass_TaskFailed_AlwaysHasViewDetails(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventTaskFailed, "Crash", "Something broke", domain.SeverityCritical, 0, nil)
	out := d.forGlass(msg)

	if len(out.QuickActions) == 0 || out.QuickActions[0] != "view_details" {
		t.Errorf("QuickActions = %v, want [view_details]", out.QuickActions)
	}
}

func TestForGlass_Default_CriticalGetsTTS(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventHeartbeat, "Alert", "Critical issue", domain.SeverityCritical, 0, nil)
	out := d.forGlass(msg)

	if out.TTSText == "" {
		t.Error("critical severity should produce TTS in default handler")
	}
}

func TestGlassSummary_UsesFirstNonEmptyLine(t *testing.T) {
	body := "\n\n  First meaningful line  \nSecond line\nThird"
	result := glassSummary(body, 200)
	if result != "First meaningful line" {
		t.Errorf("glassSummary = %q, want %q", result, "First meaningful line")
	}
}

func TestGlassSummary_TruncatesToMax(t *testing.T) {
	body := "This is a very long line of text that should be truncated at the specified maximum length"
	result := glassSummary(body, 20)
	if len(result) > 20 {
		t.Errorf("glassSummary len = %d, want <= 20", len(result))
	}
	if !contains(result, "...") {
		t.Errorf("truncated result should end with '...': %q", result)
	}
}

func TestGlassSummary_AllWhitespace(t *testing.T) {
	body := "   \n   \n   "
	result := glassSummary(body, 100)
	if result == "" {
		t.Error("glassSummary should return something even for all-whitespace input")
	}
}

func TestForGlass_AllSixEventTypesProduceOutput(t *testing.T) {
	d := NewDispatcher()
	types := []domain.EventType{
		domain.EventTaskStarted, domain.EventTaskRunning, domain.EventTaskBlocked,
		domain.EventNeedsApproval, domain.EventTaskFailed, domain.EventTaskCompleted,
	}

	for _, et := range types {
		t.Run(string(et), func(t *testing.T) {
			msg := newMsg(et, "Title "+string(et), "Body for "+string(et), domain.SeverityInfo, 0,
				[]domain.AvailableAction{{ActionType: "test", Label: "Test"}})
			out := d.forGlass(msg)
			if out == nil {
				t.Fatal("expected non-nil output")
			}
			if out.CardTitle == "" {
				t.Error("expected non-empty CardTitle")
			}
			if out.CardBody == "" {
				t.Error("expected non-empty CardBody")
			}
			if out.RenderHint == "" {
				t.Error("expected non-empty RenderHint")
			}
		})
	}
}

func TestTransform_AllDeviceTypes(t *testing.T) {
	d := NewDispatcher()
	msg := newMsg(domain.EventTaskRunning, "Test", "Body", domain.SeverityInfo, 0,
		[]domain.AvailableAction{{ActionType: "ok", Label: "OK"}})

	outputs := d.Transform(msg)

	expectedDevices := []domain.DeviceType{domain.DevicePhone, domain.DeviceWatch, domain.DeviceGlass, domain.DeviceEarbuds}
	for _, dt := range expectedDevices {
		if outputs[dt] == nil {
			t.Errorf("Transform should produce output for %s", dt)
		}
	}
}

func TestSeverityPrefix(t *testing.T) {
	tests := []struct {
		severity domain.Severity
		want     string
	}{
		{domain.SeverityCritical, "Critical alert: "},
		{domain.SeverityWarning, "Warning: "},
		{domain.SeverityInfo, ""},
	}
	for _, tt := range tests {
		got := severityPrefix(tt.severity)
		if got != tt.want {
			t.Errorf("severityPrefix(%q) = %q, want %q", tt.severity, got, tt.want)
		}
	}
}

func TestActionPrompt(t *testing.T) {
	tests := []struct {
		name    string
		actions []domain.AvailableAction
		want    string
	}{
		{"empty", nil, "Tap to acknowledge."},
		{"single", []domain.AvailableAction{{Label: "Approve"}}, "Say Approve."},
		{"two", []domain.AvailableAction{{Label: "Approve"}, {Label: "Reject"}}, "Say Approve or Reject."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := actionPrompt(tt.actions)
			if got != tt.want {
				t.Errorf("actionPrompt = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		name string
		s    string
		max  int
		want string
	}{
		{"short", "hello", 10, "hello"},
		{"exact", "hello", 5, "hello"},
		{"long", "hello world this is long", 10, "hello w..."},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := truncate(tt.s, tt.max)
			if got != tt.want {
				t.Errorf("truncate = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestWatchActions_Caps(t *testing.T) {
	actions := []domain.AvailableAction{
		{ActionType: "a"}, {ActionType: "b"}, {ActionType: "c"},
	}
	result := watchActions(actions, 2)
	if len(result) != 2 {
		t.Errorf("watchActions len = %d, want 2", len(result))
	}
	if result[0] != "a" || result[1] != "b" {
		t.Errorf("watchActions = %v, want [a b]", result)
	}
}

func contains(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
