import { Context, EventType, RawEvent, Severity, UnifiedMessage } from './types';
import type { AgentEvent } from './adapters/types';

/**
 * ClassificationRule defines a single pattern for matching raw agent output.
 */
interface ClassificationRule {
  eventType: EventType;
  patterns: RegExp[];
  keywords: string[];
  priority: number; // lower = higher priority
  contextBoost?: (ctx: Context) => boolean;
}

const rules: ClassificationRule[] = [
  {
    eventType: 'needs_approval',
    patterns: [
      /approval\s+required/i,
      /confirm\?/i,
      /are\s+you\s+sure/i,
      /proceed\?/i,
      /do\s+you\s+want\s+to/i,
      /should\s+I/i,
      /requires?\s+permission/i,
      /needs?\s+authorization/i,
    ],
    keywords: ['approval', 'confirm?', 'permission', 'are you sure', 'proceed?'],
    priority: 1,
    contextBoost: (ctx) => ctx.currentTaskPhase === 'executing',
  },
  {
    eventType: 'task_failed',
    patterns: [
      /^(Error|FAILED|FATAL|Exception|panic|crash)[:!]/m,
      /exit\s+code\s+[1-9]/i,
      /cannot\s+(proceed|continue|find|read|write|connect)/i,
      /unable\s+to/i,
      /refused/i,
      /denied/i,
    ],
    keywords: ['Error:', 'FAILED', 'FATAL', 'Exception', 'panic'],
    priority: 2,
    contextBoost: (ctx) => ctx.consecutiveErrors >= 2,
  },
  {
    eventType: 'task_blocked',
    patterns: [
      /stuck/i,
      /blocked/i,
      /waiting\s+for/i,
      /hung/i,
      /timeout/i,
      /no\s+response/i,
      /connection\s+refused/i,
      /cannot\s+proceed/i,
    ],
    keywords: ['blocked', 'stuck', 'timeout', 'cannot proceed', 'waiting'],
    priority: 3,
    contextBoost: (ctx) => ctx.timeSinceLastOutput > 120_000, // 2 minutes
  },
  {
    eventType: 'task_completed',
    patterns: [
      /completed/i,
      /finished/i,
      /build\s+successful/i,
      /deployment\s+done/i,
      /tests?\s+passed/i,
      /all\s+done/i,
      /success(fully)?/i,
    ],
    keywords: ['completed', 'finished successfully', 'done', 'build successful'],
    priority: 4,
    contextBoost: (ctx) => ctx.currentTaskPhase === 'executing',
  },
  {
    eventType: 'task_started',
    patterns: [
      /starting\s+(task|operation|build|deploy)/i,
      /launching/i,
      /beginning/i,
      /initializing/i,
      /setting\s+up/i,
    ],
    keywords: ['Starting task', 'Launching', 'Beginning', 'Initializing'],
    priority: 5,
    contextBoost: (ctx) => ctx.currentTaskPhase === 'init',
  },
];

// Fallback: if nothing matches, classify as task_running.
const FALLBACK_EVENT: EventType = 'task_running';

/**
 * EventNormalizer converts raw agent output into a structured UnifiedMessage
 * using pattern matching enhanced by contextual hints.
 */
export class EventNormalizer {
  private sessionId: string;
  private agentId: string;

  constructor(sessionId: string, agentId = 'claude-code') {
    this.sessionId = sessionId;
    this.agentId = agentId;
  }

