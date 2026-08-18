import { pathToFileURL } from 'node:url';
import { assessRisk, DEFAULT_RISK_THRESHOLD } from '../risk.js';

export interface HookInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  cwd?: string;
}

export function parseHookInput(raw: string): HookInput {
  const data = JSON.parse(raw) as {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_use_id?: string;
    cwd?: string;
  };
  return {
    toolName: data.tool_name ?? '',
    toolInput: data.tool_input ?? {},
    toolUseId: data.tool_use_id ?? '',
    cwd: data.cwd,
  };
}

export function permissionDecisionOutput(decision: 'allow' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const threshold = Number(process.env.AGENTBRIDGE_RISK_THRESHOLD || DEFAULT_RISK_THRESHOLD);
  const risk = assessRisk(input.toolName, input.toolInput);

  if (risk < threshold) {
    process.stdout.write(permissionDecisionOutput('allow', `low risk (${risk})`));
    return;
  }

  const relayUrl = process.env.AGENTBRIDGE_RELAY_URL || 'http://127.0.0.1:8787';
  try {
    const resp = await fetch(`${relayUrl}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_use_id: input.toolUseId,
        tool_name: input.toolName,
        tool_input: input.toolInput,
        risk,
        cwd: input.cwd,
      }),
    });
    if (!resp.ok) {
      process.stdout.write(permissionDecisionOutput('allow', `relay error ${resp.status}`));
      return;
    }
    const body = await resp.json() as { decision?: string };
    const decision = body.decision === 'deny' ? 'deny' : 'allow';
    process.stdout.write(permissionDecisionOutput(
      decision,
      decision === 'allow' ? 'approved from glasses' : 'rejected from glasses',
    ));
  } catch (err) {
    process.stdout.write(permissionDecisionOutput(
      'allow',
      `relay unreachable: ${err instanceof Error ? err.message : 'error'}`,
    ));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
