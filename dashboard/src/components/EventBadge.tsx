import { EventType } from '../types';

const EVENT_COLORS: Record<EventType, string> = {
  task_started: '#3b82f6',     // blue
  task_running: '#6366f1',     // indigo
  task_blocked: '#f59e0b',     // amber
  needs_approval: '#8b5cf6',   // violet
  task_failed: '#ef4444',      // red
  task_completed: '#22c55e',   // green
};

const EVENT_LABELS: Record<EventType, string> = {
  task_started: 'Started',
  task_running: 'Running',
  task_blocked: 'Blocked',
  needs_approval: 'Needs Approval',
  task_failed: 'Failed',
  task_completed: 'Completed',
};

interface Props {
  type: EventType;
  riskBlocked?: boolean;
}

export function EventBadge({ type, riskBlocked }: Props) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
        backgroundColor: riskBlocked ? '#ef4444' : EVENT_COLORS[type] || '#6b7280',
        whiteSpace: 'nowrap',
      }}
    >
      {riskBlocked ? '⛔ Blocked' : EVENT_LABELS[type] || type}
    </span>
  );
}
