import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { exec } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { assessRisk } from '../risk';
import type { AdapterCapability, AgentAdapter, AgentEvent, AgentInput, DeviceAction } from './types';

interface ClaudeAPIAdapterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class ClaudeAPIAdapter implements AgentAdapter {
  readonly name = 'claude-api';
  readonly capabilities: AdapterCapability[] = ['file_ops', 'shell_exec', 'code_search', 'conversation'];

  private client: Anthropic;
  private messages: MessageParam[] = [];
  private pendingToolUseId: string | null = null;
  private pendingTool: { name: string; input: Record<string, unknown> } | null = null;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly tools: Tool[] = [
    {
      name: 'run_shell',
      description: 'Execute a shell command and return stdout or stderr.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute.' },
          working_dir: { type: 'string', description: 'Working directory.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to write.' },
          content: { type: 'string', description: 'File content.' },
        },
        required: ['path', 'content'],
      },
    },
  ];

  constructor(options: ClaudeAPIAdapterOptions = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    this.model = options.model || process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro';
    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: options.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    });
  }

  async connect(): Promise<void> {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    this.messages = [];
    this.pendingToolUseId = null;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    if (input.type !== 'action_response') {
      yield { type: 'task_started', taskId: input.taskId || input.sessionId || 'default' };
    }

    this.messages.push({
      role: 'user',
      content: input.text || this.inputFallbackText(input),
    });

    while (true) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages: this.messages,
        tools: this.tools,
      });

      const assistantContent = response.content.map((block) => block as ContentBlockParam);
      this.messages.push({ role: 'assistant', content: assistantContent });

      const textBlocks = response.content.filter((block) => block.type === 'text');
      for (const block of textBlocks) {
        yield { type: 'text', content: block.text };
      }

      const toolUses = response.content.filter((block) => block.type === 'tool_use');
      if (toolUses.length === 0) {
        yield { type: 'done', text: textBlocks.map((block) => block.text).join('\n') };
        return;
      }

      for (const tool of toolUses) {
        const inputObject = this.asObject(tool.input);
        const risk = assessRisk(tool.name, inputObject);
        if (risk >= 0.3) {
          this.pendingToolUseId = tool.id;
          this.pendingTool = { name: tool.name, input: inputObject };
          yield { type: 'needs_approval', tool: tool.name, risk, taskId: tool.id };
          return;
        }

        yield { type: 'tool_call', tool: tool.name, args: tool.input };
        const result = await this.executeTool(tool.name, inputObject);
        this.messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tool.id, content: result }],
        });
      }
    }
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    if (!this.pendingToolUseId || !this.pendingTool) {
      return;
    }

    const approved = action.type === 'approve' || action.type === 'continue';
    const tool = this.pendingTool;
    const toolUseId = this.pendingToolUseId;
    this.pendingToolUseId = null;
    this.pendingTool = null;

    let content: string;
    if (approved) {
      content = await this.executeTool(tool.name, tool.input);
    } else {
      content = 'Rejected by the user from the connected device. Stop this action and propose a safer alternative.';
    }

    this.messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: !approved,
        },
      ],
    });
  }

  async disconnect(): Promise<void> {
    this.messages = [];
    this.pendingToolUseId = null;
  }

  private inputFallbackText(input: AgentInput): string {
    if (input.action?.text) return input.action.text;
    if (input.action?.type) return `Device action received: ${input.action.type}. Continue.`;
    if (input.type === 'start_task') return 'Start the task.';
    return 'Continue.';
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'read_file':
        return readFile(String(input.path), 'utf-8');
      case 'write_file':
        await writeFile(String(input.path), String(input.content));
        return `Wrote file: ${input.path}`;
      case 'run_shell':
        return new Promise((resolve) => {
          exec(
            String(input.command),
            { cwd: String(input.working_dir || process.cwd()), timeout: 120_000 },
            (error, stdout, stderr) => {
              if (error) {
                resolve(`Command failed: ${stderr || error.message}`);
                return;
              }
              resolve(stdout || stderr || 'Command completed with no output.');
            }
          );
        });
      default:
        return `Unknown tool: ${name}`;
    }
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
