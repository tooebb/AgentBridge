# 自动镜像交互模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在终端交互式使用 Claude Code 时，每次高风险工具审批自动镜像到眼镜，决定回传后工具才执行。

**Architecture:** Claude Code `PreToolUse` hook（同步阻塞）在工具执行前 spawn 短命 hook 脚本；hook 脚本算风险后 HTTP POST 到一个长驻 relay daemon；daemon 持唯一 `agent_adapter` WS 连接，把 `needs_approval`（task_id = tool_use_id）发到 Core → 眼镜，等用户 approve/reject 后回传决定。

**Tech Stack:** TypeScript (strict, ESM), Node 18 `node:http` / `node:test` / `node:assert/strict`, `ws`（复用 `ws-client.ts`）。

## Global Constraints

- 不改 Core 协议（`middleware-core/` 零改动）
- 不改眼镜端代码（`rokid-sdk/` 零改动）
- 关联键：`tool_use_id` 复用为 `task_id`（透传字符串，Core 只做同 key 关联 + 去重）
- 复用且零改动：`src/risk.ts`、`src/normalizer.ts`、`src/ws-client.ts`、`src/types.ts`、`src/adapters/types.ts`
- 超时层级：daemon 审批超时 `AGENTBRIDGE_CORE_TIMEOUT`（默认 120000ms）< hook 命令 `timeout`（180s）< Claude Code 默认上限 600s
- 决策 1（已定）：`--bare` / `disableAllHooks` 逃逸口**不封堵**，仅文档记录
- 决策 2（已定）：审批超时 **auto-allow**（放行）
- ESM：模块 import 一律带 `.js` 后缀（如 `import { assessRisk } from '../risk.js'`）
- 测试框架：`node:test` + `node:assert/strict`，测试源码放 `src/__tests__/`，编译后 `dist/__tests__/`
- Windows：hook `command` 里的脚本路径用**绝对路径 + 正斜杠**（`node D:/project/.../approval-relay.js`）

---

## File Structure

**新建：**
- `agent-adapter/src/relay.ts` — relay daemon：`ApprovalRelay` 核心类（审批关联 + 超时）+ HTTP 服务 + `main()` 入口
- `agent-adapter/src/hooks/approval-relay.ts` — PreToolUse hook 脚本：stdin 解析 → assessRisk → HTTP → stdout 决定
- `agent-adapter/src/__tests__/relay.test.ts` — daemon 核心 + HTTP 测试
- `agent-adapter/src/__tests__/approval-relay.test.ts` — hook 脚本纯函数测试
- `.claude/settings.json`（项目根）— hook 配置 + `permissions.allow`

**修改：**
- `agent-adapter/package.json` — `test` script 加两个新测试；新增 `start:relay` script
- `CLAUDE.md` — 记录自动镜像用法 + 安全逃逸口

**复用（零改动）：** `src/risk.ts`、`src/normalizer.ts`、`src/ws-client.ts`、`src/types.ts`、`src/adapters/types.ts`

---

### Task 1: ApprovalRelay 核心类（审批关联 + 超时）

**Files:**
- Create: `agent-adapter/src/relay.ts`（本任务只写核心类，不含 HTTP / main）
- Test: `agent-adapter/src/__tests__/relay.test.ts`

**Interfaces:**
- Consumes: `EventNormalizer`（`src/normalizer.ts`，`fromAgentEvent(event: AgentEvent): UnifiedMessage`）；`UnifiedMessage`（`src/types.ts`）；`AgentEvent`（`src/adapters/types.ts`，`needs_approval` 变体含 `tool`/`risk`/`taskId`/`input`）
- Produces: `ApprovalRelay` 类，导出类型 `Decision`、`ApprovalRequest`、`UserActionPayload`、`ApprovalRelayOptions`；方法 `requestApproval(req: ApprovalRequest): Promise<Decision>`、`handleUserAction(action: UserActionPayload): void`（后续 Task 2 的 HTTP 层消费）

- [ ] **Step 1: 写失败测试**

