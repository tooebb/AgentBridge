package risk

import (
	"testing"

	"agentbridge/internal/domain"
)

func TestEvaluatePreservesAdapterRiskScore(t *testing.T) {
	assessor := NewAssessor(DefaultRules())
	msg := &domain.UnifiedMessage{
		Title:     "Approval required: Bash",
		Body:      "Risk score: 0.3",
		RiskScore: 0.3,
	}

	score, blocked := assessor.Evaluate(msg)

	if score != 0.3 {
		t.Fatalf("expected adapter risk score to be preserved, got %.2f", score)
	}
	if blocked {
		t.Fatalf("expected non-critical adapter risk not to be blocked")
	}
}

func TestEvaluateBlocksHighAdapterRiskScore(t *testing.T) {
	assessor := NewAssessor(DefaultRules())
	msg := &domain.UnifiedMessage{
		Title:     "Approval required: Bash",
		Body:      "Risk score: 0.9",
		RiskScore: 0.9,
	}

	score, blocked := assessor.Evaluate(msg)

	if score != 0.9 {
		t.Fatalf("expected adapter risk score to be preserved, got %.2f", score)
	}
	if !blocked {
		t.Fatalf("expected high adapter risk to be blocked")
	}
}
