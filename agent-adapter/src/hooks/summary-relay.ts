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