创建 `agent-adapter/src/__tests__/relay.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalRelay } from '../relay.js';
import type { UnifiedMessage } from '../types.js';

function makeRelay(timeoutMs: number, sent: UnifiedMessage[] = []) {
  const relay = new ApprovalRelay({
    sendEvent: async (msg) => { sent.push(msg); },
    sessionId: 'default',
    timeoutMs,
  });
  return { relay, sent };
}

const req = { toolUseId: 'tu_1', toolName: 'Write', toolInput: { file_path: 'x.txt' }, risk: 0.4 };

test('requestApproval sends needs_approval with task_id = toolUseId', async () => {
  const { relay, sent } = makeRelay(0);
  const p = relay.requestApproval(req);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event_type, 'needs_approval');
  assert.equal(sent[0].task_id, 'tu_1');
  assert.equal(sent[0].risk_score, 0.4);
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });
  assert.equal(await p, 'allow');
});

test('handleUserAction approve resolves allow', async () => {
  const { relay } = makeRelay(0);
  const p = relay.requestApproval(req);
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });
  assert.equal(await p, 'allow');
});

test('handleUserAction reject resolves deny', async () => {
  const { relay } = makeRelay(0);
  const p = relay.requestApproval(req);
  relay.handleUserAction({ type: 'reject', taskId: 'tu_1' });
  assert.equal(await p, 'deny');
});

test('non-decision action does not resolve', async () => {
  const { relay } = makeRelay(0);
  const p = relay.requestApproval(req);
  relay.handleUserAction({ type: 'view_details', taskId: 'tu_1' });
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });
  assert.equal(await p, 'allow');
});

test('timeout auto-allows', async () => {
  const { relay } = makeRelay(30);
  const p = relay.requestApproval(req);
  assert.equal(await p, 'allow');
});

test('concurrent requests resolve independently', async () => {
  const { relay } = makeRelay(0);
  const p1 = relay.requestApproval({ ...req, toolUseId: 'tu_a' });
  const p2 = relay.requestApproval({ ...req, toolUseId: 'tu_b' });
  relay.handleUserAction({ type: 'reject', taskId: 'tu_a' });
  relay.handleUserAction({ type: 'approve', taskId: 'tu_b' });
  assert.equal(await p1, 'deny');
  assert.equal(await p2, 'allow');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Cannot find module '../relay.js'`（文件不存在）

- [ ] **Step 3: 写最小实现**

创建 `agent-adapter/src/relay.ts`（本任务只写核心类）：

