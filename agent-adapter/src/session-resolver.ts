import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

export function resolveLatestSessionId(
  cwd: string,
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): string | null {
  const dir = join(projectsRoot, encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let latest: { id: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      const mtime = statSync(file).mtimeMs;
      if (!latest || mtime > latest.mtime) {
        latest = { id: name.slice(0, -'.jsonl'.length), mtime };
      }
    } catch {
      // Ignore entries that disappear or cannot be statted.
    }
  }

  return latest?.id ?? null;
}

export function resolveSessionFile(cwd: string): string {
  return process.env.AGENTBRIDGE_SESSION_FILE || join(cwd, '.agentbridge-current-session');
}

export function persistSessionId(file: string, sessionId: string): void {
  try {
    writeFileSync(file, sessionId + '\n', 'utf8');
  } catch {
    // Best-effort: failing to record the session id must not break the conversation.
  }
}
