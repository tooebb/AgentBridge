import { useState, useEffect, useCallback } from 'react';
import { DeviceMessage } from '../types';

export function useEventHistory(sessionId: string | null) {
  const [history, setHistory] = useState<DeviceMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    if (!sessionId) {
      setHistory([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/events/${sessionId}`);
      const data: DeviceMessage[] = await res.json();
      setHistory(data || []);
    } catch {
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { history, loading, refresh: fetchHistory };
}
