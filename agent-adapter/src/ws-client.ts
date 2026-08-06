import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { UnifiedMessage } from './types';

export interface AgentBridgeClientOptions {
  /** URL of the middleware core, e.g. 'ws://localhost:8080' */
  serverUrl: string;
  sessionId: string;
  /** Auth token (API key or JWT). */
  token?: string;
  /** Reconnect interval in ms (default: 2000). */
  reconnectInterval?: number;
  /** Max reconnect attempts (default: 10). */
  maxReconnectAttempts?: number;
}

/**
 * AgentBridgeClient connects the Agent Adapter to the Middleware Core
 * via WebSocket, sending classified events and receiving user actions.
 */
export class AgentBridgeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<AgentBridgeClientOptions>;
  private reconnectCount = 0;
  private closed = false;

  constructor(options: AgentBridgeClientOptions) {
    super();
    this.options = {
      serverUrl: options.serverUrl,
      sessionId: options.sessionId,
      token: options.token || '',
      reconnectInterval: options.reconnectInterval || 2000,
      maxReconnectAttempts: options.maxReconnectAttempts || 10,
    };
  }

  /** Open the WebSocket connection. */
  connect(): void {
    if (this.closed) return;

    const url = `${this.options.serverUrl}/ws/${this.options.sessionId}?device_type=agent_adapter&token=${this.options.token}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.reconnectCount = 0;
      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.emit('message', msg);

        // Skip replay messages — only emit fresh user actions.
        if (msg.is_replay) return;

        // If it's a user action relayed from Core, emit separately.
        if (msg.event?.action?.type) {
          this.emit('user_action', {
            type: msg.event.action.type,
            taskId: msg.event.task_id,
            deviceType: msg.event.action.device_type,
            timestamp: msg.event.action.timestamp,
            text: msg.event.action.text,
          });
        }
      } catch {
        // Non-JSON message (e.g. heartbeat), ignore.
      }
    });

    this.ws.on('close', () => {
      this.emit('disconnected');
      this.reconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /** Send a classified UnifiedMessage to the Core via REST. */
  async sendEvent(msg: UnifiedMessage): Promise<void> {
    const url = `${this.options.serverUrl}/api/v1/events`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.options.token) {
      headers['Authorization'] = `Bearer ${this.options.token}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      const result = await response.json();
      this.emit('event_ack', result);
    } catch (err) {
      this.emit('send_error', err);
    }
  }

  /** Close the connection permanently (no reconnect). */
  close(): void {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    if (this.reconnectCount >= this.options.maxReconnectAttempts) {
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectCount++;
    const delay = Math.min(
      this.options.reconnectInterval * Math.pow(2, this.reconnectCount - 1),
      30000 // max 30s
    );

    setTimeout(() => this.connect(), delay);
  }
}
