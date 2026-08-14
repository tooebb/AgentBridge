package risk

import (
	"regexp"
	"strings"

	"agentbridge/internal/domain"
)

// Rule defines a single risk assessment rule.
type Rule struct {
	Name          string
	Description   string
	Score         float64
	BlockOnMobile bool
	Match         func(msg *domain.UnifiedMessage) bool
}

// Assessor evaluates risk of actions described in a UnifiedMessage.
type Assessor struct {
	rules []Rule
}

var destructiveCmdPattern = regexp.MustCompile(
	`(rm\s+-rf|DROP\s+(TABLE|DATABASE)|DELETE\s+FROM|--force|` +
		`git\s+push\s+--force|git\s+reset\s+--hard|` +
		`docker\s+rm|kubectl\s+delete|terraform\s+destroy)`)

var deployCmdPattern = regexp.MustCompile(
	`(deploy|publish|release|push\s+--tags|npm\s+publish)`)

var migrationPattern = regexp.MustCompile(
	`(migrate|prisma\s+migrate|alembic|flyway|sequelize\s+db:migrate)`)

var certDeletionPattern = regexp.MustCompile(`.*\.(key|pem|crt|p12|jks|keystore)`)
var authChangePattern = regexp.MustCompile(`(?i)(api.?key|JWT.?secret|IAM|permission|role|credential)`)

// DefaultRules returns the standard risk ruleset.
func DefaultRules() []Rule {
	return []Rule{
		{
			Name:          "destructive_shell",
			Description:   "Destructive shell commands (rm -rf, DROP TABLE, force push, etc.)",
			Score:         0.9,
			BlockOnMobile: true,
			Match: func(msg *domain.UnifiedMessage) bool {
				return destructiveCmdPattern.MatchString(msg.Body) ||
					destructiveCmdPattern.MatchString(msg.Title)
			},
		},
		{
			Name:          "certificate_deletion",
			Description:   "Deletion of certificate or key files",
			Score:         0.8,
			BlockOnMobile: true,
			Match: func(msg *domain.UnifiedMessage) bool {
				return certDeletionPattern.MatchString(msg.Body) && containsDelete(msg)
			},
		},
		{
			Name:          "database_migration",
			Description:   "Database migration operations",
			Score:         0.7,
			BlockOnMobile: true,
			Match: func(msg *domain.UnifiedMessage) bool {
				return migrationPattern.MatchString(msg.Body) ||
					migrationPattern.MatchString(msg.Title)
			},
		},
		{
			Name:          "remote_deploy",
			Description:   "Remote deployment or publishing",
			Score:         0.6,
			BlockOnMobile: true,
			Match: func(msg *domain.UnifiedMessage) bool {
				return deployCmdPattern.MatchString(msg.Body) ||
					deployCmdPattern.MatchString(msg.Title)
			},
		},
		{
			Name:          "auth_change",
			Description:   "Authentication or permission changes",
			Score:         0.5,
			BlockOnMobile: false,
			Match: func(msg *domain.UnifiedMessage) bool {
				return authChangePattern.MatchString(msg.Body)
			},
		},
		{
			Name:          "file_deletion",
			Description:   "Deletion of ordinary files",
			Score:         0.2,
			BlockOnMobile: false,
			Match: func(msg *domain.UnifiedMessage) bool {
				return containsDelete(msg)
			},
		},
		{
			Name:          "shell_execution",
			Description:   "General shell command execution",
			Score:         0.2,
			BlockOnMobile: false,
			Match: func(msg *domain.UnifiedMessage) bool {
				return strings.Contains(msg.Body, "$ ") ||
					strings.Contains(msg.Body, "> ")
			},
		},
	}
}

// NewAssessor creates an Assessor with the given rules.
func NewAssessor(rules []Rule) *Assessor {
	return &Assessor{rules: rules}
}

// Evaluate runs all rules against a message and returns the cumulative risk score
// and whether the action should be blocked on mobile devices.
func (a *Assessor) Evaluate(msg *domain.UnifiedMessage) (score float64, blocked bool) {
	if msg.RiskScore > 0 {
		return msg.RiskScore, msg.RiskBlocked || msg.RiskScore >= 0.7
	}

	for _, rule := range a.rules {
		if rule.Match(msg) {
			score += rule.Score
			if rule.BlockOnMobile {
				blocked = true
			}
		}
	}
	if score > 1.0 {
		score = 1.0
	}
	return score, blocked
}

func containsDelete(msg *domain.UnifiedMessage) bool {
	text := strings.ToLower(msg.Body + " " + msg.Title)
	return strings.Contains(text, "delete") ||
		strings.Contains(text, "remove") ||
		strings.Contains(text, "rm ")
}
