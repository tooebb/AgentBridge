interface Props {
  connected: boolean;
  eventCount: number;
  sessionCount: number;
}

export function Header({ connected, eventCount, sessionCount }: Props) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        backgroundColor: '#111827',
        borderBottom: '1px solid #1f2937',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 16, fontWeight: 700, color: '#e5e7eb', margin: 0 }}>
          AgentBridge
        </h1>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            padding: '2px 10px',
            borderRadius: 9999,
            backgroundColor: connected ? '#064e3b' : '#7f1d1d',
            color: connected ? '#6ee7b7' : '#fca5a5',
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            backgroundColor: connected ? '#22c55e' : '#ef4444',
            display: 'inline-block',
          }} />
          {connected ? 'Live' : 'Disconnected'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#9ca3af' }}>
        <span>{sessionCount} session{sessionCount !== 1 ? 's' : ''}</span>
        <span>{eventCount} event{eventCount !== 1 ? 's' : ''}</span>
      </div>
    </header>
  );
}
