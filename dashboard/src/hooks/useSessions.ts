import { useState, useEffect, useCallback } from 'react';
import { SessionInfo } from '../types';

export function useSessions(selectedId: string | null) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/sessions');
      const data: SessionInfo[] = await res.json();
      setSessions(data || []);
    } catch {
      // server may be down
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll sessions every 3 seconds.
  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  return { sessions, loading, refresh: fetchSessions };
}
