import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

interface AssistantEvent {
  type: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

// Returns the text of the most recent assistant message, or null when that
// message is still mid-tool (its terminal end_turn message has not been
// flushed to the transcript yet). An empty string means the turn ended with
// no text block, so there is nothing to relay.
export function extractLatestTurnText(jsonl: string): string | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: AssistantEvent;
    try {
      entry = JSON.parse(line) as AssistantEvent;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const msg = entry.message ?? entry;
    if (msg.stop_reason === 'tool_use') return null;
    return (msg.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

export interface HookInput {
  transcriptPath: string;
}

export function parseHookInput(raw: string): HookInput {
  const data = JSON.parse(raw) as { transcript_path?: string };
  return { transcriptPath: data.transcript_path ?? '' };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const FLUSH_POLL_INTERVAL_MS = 250;
const FLUSH_POLL_MAX_ATTEMPTS = 20;

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input.transcriptPath) return;

  // The Stop hook can fire before the final assistant message is flushed to
  // the transcript. Poll until the terminal message appears so this turn's
  // text is captured now instead of being deferred to the next turn's hook.
  let text: string | null = null;
  for (let attempt = 0; attempt < FLUSH_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      text = extractLatestTurnText(await readFile(input.transcriptPath, 'utf8'));
    } catch {
      return;
    }
    if (text !== null) break;
    if (attempt < FLUSH_POLL_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, FLUSH_POLL_INTERVAL_MS));
    }
  }
  if (!text) return;

  const relayUrl = process.env.AGENTBRIDGE_RELAY_URL || 'http://127.0.0.1:8787';
  try {
    await fetch(`${relayUrl}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    // Relay is best-effort and must not block Claude Code.
  }
  process.stdout.write('{}');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