```typescript
import { EventNormalizer } from './normalizer.js';
import type { UnifiedMessage } from './types.js';
import type { AgentEvent } from './adapters/types.js';

export type Decision = 'allow' | 'deny';

export interface ApprovalRequest {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  risk: number;
  cwd?: string;
}

export interface UserActionPayload {
  type: string;
  taskId?: string;
}

export interface ApprovalRelayOptions {
  sendEvent: (msg: UnifiedMessage) => Promise<void>;
  sessionId: string;
  agentId?: string;
  timeoutMs?: number;
}

interface PendingApproval {
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout | null;
}

export class ApprovalRelay {
  private readonly sendEvent: (msg: UnifiedMessage) => Promise<void>;
  private readonly normalizer: EventNormalizer;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(options: ApprovalRelayOptions) {
    this.sendEvent = options.sendEvent;
    this.normalizer = new EventNormalizer(options.sessionId, options.agentId ?? 'claude-code');
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  requestApproval(req: ApprovalRequest): Promise<Decision> {
    const event: AgentEvent = {
      type: 'needs_approval',
      tool: req.toolName,
      risk: req.risk,
      taskId: req.toolUseId,
      input: req.toolInput,
    };
    const msg = this.normalizer.fromAgentEvent(event);
    void this.sendEvent(msg);

    return new Promise<Decision>((resolve) => {
      const timer = this.timeoutMs > 0
        ? setTimeout(() => {
            if (this.pending.has(req.toolUseId)) {
              this.pending.delete(req.toolUseId);
              resolve('allow');
            }
          }, this.timeoutMs)
        : null;
      this.pending.set(req.toolUseId, { resolve, timer });
    });
  }

  handleUserAction(action: UserActionPayload): void {
    const taskId = action.taskId;
    if (!taskId) return;
    const pending = this.pending.get(taskId);
    if (!pending) return;

    if (action.type === 'approve' || action.type === 'continue') {
      this.pending.delete(taskId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve('allow');
    } else if (action.type === 'reject') {
      this.pending.delete(taskId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve('deny');
    }
    // view_details / pause 等非决策动作：不 resolve，保持 pending
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 新增 `relay.test.js` 全部 PASS（含既有 4 个测试文件仍 PASS）

- [ ] **Step 5: 提交**

```bash
git add agent-adapter/src/relay.ts agent-adapter/src/__tests__/relay.test.ts
git commit -m "feat: add ApprovalRelay core (approval correlation + timeout)"
```

---

### Task 2: relay daemon HTTP 服务 + 入口

**Files:**
- Modify: `agent-adapter/src/relay.ts`（追加 HTTP 层 + `main()`）
- Test: `agent-adapter/src/__tests__/relay.test.ts`（追加 HTTP 集成测试）

**Interfaces:**
- Consumes: Task 1 的 `ApprovalRelay`、`AgentBridgeClient`（`src/ws-client.ts`：`connect()`、`sendEvent(msg)`、`on('user_action', cb)`）
- Produces: 导出 `handleApprove(req, res, relay)`、`ApprovalRequestBody`、`main()`；HTTP 协议 `POST /approve`，body `{ tool_use_id, tool_name, tool_input?, risk?, cwd? }`，响应 200 `{ decision: 'allow'|'deny' }`（Task 3 的 hook 脚本消费此协议）

- [ ] **Step 1: 写失败测试**

在 `agent-adapter/src/__tests__/relay.test.ts` 顶部追加 import，文件末尾追加测试：

```typescript
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApprovalRelay, handleApprove } from '../relay.js';

