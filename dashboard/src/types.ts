// Wire types matching Core's JSON output.

export type EventType =
  | 'task_started'
  | 'task_running'
  | 'task_blocked'
  | 'needs_approval'
  | 'task_failed'
  | 'task_completed';

export type Severity = 'info' | 'warning' | 'critical';

export type DeviceType = 'phone' | 'smartwatch' | 'ar_glasses' | 'earbuds' | 'dashboard';

export interface UnifiedEvent {
  id: string;
  task_id: string;
  session_id: string;
  event_type: EventType;
  title: string;
  body: string;
  severity: Severity;
  risk_score: number;
  risk_blocked: boolean;
  available_actions: { action_type: string; label: string; confirmation_required: boolean }[];
  timestamp: string;
  agent_id: string;
}

export interface DeviceOutput {
  tts_text?: string;
  card_title?: string;
  card_body?: string;
  quick_actions?: { type: string; label: string }[];
  render_hint?: string;
  vibe_pattern?: string;
}

export interface DeviceMessage {
  direction: string;
  message_id: string;
  session_id: string;
  timestamp: number;
  event: UnifiedEvent;
  device_overrides: Record<string, DeviceOutput>;
}

export interface SessionInfo {
  id: string;
  devices: string[] | null;
  created: number;
  event_count: number;
  last_event_type?: EventType;
}
