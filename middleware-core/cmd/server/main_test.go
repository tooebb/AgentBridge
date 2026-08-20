package main

import (
	"testing"

	"agentbridge/internal/domain"
)

func TestBuildApprovalTerminal(t *testing.T) {
	tests := []struct {
		name      string
		approved  bool
		wantTitle string
		wantBody  string
		wantLevel domain.Severity
	}{
		{
			name:      "approved",
			approved:  true,
			wantTitle: "已批准",
			wantBody:  "审批通过，已放行工具执行",
			wantLevel: domain.SeverityInfo,
		},
		{
			name:      "rejected",
			approved:  false,
			wantTitle: "已拒绝",
			wantBody:  "已拒绝该操作",
			wantLevel: domain.SeverityWarning,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildApprovalTerminal(tt.approved)
			if got.EventType != domain.EventTaskCompleted {
				t.Fatalf("EventType = %s, want %s", got.EventType, domain.EventTaskCompleted)
			}
			if got.Title != tt.wantTitle {
				t.Fatalf("Title = %q, want %q", got.Title, tt.wantTitle)
			}
			if got.Body != tt.wantBody {
				t.Fatalf("Body = %q, want %q", got.Body, tt.wantBody)
			}
			if got.Severity != tt.wantLevel {
				t.Fatalf("Severity = %s, want %s", got.Severity, tt.wantLevel)
			}
		})
	}
}
