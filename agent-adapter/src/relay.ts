import { EventNormalizer } from './normalizer.js';
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