  /**
   * Classify a raw event and produce a UnifiedMessage.
   */
  normalize(raw: RawEvent, ctx: Context): UnifiedMessage {
    const eventType = this.classify(raw, ctx);
    raw.classifiedType = eventType;

    const { title, body } = this.extractSummary(raw.rawOutput);
    const severity = this.inferSeverity(eventType);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      task_id: this.sessionId, // default: one task per session; caller can override
      session_id: this.sessionId,
      event_type: eventType,
      title,
      body,
      severity,
      risk_score: 0,
      risk_blocked: false,
      available_actions: eventType === 'needs_approval'
        ? [
            { action_type: 'approve', label: 'Approve', confirmation_required: false },
            { action_type: 'reject', label: 'Reject', confirmation_required: false },
            { action_type: 'view_details', label: 'View Details', confirmation_required: false },
          ]
        : [],
      timestamp: new Date(raw.timestamp).toISOString(),
      agent_id: this.agentId,
    };
  }

  fromAgentEvent(event: AgentEvent): UnifiedMessage {
    const { eventType, title, body, severity } = this.mapAgentEvent(event);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      task_id: ('taskId' in event ? event.taskId : '') || this.sessionId,
      session_id: this.sessionId,
      event_type: eventType,
      title,
      body,
      severity,
      risk_score: 'risk' in event ? event.risk : 0,
      risk_blocked: false,
      available_actions: event.type === 'needs_approval'
        ? [
            { action_type: 'approve', label: 'Approve', confirmation_required: false },
            { action_type: 'reject', label: 'Reject', confirmation_required: false },
            { action_type: 'view_details', label: 'View Details', confirmation_required: false },
          ]
        : [],
      timestamp: new Date().toISOString(),
      agent_id: this.agentId,
    };
  }

  /** Run classification rules in priority order. */
  private classify(raw: RawEvent, ctx: Context): EventType {
    const sorted = [...rules].sort((a, b) => a.priority - b.priority);
    const text = raw.rawOutput;

    for (const rule of sorted) {
      const patternMatch = rule.patterns.some((p) => p.test(text));
      const keywordMatch = rule.keywords.some((k) =>
        text.toLowerCase().includes(k.toLowerCase())
      );

      if (patternMatch || keywordMatch) {
        // Context boost: if the context rule exists and returns true,
        // raise confidence.
        if (rule.contextBoost && rule.contextBoost(ctx)) {
          return rule.eventType;
        }
        // Without context boost, still match but with lower confidence.
        // For "done" ambiguity, require context boost for task_completed.
        if (rule.eventType === 'task_completed' && /\bdone\b/i.test(text)) {
          // Only skip if "done" is the only signal — strong completion
          // signals like "completed"/"finished"/"build successful" override.
          const hasStrongSignal = /\b(?:completed|finished|build\s+successful|successfully|tests?\s+passed|all\s+done)\b/i.test(text);
          if (!hasStrongSignal && (!rule.contextBoost || !rule.contextBoost(ctx))) {
            continue; // skip — bare "done" without exec context is ambiguous
          }
        }
        return rule.eventType;
      }
    }

    return FALLBACK_EVENT;
  }

  /** Extract a short title and longer body from raw output. */
  private extractSummary(
    raw: string
  ): { title: string; body: string } {
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const title = lines[0]?.slice(0, 120) || raw.slice(0, 120);
    const body = lines.slice(1).join('\n').slice(0, 500) || title;
    return { title, body };
  }

  /** Map event type to default severity. */
  private inferSeverity(eventType: EventType): Severity {
    switch (eventType) {
      case 'task_failed':
        return 'critical';
      case 'task_blocked':
      case 'needs_approval':
        return 'warning';
      default:
        return 'info';
    }
  }

  private mapAgentEvent(event: AgentEvent): {
    eventType: EventType;
    title: string;
    body: string;
    severity: Severity;
  } {
    switch (event.type) {
      case 'task_started':
        return {
          eventType: 'task_started',
          title: event.taskId || 'Task started',
          body: 'Task started',
          severity: 'info',
        };
      case 'tool_call':
        return {
          eventType: 'task_running',
          title: `Tool call: ${event.tool}`,
          body: JSON.stringify(event.args),
          severity: 'info',
        };
      case 'task_blocked':
        return {
          eventType: 'task_blocked',
          title: 'Task blocked',
          body: event.reason,
          severity: 'warning',
        };
      case 'needs_approval':
        return {
          eventType: 'needs_approval',
          title: `Approval required: ${event.tool}`,
          body: `Risk score: ${event.risk}`,
          severity: event.risk >= 0.7 ? 'critical' : 'warning',
        };
      case 'task_failed':
        return {
          eventType: 'task_failed',
          title: 'Task failed',
          body: event.error,
          severity: 'critical',
        };
      case 'task_completed':
        return {
          eventType: 'task_completed',
          title: 'Task completed',
          body: event.summary,
          severity: 'info',
        };
      case 'done':
        return {
          eventType: 'task_completed',
          title: 'Task completed',
          body: event.text,
          severity: 'info',
        };
      case 'text':
        return {
          eventType: 'task_running',
          title: 'Agent output',
          body: event.content.slice(0, 500),
          severity: 'info',
        };
    }
  }
}
