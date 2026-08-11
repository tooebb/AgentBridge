const COMMAND_TOOLS = /^(execute_command|run_shell|Bash)$/;

interface RiskRule {
  toolPattern: RegExp;
  inputMatch?: (args: Record<string, unknown>) => boolean;
  risk: number;
}

const RISK_RULES: RiskRule[] = [
  {
    toolPattern: COMMAND_TOOLS,
    inputMatch: (args) => /\b(rm\s+-rf|sudo|chmod|chown|mkfs|dd|format|shutdown|reboot)\b/i.test(commandText(args)),
    risk: 0.9,
  },
  {
    toolPattern: COMMAND_TOOLS,
    inputMatch: (args) => /\bgit\s+push\s+.*(-f|--force|--force-with-lease)\b/i.test(commandText(args)),
    risk: 0.85,
  },
  {
    toolPattern: COMMAND_TOOLS,
    inputMatch: (args) => /\b(git\s+push|npm\s+publish|docker\s+push|gh\s+release)\b/i.test(commandText(args)),
    risk: 0.6,
  },
  {
    toolPattern: /^(Write|Edit|write_file|write_to_file|replace_in_file)$/,
    risk: 0.4,
  },
  {
    toolPattern: COMMAND_TOOLS,
    risk: 0.3,
  },
  {
    toolPattern: /^(Read|read_file|Grep|Glob|search|list_files|TodoRead|TaskList|LSP)$/,
    risk: 0,
  },
  {
    toolPattern: /.*/,
    risk: 0.4,
  },
];

export const DEFAULT_RISK_THRESHOLD = 0.3;

export function assessRisk(toolName: string, toolInput?: Record<string, unknown>): number {
  const safeInput = toolInput ?? {};
  for (const rule of RISK_RULES) {
    if (!rule.toolPattern.test(toolName)) continue;
    if (rule.inputMatch && !rule.inputMatch(safeInput)) continue;
    return rule.risk;
  }
  return 0.4;
}

function commandText(args: Record<string, unknown>): string {
  return String(args.command ?? args.cmd ?? '');
}