test('POST /approve returns allow after user action', async () => {
  let eventSent!: () => void;
  const eventSentPromise = new Promise<void>((r) => { eventSent = r; });

  const relay = new ApprovalRelay({
    sendEvent: async () => { eventSent(); },
    sessionId: 'default',
    timeoutMs: 0,
  });

  const server = createServer((req, res) => { void handleApprove(req, res, relay); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const respPromise = fetch(`http://127.0.0.1:${port}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool_use_id: 'tu_1', tool_name: 'Write', tool_input: { file_path: 'x' }, risk: 0.4, cwd: '/tmp' }),
  });

  await eventSentPromise;
  relay.handleUserAction({ type: 'approve', taskId: 'tu_1' });

  const resp = await respPromise;
  const body = await resp.json() as { decision: string };
  assert.equal(resp.status, 200);
  assert.equal(body.decision, 'allow');

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Module '../relay.js' has no exported member 'handleApprove'`

- [ ] **Step 3: 写最小实现**

在 `agent-adapter/src/relay.ts` 追加（在 `ApprovalRelay` 类之后）：

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AgentBridgeClient } from './ws-client.js';

export interface ApprovalRequestBody {
  tool_use_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  risk?: number;
  cwd?: string;
}

export async function handleApprove(
  req: IncomingMessage,
  res: ServerResponse,
  relay: ApprovalRelay,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as ApprovalRequestBody;
    const decision = await relay.requestApproval({
      toolUseId: body.tool_use_id,
      toolName: body.tool_name,
      toolInput: body.tool_input ?? {},
      risk: body.risk ?? 0,
      cwd: body.cwd,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ decision }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function main(): Promise<void> {
  const port = Number(process.env.RELAY_PORT || 8787);
  const serverUrl = process.env.AGENTBRIDGE_URL || 'http://localhost:8088';
  const sessionId = process.env.AGENTBRIDGE_SESSION || 'default';
  const timeoutMs = Number(process.env.AGENTBRIDGE_CORE_TIMEOUT || 120_000);

  const wsClient = new AgentBridgeClient({ serverUrl, sessionId });
  const relay = new ApprovalRelay({
    sendEvent: (msg) => wsClient.sendEvent(msg),
    sessionId,
    timeoutMs,
  });

  wsClient.on('user_action', (action) => relay.handleUserAction(action));
  wsClient.connect();

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/approve') {
      void handleApprove(req, res, relay);
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, () => {
    console.log(`[relay] listening on http://127.0.0.1:${port} (session=${sessionId})`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: `relay.test.js` 全部 PASS（核心 + HTTP）

- [ ] **Step 5: 提交**

```bash
git add agent-adapter/src/relay.ts agent-adapter/src/__tests__/relay.test.ts
git commit -m "feat: add relay daemon HTTP server + entrypoint"
```

---

### Task 3: PreToolUse hook 脚本

**Files:**
- Create: `agent-adapter/src/hooks/approval-relay.ts`
- Test: `agent-adapter/src/__tests__/approval-relay.test.ts`

**Interfaces:**
- Consumes: `assessRisk`、`DEFAULT_RISK_THRESHOLD`（`src/risk.ts`）；Task 2 的 HTTP 协议 `POST /approve`
- Produces: 导出 `parseHookInput(raw: string): HookInput`、`permissionDecisionOutput(decision, reason): string`、类型 `HookInput`

- [ ] **Step 1: 写失败测试**

创建 `agent-adapter/src/__tests__/approval-relay.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, permissionDecisionOutput } from '../hooks/approval-relay.js';

test('parseHookInput extracts tool fields from stdin JSON', () => {
  const raw = JSON.stringify({
    session_id: 's1',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /tmp/x' },
    tool_use_id: 'tu_9',
    cwd: '/repo',
  });
  const input = parseHookInput(raw);
  assert.equal(input.toolName, 'Bash');
  assert.deepEqual(input.toolInput, { command: 'rm -rf /tmp/x' });
  assert.equal(input.toolUseId, 'tu_9');
  assert.equal(input.cwd, '/repo');
});

test('parseHookInput tolerates missing fields', () => {
  const input = parseHookInput('{}');
  assert.equal(input.toolName, '');
  assert.deepEqual(input.toolInput, {});
  assert.equal(input.toolUseId, '');
  assert.equal(input.cwd, undefined);
});

test('permissionDecisionOutput emits hook JSON', () => {
  const out = permissionDecisionOutput('allow', 'approved from glasses');
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'approved from glasses');
});

test('permissionDecisionOutput emits deny', () => {
  const parsed = JSON.parse(permissionDecisionOutput('deny', 'rejected'));
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Cannot find module '../hooks/approval-relay.js'`

- [ ] **Step 3: 写最小实现**

创建 `agent-adapter/src/hooks/approval-relay.ts`：

```typescript
import { pathToFileURL } from 'node:url';
import { assessRisk, DEFAULT_RISK_THRESHOLD } from '../risk.js';

export interface HookInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  cwd?: string;
}

export function parseHookInput(raw: string): HookInput {
  const data = JSON.parse(raw) as {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_use_id?: string;
    cwd?: string;
  };
  return {
    toolName: data.tool_name ?? '',
    toolInput: data.tool_input ?? {},
    toolUseId: data.tool_use_id ?? '',
    cwd: data.cwd,
  };
}

export function permissionDecisionOutput(decision: 'allow' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const threshold = Number(process.env.AGENTBRIDGE_RISK_THRESHOLD || DEFAULT_RISK_THRESHOLD);
  const risk = assessRisk(input.toolName, input.toolInput);

  if (risk < threshold) {
    process.stdout.write(permissionDecisionOutput('allow', `low risk (${risk})`));
    return;
  }

  const relayUrl = process.env.AGENTBRIDGE_RELAY_URL || 'http://127.0.0.1:8787';
  try {
    const resp = await fetch(`${relayUrl}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_use_id: input.toolUseId,
        tool_name: input.toolName,
        tool_input: input.toolInput,
        risk,
        cwd: input.cwd,
      }),
    });
    if (!resp.ok) {
      process.stdout.write(permissionDecisionOutput('allow', `relay error ${resp.status}`));
      return;
    }
    const body = await resp.json() as { decision?: string };
    const decision = body.decision === 'deny' ? 'deny' : 'allow';
    process.stdout.write(permissionDecisionOutput(
      decision,
      decision === 'allow' ? 'approved from glasses' : 'rejected from glasses',
    ));
  } catch (err) {
    process.stdout.write(permissionDecisionOutput(
      'allow',
      `relay unreachable: ${err instanceof Error ? err.message : 'error'}`,
    ));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: `approval-relay.test.js` 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add agent-adapter/src/hooks/approval-relay.ts agent-adapter/src/__tests__/approval-relay.test.ts
git commit -m "feat: add PreToolUse approval-relay hook script"
```

---

### Task 4: 配置、脚本与文档

**Files:**
- Create: `.claude/settings.json`（项目根）
- Modify: `agent-adapter/package.json`（`test` script、新增 `start:relay`）
- Modify: `CLAUDE.md`（自动镜像用法 + 安全逃逸口）

**Interfaces:**
- Consumes: Task 3 的 hook 脚本编译产物 `dist/hooks/approval-relay.js`；Task 2 的 daemon 入口 `dist/relay.js`
- Produces: 无新代码接口，交付可运行的配置

- [ ] **Step 1: 更新 package.json**

在 `agent-adapter/package.json` 的 `scripts` 中：

- `test` 改为（追加两个新测试文件）：

```json
"test": "npm run build && node --test dist/__tests__/risk.test.js dist/__tests__/claude.test.js dist/__tests__/hub.test.js dist/__tests__/normalizer.test.js dist/__tests__/relay.test.js dist/__tests__/approval-relay.test.js"
```

- 新增（放在 `start` 之后）：

```json
"start:relay": "node dist/relay.js"
```

- [ ] **Step 2: 创建 .claude/settings.json**

在项目根创建 `.claude/settings.json`（路径按实际项目绝对路径，正斜杠）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node \"D:/project/5project/AgentBridge-master/agent-adapter/dist/hooks/approval-relay.js\"",
            "timeout": 180
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": ["Bash", "Edit", "Write"]
  }
}
```

- [ ] **Step 3: 更新 CLAUDE.md**

在 `CLAUDE.md` 的「当前状态」下追加「自动镜像（交互模式）」小节，内容含：

1. 用法：起 Core + `npm run start:relay`，然后用户终端正常 `claude`，高风险工具自动镜像到眼镜审批
2. 安全逃逸口警示（来自 spec §8.3，逐字）：

> 自动镜像依赖 Claude Code hook。若以 `--bare` 或 `--settings '{"disableAllHooks":true}'` 启动 claude，hook 不加载，眼镜将不会收到审批卡片。这是 Claude Code 的 CLI 设计，非 AgentBridge 可封堵；请勿在需要眼镜监督的场景下使用这些参数。

- [ ] **Step 4: 验证**

Run:
```bash
cd agent-adapter && npm run build
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('settings.json OK')"
cd agent-adapter && npm test
```
Expected: build 无错；`settings.json OK`；全部测试 PASS；确认 `dist/hooks/approval-relay.js` 与 `dist/relay.js` 已生成

- [ ] **Step 5: 提交**

```bash
git add .claude/settings.json agent-adapter/package.json CLAUDE.md
git commit -m "chore: wire PreToolUse hook settings, scripts, and docs"
```

---

## 完成后手动验证（真机，不在本计划自动执行）

```bash
# 1. 起 Core
cd middleware-core && AGENTBRIDGE_ADDR=:8088 go run cmd/server/main.go

# 2. 起 relay daemon
cd agent-adapter && AGENTBRIDGE_URL=http://localhost:8088 AGENTBRIDGE_SESSION=default \
  AGENTBRIDGE_CORE_TIMEOUT=120000 npm run start:relay

# 3. 用户终端正常交互式 claude（settings.json 已配 hook）
claude
```

四场景：①只读工具静默 ②Write 单击 approve 执行 ③Bash rm 双击 reject ④高风险不操作 120s auto-allow。
