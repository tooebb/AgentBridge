import Anthropic from '@anthropic-ai/sdk';

export interface SummarizeOptions {
  model?: string;
  timeoutMs?: number;
  maxLen?: number;
}

export interface ChatClient {
  create(request: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: 'user'; content: string }>;
  }): Promise<{ content: Array<{ type: string; text?: string }> }>;
}

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LEN = 80;

export async function summarize(
  text: string,
  options: SummarizeOptions = {},
  client?: ChatClient,
): Promise<string> {
  const model = options.model ?? process.env.AGENTBRIDGE_SUMMARY_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? Number(process.env.AGENTBRIDGE_SUMMARY_TIMEOUT ?? DEFAULT_TIMEOUT_MS);
  const maxLen = options.maxLen ?? Number(process.env.AGENTBRIDGE_SUMMARY_MAX_LEN ?? DEFAULT_MAX_LEN);

  try {
    const c = client ?? createDefaultClient();
    const resp = await withTimeout(
      c.create({
        model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `把下面这段内容压缩成一句话摘要，保留关键信息，不超过 60 字，用原文语言回答：\n\n${text}`,
        }],
      }),
      timeoutMs,
    );
    const block = resp.content.find((b) => b.type === 'text' && typeof b.text === 'string');
    const summary = typeof block?.text === 'string' ? block.text.trim() : '';
    return summary || truncate(text, maxLen);
  } catch {
    return truncate(text, maxLen);
  }
}

function createDefaultClient(): ChatClient {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  });
  return {
    create: (request) => anthropic.messages.create(request),
  };
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
