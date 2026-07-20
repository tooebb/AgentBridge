import { useState, useMemo } from 'react';
import { Header } from './components/Header';
import { SessionList } from './components/SessionList';
import { EventTimeline } from './components/EventTimeline';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import { useEventHistory } from './hooks/useEventHistory';
import { DeviceMessage } from './types';

export default function App() {
  const { connected, messages } = useWebSocket();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { sessions, refresh } = useSessions(selectedId);
  const { history } = useEventHistory(selectedId);

  // Merge historical events (from REST) with live WebSocket events, deduplicated.
  const filteredEvents = useMemo(() => {
    if (!selectedId) return [] as DeviceMessage[];
    const seen = new Set<string>();
    // Historical events first, then live events on top.
    const merged: DeviceMessage[] = [];
    for (const msg of [...history, ...messages]) {
      if (msg.session_id === selectedId && !seen.has(msg.message_id)) {
        seen.add(msg.message_id);
        merged.push(msg);
      }
    }
    return merged;
  }, [messages, history, selectedId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#0f172a', color: '#e5e7eb' }}>
      <Header
        connected={connected}
        eventCount={messages.length}
        sessionCount={sessions.length}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <aside
          style={{
            width: 260,
            minWidth: 260,
            backgroundColor: '#0f172a',
            borderRight: '1px solid #1f2937',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              padding: '12px 14px',
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              color: '#6b7280',
              letterSpacing: 1,
              borderBottom: '1px solid #1f2937',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>Sessions</span>
            <button
              onClick={refresh}
              style={{
                background: 'none', border: 'none', color: '#6366f1', cursor: 'pointer',
                fontSize: 11, padding: 0,
              }}
            >
              Refresh
            </button>
          </div>
          <SessionList sessions={sessions} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>

        {/* Main */}
        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              padding: '10px 16px',
              fontSize: 12,
              color: '#6b7280',
              borderBottom: '1px solid #1f2937',
              backgroundColor: '#0f172a',
            }}
          >
            {selectedId
              ? `Events for ${selectedId} (${filteredEvents.length} message${filteredEvents.length !== 1 ? 's' : ''})`
              : 'Select a session from the sidebar'}
          </div>
          <EventTimeline events={filteredEvents} />
        </main>
      </div>
    </div>
  );
}
