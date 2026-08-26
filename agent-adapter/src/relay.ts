import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { EventNormalizer } from './normalizer.js';
import { AgentBridgeClient } from './ws-client.js';
import { summarize as defaultSummarize } from './summarize.js';
import type { AgentEvent } from './adapters/types.js';
import type { UnifiedMessage } from './types.js';

export type Decision = 'allow' | 'deny';

export interface ApprovalRequest {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  risk: number;
  cwd?: string;
}

export interface UserActionPayload {
  type: string;
  taskId?: string;
}

export interface ApprovalRelayOptions {
  sendEvent: (msg: UnifiedMessage) => Promise<void>;
  sessionId: string;
  agentId?: string;
  timeoutMs?: number;
  summarize?: (text: string) => Promise<string>;
}

interface PendingApproval {
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout | null;
}

export class ApprovalRelay {
  private readonly sendEvent: (msg: UnifiedMessage) => Promise<void>;
  private readonly normalizer: EventNormalizer;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly summarize: (text: string) => Promise<string>;
  private lastSummaryHash: string | null = null;

  constructor(options: ApprovalRelayOptions) {
    this.sendEvent = options.sendEvent;
    this.normalizer = new EventNormalizer(options.sessionId, options.agentId ?? 'claude-code');
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.summarize = options.summarize ?? defaultSummarize;
  }

  requestApproval(req: ApprovalRequest): Promise<Decision> {
    const event: AgentEvent = {
      type: 'needs_approval',
      tool: req.toolName,
      risk: req.risk,
      taskId: req.toolUseId,
      input: req.toolInput,
    };
    const msg = this.normalizer.fromAgentEvent(event);
    void this.sendEvent(msg);

    return new Promise<Decision>((resolve) => {
      const timer = this.timeoutMs > 0
        ? setTimeout(() => {
            if (this.pending.has(req.toolUseId)) {
              this.pending.delete(req.toolUseId);
              resolve('allow');
            }
          }, this.timeoutMs)
        : null;
      this.pending.set(req.toolUseId, { resolve, timer });
    });
  }

  handleUserAction(action: UserActionPayload): void {
    const taskId = action.taskId;
    if (!taskId) return;
    const pending = this.pending.get(taskId);
    if (!pending) return;

    if (action.type === 'approve' || action.type === 'continue') {
      this.pending.delete(taskId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve('allow');
    } else if (action.type === 'reject') {
      this.pending.delete(taskId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve('deny');
    }
  }

  async handleSummaryText(text: string): Promise<void> {
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === this.lastSummaryHash) return;
    this.lastSummaryHash = hash;
    const summary = await this.summarize(text);
    const msg = this.normalizer.fromAgentEvent({ type: 'done', text: summary });
    await this.sendEvent(msg);
  }
}

export interface ApprovalRequestBody {
  tool_use_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  risk?: number;
  cwd?: string;
}

export async function handleApprove(
  req: IncomingMessage,
  res: ServerResponse,
  relay: ApprovalRelay,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as ApprovalRequestBody;
    const decision = await relay.requestApproval({
      toolUseId: body.tool_use_id,
      toolName: body.tool_name,
      toolInput: body.tool_input ?? {},
      risk: body.risk ?? 0,
      cwd: body.cwd,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ decision }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }));
  }
}

export interface SummaryRequestBody {
  text?: string;
}

export async function handleSummary(
  req: IncomingMessage,
  res: ServerResponse,
  relay: ApprovalRelay,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as SummaryRequestBody;
    const text = body.text ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (text) {
      void relay.handleSummaryText(text);
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function main(): Promise<void> {
  const port = Number(process.env.RELAY_PORT || 8787);
  const serverUrl = process.env.AGENTBRIDGE_URL || 'http://localhost:8088';
  const sessionId = process.env.AGENTBRIDGE_SESSION || 'default';
  const timeoutMs = Number(process.env.AGENTBRIDGE_CORE_TIMEOUT || 120_000);

  const wsClient = new AgentBridgeClient({ serverUrl, sessionId });
  const relay = new ApprovalRelay({
    sendEvent: (msg) => wsClient.sendEvent(msg),
    sessionId,
    timeoutMs,
  });

  wsClient.on('user_action', (action) => relay.handleUserAction(action as UserActionPayload));
  wsClient.on('error', (err) => {
    console.error('[relay] ws error:', err instanceof Error ? err.message : err);
  });
  wsClient.connect();

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/approve') {
      void handleApprove(req, res, relay);
      return;
    }
    if (req.method === 'POST' && req.url === '/summary') {
      void handleSummary(req, res, relay);
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, () => {
    console.log(`[relay] listening on http://127.0.0.1:${port} (session=${sessionId})`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
