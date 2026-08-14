import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './types.js';

interface OpenAICompatibleAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class OpenAICompatibleAdapter implements AgentAdapter {
  readonly name = 'openai-compatible';
  readonly capabilities: AdapterCapability[] = ['conversation'];

  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly model?: string;
  private readonly messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

  constructor(options: OpenAICompatibleAdapterOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_COMPATIBLE_API_KEY;
    this.baseUrl = normalizeBaseUrl(options.baseUrl || process.env.OPENAI_COMPATIBLE_BASE_URL);
    this.model = options.model || process.env.OPENAI_COMPATIBLE_MODEL;
  }

  async connect(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error('OPENAI_COMPATIBLE_BASE_URL is not configured');
    }
    if (!this.model) {
      throw new Error('OPENAI_COMPATIBLE_MODEL is not configured');
    }
    this.messages.length = 0;
    this.messages.push({
      role: 'system',
      content: 'You are an AI coding agent connected through OPC Agent Adapter. Keep responses concise and surface actions that need user approval.',
    });
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const taskId = input.taskId || input.sessionId || 'default';
    if (input.type !== 'action_response') {
      yield { type: 'task_started', taskId };
    }

    this.messages.push({ role: 'user', content: input.text || this.inputFallbackText(input) });

    const text = await this.createChatCompletion();
    this.messages.push({ role: 'assistant', content: text });
    yield { type: 'text', content: text };
    yield { type: 'done', text };
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    this.messages.length = 0;
  }

  private async createChatCompletion(): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        stream: false,
      }),
    });

    const body = await response.json() as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(body.error?.message || `OpenAI-compatible API returned HTTP ${response.status}`);
    }

    const content = body.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('OpenAI-compatible API returned an empty response');
    }
    return content;
  }

  private inputFallbackText(input: AgentInput): string {
    if (input.action?.text) return input.action.text;
    if (input.action?.type) return actionToPrompt(input.action);
    if (input.type === 'start_task') return 'Start the task.';
    return 'Continue.';
  }
}

function actionToPrompt(action: DeviceAction): string {
  const messages: Record<string, string> = {
    approve: 'Approved by the user from the connected device. Continue.',
    reject: 'Rejected by the user from the connected device. Stop this action and propose a safer alternative.',
    continue: 'Continue.',
    pause: 'Pause and wait for further instructions.',
    view_details: 'Show more details about the current task.',
  };
  return messages[action.type] || action.type;
}

function normalizeBaseUrl(value?: string): string | undefined {
  return value?.replace(/\/+$/, '');
}
