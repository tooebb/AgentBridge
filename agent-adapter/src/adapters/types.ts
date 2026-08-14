export interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapability[];

  connect(): Promise<void>;

  send(input: AgentInput): AsyncIterable<AgentEvent>;

  handleUserAction(action: DeviceAction): Promise<void>;

  disconnect(): Promise<void>;
}

export interface AgentInput {
  type: 'start_task' | 'user_message' | 'action_response';
  text?: string;
  action?: DeviceAction;
  taskId?: string;
  sessionId?: string;
}

export interface DeviceAction {
  type: string;
  taskId?: string;
  deviceType: string;
  text?: string;
}

export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'needs_approval'; tool: string; risk: number; taskId?: string; input?: Record<string, unknown>; reasoning?: string }
  | { type: 'task_started'; taskId: string }
  | { type: 'task_completed'; taskId: string; summary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_blocked'; taskId: string; reason: string }
  | { type: 'done'; text: string };

export type AdapterCapability =
  | 'file_ops'
  | 'shell_exec'
  | 'code_search'
  | 'conversation';
