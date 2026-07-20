import { SessionInfo } from '../types';
import { EventBadge } from './EventBadge';

interface Props {
  sessions: SessionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SessionList({ sessions, selectedId, onSelect }: Props) {
  if (sessions.length === 0) {
    return (
      <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>
        No sessions yet. Send an event to get started.
      </div>
    );
  }

  return (
    <div>
      {sessions.map((s) => (
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          style={{
            padding: '10px 14px',
            cursor: 'pointer',
            backgroundColor: s.id === selectedId ? '#1f2937' : 'transparent',
            borderLeft: s.id === selectedId ? '3px solid #6366f1' : '3px solid transparent',
            borderBottom: '1px solid #1f2937',
            transition: 'background-color 0.15s',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: '#e5e7eb', marginBottom: 4, wordBreak: 'break-all' }}>
            {s.id}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {s.last_event_type && <EventBadge type={s.last_event_type} />}
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {s.event_count} event{s.event_count !== 1 ? 's' : ''}
            </span>
            {s.devices && s.devices.length > 0 && (
              <span style={{ fontSize: 11, color: '#22c55e' }}>
                {s.devices.length} device{s.devices.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
