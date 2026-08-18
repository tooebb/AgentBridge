import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { EventNormalizer } from './normalizer.js';
import { AgentBridgeClient } from './ws-client.js';
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

  constructor(options: ApprovalRelayOptions) {
    this.sendEvent = options.sendEvent;
    this.normalizer = new EventNormalizer(options.sessionId, options.agentId ?? 'claude-code');
    this.timeoutMs = options.timeoutMs ?? 120_000;
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
  wsClient.connect();

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/approve') {
      void handleApprove(req, res, relay);
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
