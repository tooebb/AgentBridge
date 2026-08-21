# 线 B 会话控制层（文字多轮）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent-adapter 的 `ClaudeCodeAdapter` 支持多轮会话（首轮 `query` + 后续 `resume`），并新增一个持久会话 daemon，使眼镜发来的文字输入能驱动同一个 Claude 会话、输出回传眼镜。这是线 B 的「会话控制层」，不含语音（语音在第二个计划）。

**Architecture:** 三层改动——(1) `ClaudeCodeAdapter.send()` 持久化 `session_id` 并对 `user_message` 输入走 `resume`；(2) 新增 `SessionBridge` 可测类 + `session.ts` 入口，作为持久会话 daemon，桥接 Core 的 `user_action`（文字/审批）与 adapter；(3) 验证文字输入 + 多轮上下文 + 审批闭环在 Core 层面端到端跑通（不碰眼镜，用 PC 端注入文字模拟）。

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` v0.3.232, Node 22, node:test + assert.

## Global Constraints

- 不改 AgentBridge 消息协议（`ClientMessage`/`ClientAction`/`UnifiedMessage` 结构不变）；文字输入复用现有 `ClientAction.text` 字段（`ws-client.ts` 已透传 `user_action.text`）。
- 不改 Core（Go）；adapter↔Core 沿用现有通道：事件走 REST `POST /api/v1/events`，用户动作走 WS `user_action`。
- 审批链路不变：`canUseTool` → `needs_approval` → 眼镜 approve/reject → `handleUserAction`。
- 线 A（hook 镜像 `relay.ts`）不受影响，保持现状。
- 依赖不新增（`claude-agent-sdk`、`ws`、`typescript` 已有）。

---

### Task 1: ClaudeCodeAdapter 多轮 resume

**Files:**
- Modify: `agent-adapter/src/adapters/claude.ts`
- Test: `agent-adapter/src/__tests__/claude.test.ts`

**Interfaces:**
- Consumes: `SDKMessage`（带 `session_id`）、`Options.resume?: string`、现有 `ClaudeQueryFactory`
- Produces: `ClaudeCodeAdapter` 新增私有字段 `lastSessionId: string | null`；`send()` 对 `type === 'user_message'` 且已有 `lastSessionId` 的输入，在 `options.resume` 传入上一次的 `session_id`

- [ ] **Step 1: 写失败测试**

在 `claude.test.ts` 末尾追加：

```typescript
test('ClaudeCodeAdapter resumes session for user_message inputs', async () => {
  const resumeIds: (string | undefined)[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    queryFactory: ({ options }) => {
      resumeIds.push(options?.resume);
      const q = (async function* () {
        yield sdkInit('session-abc');
        yield sdkResult('session-abc', 'done');
      })() as Query;
      q.close = () => undefined;
      return q;
    },
  });

  for await (const _ of adapter.send({ type: 'start_task', text: 'first', sessionId: 'session-1' })) {}
  for await (const _ of adapter.send({ type: 'user_message', text: 'second', sessionId: 'session-1' })) {}

  assert.deepEqual(resumeIds, [undefined, 'session-abc']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm test`
Expected: FAIL — `resumeIds` 实际为 `[undefined, undefined]`，因为 `send()` 尚未传 `resume`。

- [ ] **Step 3: 实现 resume**

在 `adapters/claude.ts`：

1. 类里加字段（`currentTaskId` 附近）：
```typescript
private lastSessionId: string | null = null;
```

2. `send()` 里把 options 抽成变量并在 user_message 时补 `resume`。将现有 `q = this.queryFactory({ prompt: ..., options: { abortController, canUseTool, cwd, env, pathToClaudeCodeExecutable, permissionMode: 'default' } })` 改为：
```typescript
const options: Options = {
  abortController,
  canUseTool: this.canUseTool,
  cwd: process.cwd(),
  env: claudeRuntimeEnv(),
  pathToClaudeCodeExecutable: this.claudePath,
  permissionMode: 'default',
};
if (input.type === 'user_message' && this.lastSessionId) {
  options.resume = this.lastSessionId;
}
q = this.queryFactory({ prompt: input.text || this.inputFallbackText(input), options });
```

3. 在 `for await (const message of q!)` 循环开头捕获 session_id（在 `mapClaudeSDKMessage` 之前）：
```typescript
if ('session_id' in message && message.session_id) {
  this.lastSessionId = message.session_id;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 全绿（新增测试 PASS，其余 claude/hub/risk/normalizer 测试仍 PASS）。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/adapters/claude.ts agent-adapter/src/__tests__/claude.test.ts
git commit -m "feat(adapter): resume same session for multi-turn user messages"
```

---

### Task 2: SessionBridge 持久会话 daemon

**Files:**
- Create: `agent-adapter/src/session.ts`
- Test: `agent-adapter/src/__tests__/session.test.ts`

**Interfaces:**
- Consumes: `ClaudeCodeAdapter`（Task 1）、`AgentBridgeClient`（`ws-client.js`）、`EventNormalizer`
- Produces: `SessionBridge` 类（可测）— `handleUserAction(action)` 按 `type` 分流（`user_message` → 驱动 `send`；`approve`/`reject`/`continue` → `adapter.handleUserAction`）；`session.ts` 入口 `main()` 把 `SessionBridge` 接到真实 `AgentBridgeClient`

- [ ] **Step 1: 写失败测试**

`session.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionBridge } from '../session.js';
import type { AgentEvent } from '../adapters/types.js';

test('SessionBridge routes user_message to send and approve to handleUserAction', async () => {
  const sent: string[] = [];
  const handled: string[] = [];
  const bridge = new SessionBridge({
    adapter: {
      async *send(input: any) {
        sent.push(input.text);
        yield { type: 'text', content: `echo ${input.text}` } satisfies AgentEvent;
      },
      async handleUserAction(action: any) {
        handled.push(action.type);
      },
    } as any,
    sendEvent: async () => {},
  });

  await bridge.handleUserAction({ type: 'user_message', text: 'hello', taskId: 't1' });
  await bridge.handleUserAction({ type: 'approve', taskId: 't1' });

  assert.deepEqual(sent, ['hello']);
  assert.deepEqual(handled, ['approve']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm test`
Expected: FAIL — 找不到 `../session.js`（模块不存在）。

- [ ] **Step 3: 实现 SessionBridge + session.ts**

`session.ts`：

```typescript
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { AgentBridgeClient } from './ws-client.js';
import { EventNormalizer } from './normalizer.js';
import type { AgentEvent, AgentInput, DeviceAction } from './adapters/types.js';

export interface SessionBridgeOptions {
  adapter: { send(input: AgentInput): AsyncIterable<AgentEvent>; handleUserAction(action: DeviceAction): Promise<void> };
  sendEvent: (msg: unknown) => Promise<void>;
}

export class SessionBridge {
  private readonly adapter: SessionBridgeOptions['adapter'];
  private readonly sendEvent: SessionBridgeOptions['sendEvent'];
  private running = false;

  constructor(options: SessionBridgeOptions) {
    this.adapter = options.adapter;
    this.sendEvent = options.sendEvent;
  }

  async handleUserAction(action: { type: string; taskId?: string; text?: string; deviceType?: string }): Promise<void> {
    if (action.type === 'user_message') {
      await this.driveAgent({ type: 'user_message', text: action.text ?? '', sessionId: undefined });
      return;
    }
    await this.adapter.handleUserAction({
      type: action.type,
      taskId: action.taskId,
      deviceType: action.deviceType ?? 'glasses',
      text: action.text,
    });
  }

  private async driveAgent(input: AgentInput): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for await (const event of this.adapter.send(input)) {
        await this.sendEvent(event);
      }
    } finally {
      this.running = false;
    }
  }
}

export async function main(): Promise<void> {
  const serverUrl = process.env.AGENTBRIDGE_URL || 'http://localhost:8088';
  const sessionId = process.env.AGENTBRIDGE_SESSION || 'default';
  const claudePath = process.env.CLAUDE_PATH || 'claude';

  const wsClient = new AgentBridgeClient({ serverUrl, sessionId });
  const adapter = new ClaudeCodeAdapter({ claudePath, sessionId });
  const normalizer = new EventNormalizer(sessionId, adapter.name);
  const bridge = new SessionBridge({
    adapter,
    sendEvent: (event) => wsClient.sendEvent(normalizer.fromAgentEvent(event as AgentEvent)),
  });

  wsClient.on('user_action', (action) => bridge.handleUserAction(action as { type: string; taskId?: string; text?: string }));
  wsClient.on('error', (err) => console.error('[session] ws error:', err.message));
  wsClient.connect();
}

if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  void main();
}
```

在 `package.json` 的 `scripts` 加：`"start:session": "node dist/session.js"`，并加进 `test` 脚本列表：`dist/__tests__/session.test.js`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/session.ts agent-adapter/src/__tests__/session.test.ts agent-adapter/package.json
git commit -m "feat(adapter): add persistent session bridge daemon for line B"
```

---

### Task 3: 文字输入多轮 E2E（Core 层面，不碰眼镜）

**Files:**
- 无代码改动（验证用）；如需可在 `agent-adapter/src/__tests__/session.test.ts` 补集成断言

**Interfaces:**
- Consumes: Task 1 + Task 2 产物；真实 Core（`AGENTBRIDGE_ADDR=":8088"`）
- Produces: 验证「文字输入 → 多轮上下文保留 → 文字输出回传」

- [ ] **Step 1: 起 Core 与 session daemon**

```bash
cd middleware-core && AGENTBRIDGE_ADDR=":8088" go run cmd/server/main.go
cd agent-adapter && npm run build && AGENTBRIDGE_URL=http://127.0.0.1:8088 AGENTBRIDGE_SESSION=default npm run start:session
```

- [ ] **Step 2: 向 Core 注入第一条 user_message（模拟眼镜发文字）**

用 curl 或 mock-device 向 Core 发一条 `user_action`（type=`user_message`，text=`记住数字 42，回复 ok`）。观察 session daemon 日志：应打印 `echo ...`/事件转发，且 Core 收到 `task_completed`。

- [ ] **Step 3: 注入第二条 user_message 验证上下文**

再发 `user_message`（text=`我刚才说的数字是几`）。观察 daemon 日志应出现 `42`，证明 `resume` 保留上下文（等价于 spike 结论，但走完整 Core 链路）。

- [ ] **Step 4: 验证审批仍走眼镜（复用现有链路）**

发一条会触发高风险工具的 `user_message`（如 `写一个 test.md`），确认 Core 收到 `needs_approval`，且 approve/reject 动作能经现有 `user_action` → `handleUserAction` 链路回传。

- [ ] **Step 5: Commit（如补了断言/文档）**

```bash
git add -A
git commit -m "test(adapter): E2E multi-turn session via Core"
```

---

## 完成后

三个任务产出可独立验证的「会话控制层」：adapter 多轮 resume + 持久会话 daemon + 文字输入多轮闭环。语音输入（麦克风 + 音频通道 + STT）留待第二个计划 `2026-08-21-line-b-voice-input-plan.md`。
