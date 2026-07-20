import { useState, useEffect, useCallback, useRef } from 'react';
import { DeviceMessage } from '../types';

type WsState = 'connecting' | 'connected' | 'disconnected';

export function useWebSocket() {
  const [state, setState] = useState<WsState>('disconnected');
  const [messages, setMessages] = useState<DeviceMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/dashboard`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    setState('connecting');

    ws.onopen = () => setState('connected');

    ws.onmessage = (event) => {
      try {
        const msg: DeviceMessage = JSON.parse(event.data);
        setMessages((prev) => [...prev.slice(-499), msg]);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setState('disconnected');
      setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const clear = useCallback(() => setMessages([]), []);

  return {
    state,
    connected: state === 'connected',
    messages,
    clear,
  };
}
