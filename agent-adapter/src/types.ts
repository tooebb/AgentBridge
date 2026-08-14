// Shared types for the Agent Adapter.

export type EventType =
  | 'task_started'
  | 'task_running'
  | 'task_blocked'
  | 'needs_approval'
  | 'task_failed'
  | 'task_completed'
  | 'user_action';

export type Severity = 'info' | 'warning' | 'critical';

export interface AvailableAction {
  action_type: string;
  label: string;
  confirmation_required: boolean;
}

export interface UnifiedMessage {
  id: string;
  task_id: string;
  session_id: string;
  event_type: EventType;
  title: string;
  body: string;
  details?: string;
  severity: Severity;
  risk_score: number;
  risk_blocked: boolean;
  available_actions: AvailableAction[];
  timestamp: string; // ISO 8601, matches Go's time.Time JSON encoding
  agent_id: string;
  metadata?: Record<string, unknown>;
  action?: DeviceAction;
}

export interface DeviceAction {
  type: string;
  device_type: string;
  timestamp: number;
  text?: string;
}

export interface RawEvent {
  agentId: string;
  sessionId: string;
  timestamp: number;
  rawOutput: string;
  source: 'stdout' | 'stderr' | 'hook';
  classifiedType?: EventType;
}

export interface Context {
  recentOutputs: string[];
  recentEventTypes: EventType[];
  timeSinceLastOutput: number;
  consecutiveErrors: number;
  currentTaskPhase: 'init' | 'executing' | 'awaiting_approval' | 'cleanup' | 'unknown';
}
