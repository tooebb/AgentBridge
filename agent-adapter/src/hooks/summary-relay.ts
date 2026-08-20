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

export function extractLastAssistantText(jsonl: string): string {
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
    if (msg.stop_reason !== 'end_turn') continue;
    const text = (msg.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    if (text) return text;
    return '';
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

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input.transcriptPath) return;

  let jsonl: string;
  try {
    jsonl = await readFile(input.transcriptPath, 'utf8');
  } catch {
    return;
  }

  const text = extractLastAssistantText(jsonl);
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
