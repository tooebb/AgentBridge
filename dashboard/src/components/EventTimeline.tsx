import { DeviceMessage } from '../types';
import { EventBadge } from './EventBadge';

interface Props {
  events: DeviceMessage[];
}

export function EventTimeline({ events }: Props) {
  if (events.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: '#6b7280', fontSize: 14 }}>
        Select a session to view events
      </div>
    );
  }

  return (
    <div style={{ overflowY: 'auto', height: '100%' }}>
      {events.map((msg) => (
        <div
          key={msg.message_id}
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid #1f2937',
            borderLeft: msg.event.risk_blocked ? '3px solid #ef4444' : '3px solid transparent',
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <EventBadge type={msg.event.event_type} riskBlocked={msg.event.risk_blocked} />
            <span style={{ fontSize: 11, color: '#6b7280', flex: 1 }}>
              {new Date(msg.event.timestamp).toLocaleTimeString()}
            </span>
            {msg.event.risk_score > 0 && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 9999,
                backgroundColor: msg.event.risk_score >= 0.7 ? '#7f1d1d' : '#78350f',
                color: msg.event.risk_score >= 0.7 ? '#fca5a5' : '#fcd34d',
              }}>
                Risk: {msg.event.risk_score.toFixed(1)}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: '#e5e7eb', marginBottom: 2 }}>
            {msg.event.title}
          </div>
          {msg.event.body !== msg.event.title && (
            <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.4 }}>
              {msg.event.body.slice(0, 200)}
            </div>
          )}
          <div style={{ fontSize: 10, color: '#4b5563', marginTop: 4 }}>
            task: {msg.event.task_id} · agent: {msg.event.agent_id}
          </div>
        </div>
      ))}
    </div>
  );
}
