# Agent 文字回复摘要回传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户终端交互式 claude 每轮结束时，agent 的文字回复被 LLM 摘要成一句话，回传到眼镜 status 卡片。

**Architecture:** 新增 `Stop` hook 脚本（读 `transcript_path` → 提取最后一条 assistant text → POST 给 relay daemon），daemon 调 LLM 摘要后发 `task_completed` 卡片经 Core 到眼镜。复用现有 normalizer / ws-client / Core / 眼镜，零协议改动。

**Tech Stack:** TypeScript (strict, ESM)、Node 18+ `node:test` / `node:assert/strict`、`@anthropic-ai/sdk`（已在 dependencies）、`node:crypto`（hash 去重）、`ws`（复用）。

## Global Constraints

- 不改 Core 协议（`middleware-core/` 零改动）
- 不改眼镜端代码（`rokid-sdk/` 零改动）
- 不改 `AgentBridgeClient` 消息协议（复用 `normalizer` 的 `done` → `task_completed` 映射）
- ESM：模块 import 一律带 `.js` 后缀（如 `import { summarize } from '../summarize.js'`）
- 复用且零改动：`src/normalizer.ts`、`src/types.ts`、`src/ws-client.ts`、`src/adapters/types.ts`
- LLM 环境变量沿用 `ClaudeAPIAdapter` 约定：`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`
- Windows：hook `command` 里的脚本路径用**绝对路径 + 正斜杠**
- 测试框架：`node:test` + `node:assert/strict`，测试源码放 `src/__tests__/`，编译后 `dist/__tests__/`
- JSONL assistant 事件结构（claude-code-guide 查证，2026-08）：`{ "type":"assistant", "message": { "content":[{type,text?}], "stop_reason":"end_turn" } }`。提取函数对 `message` 缺省做了兜底（`entry.message ?? entry`），若真机 dump 发现结构不同，先修 Task 1 的提取函数再继续。

---

### Task 1: `extractLastAssistantText` 提取函数

**Files:**
- Create: `agent-adapter/src/hooks/summary-relay.ts`（本任务只写提取纯函数）
- Test: `agent-adapter/src/__tests__/summary-relay.test.ts`

**Interfaces:**
- Produces: `extractLastAssistantText(jsonl: string): string` — 从 JSONL 内容提取最后一条 `end_turn` 的 assistant 文本（多个 text block 用 `\n` 拼接）；无 text 返回 `''`

- [ ] **Step 1: 写失败测试**

创建 `agent-adapter/src/__tests__/summary-relay.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLastAssistantText } from '../hooks/summary-relay.js';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

test('extracts text from last end_turn assistant', () => {
  const jsonl = [
    line({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done here' }], stop_reason: 'end_turn' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'done here');
});

test('returns empty when last assistant has no text (pure tool turn)', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'end_turn' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), '');
});

test('joins only text blocks, skipping tool_use', () => {
  const jsonl = [
    line({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'part1' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'text', text: 'part2' },
        ],
        stop_reason: 'end_turn',
      },
    }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'part1\npart2');
});

test('returns empty for empty jsonl', () => {
  assert.equal(extractLastAssistantText(''), '');
});

test('skips invalid json lines', () => {
  const jsonl = [
    'not json',
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'ok');
});

test('skips non-end_turn assistant and finds earlier end_turn', () => {
  const jsonl = [
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }], stop_reason: 'end_turn' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'ignored' }], stop_reason: 'tool_use' } }),
  ].join('\n');
  assert.equal(extractLastAssistantText(jsonl), 'first');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Cannot find module '../hooks/summary-relay.js'`

- [ ] **Step 3: 写最小实现**

创建 `agent-adapter/src/hooks/summary-relay.ts`：

```typescript
interface AssistantEvent {
  type: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

export function extractLastAssistantText(jsonl: string): string {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: AssistantEvent;
    try {
      entry = JSON.parse(line) as AssistantEvent;
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const msg = entry.message ?? entry;
    if (msg.stop_reason !== 'end_turn') continue;
    const text = (msg.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    if (text) return text;
    return '';
  }
  return '';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npx tsc && node --test dist/__tests__/summary-relay.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/hooks/summary-relay.ts agent-adapter/src/__tests__/summary-relay.test.ts
git commit -m "feat: add summary-relay JSONL text extraction"
```

---

### Task 2: `summarize` LLM 摘要函数

**Files:**
- Create: `agent-adapter/src/summarize.ts`
- Test: `agent-adapter/src/__tests__/summarize.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/sdk`（`Anthropic` client）
- Produces: `summarize(text: string, options?: SummarizeOptions, client?: ChatClient): Promise<string>`；类型 `SummarizeOptions { model?: string; timeoutMs?: number; maxLen?: number }`、`ChatClient { create(req): Promise<{ content: Array<{ type: 'text'; text: string }> }> }`

- [ ] **Step 1: 写失败测试**

创建 `agent-adapter/src/__tests__/summarize.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../summarize.js';
import type { ChatClient } from '../summarize.js';

function mockClient(result: string | Error): ChatClient {
  return {
    create: async () => {
      if (result instanceof Error) throw result;
      return { content: [{ type: 'text', text: result }] };
    },
  };
}

test('summarize returns LLM summary', async () => {
  const summary = await summarize('some long text', {}, mockClient('一句话摘要'));
  assert.equal(summary, '一句话摘要');
});

test('summarize falls back to truncation on LLM error', async () => {
  const text = 'a'.repeat(200);
  const summary = await summarize(text, { maxLen: 80 }, mockClient(new Error('boom')));
  assert.equal(summary, 'a'.repeat(80) + '…');
});

test('summarize keeps short text unchanged on error', async () => {
  const summary = await summarize('short', { maxLen: 80 }, mockClient(new Error('boom')));
  assert.equal(summary, 'short');
});

test('summarize falls back to truncation on empty LLM result', async () => {
  const text = 'b'.repeat(100);
  const summary = await summarize(text, { maxLen: 50 }, mockClient(''));
  assert.equal(summary, 'b'.repeat(50) + '…');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Cannot find module '../summarize.js'`

- [ ] **Step 3: 写最小实现**

创建 `agent-adapter/src/summarize.ts`：

```typescript
import Anthropic from '@anthropic-ai/sdk';

export interface SummarizeOptions {
  model?: string;
  timeoutMs?: number;
  maxLen?: number;
}

export interface ChatClient {
  create(request: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: 'user'; content: string }>;
  }): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_LEN = 80;

export async function summarize(
  text: string,
  options: SummarizeOptions = {},
  client?: ChatClient,
): Promise<string> {
  const model = options.model ?? process.env.AGENTBRIDGE_SUMMARY_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? Number(process.env.AGENTBRIDGE_SUMMARY_TIMEOUT ?? DEFAULT_TIMEOUT_MS);
  const maxLen = options.maxLen ?? Number(process.env.AGENTBRIDGE_SUMMARY_MAX_LEN ?? DEFAULT_MAX_LEN);

  try {
    const c = client ?? createDefaultClient();
    const resp = await withTimeout(
      c.create({
        model,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `把下面这段内容压缩成一句话摘要，保留关键信息，不超过 60 字，用原文语言回答：\n\n${text}`,
        }],
      }),
      timeoutMs,
    );
    const block = resp.content.find((b) => b.type === 'text');
    const summary = block?.text.trim() ?? '';
    return summary || truncate(text, maxLen);
  } catch {
    return truncate(text, maxLen);
  }
}

function createDefaultClient(): ChatClient {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  });
  return {
    create: (request) => anthropic.messages.create(request),
  };
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
```

> `anthropic.messages.create` 的参数类型由 SDK 导出，`ChatClient.create` 的参数声明为最小结构即可；若 TS 报类型不匹配，把 `create` 的入参类型改为 `Parameters<InstanceType<typeof Anthropic>['messages']['create']>[0]` 或 `unknown` 收窄。保持测试绿是首要目标。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npx tsc && node --test dist/__tests__/summarize.test.js`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/summarize.ts agent-adapter/src/__tests__/summarize.test.ts
git commit -m "feat: add LLM summarize with truncation fallback"
```

---

### Task 3: `summary-relay` Stop hook 入口

**Files:**
- Modify: `agent-adapter/src/hooks/summary-relay.ts`（追加 `parseHookInput` + `main()` + imports）
- Test: `agent-adapter/src/__tests__/summary-relay.test.ts`（追加 parse 测试）

**Interfaces:**
- Consumes: Task 1 的 `extractLastAssistantText`；`node:fs/promises` 的 `readFile`；全局 `fetch`
- Produces: `parseHookInput(raw: string): HookInput`；类型 `HookInput { transcriptPath: string }`

- [ ] **Step 1: 写失败测试**

在 `agent-adapter/src/__tests__/summary-relay.test.ts` 顶部 import 追加 `parseHookInput`，文件末尾追加：

```typescript
test('parseHookInput extracts transcript_path', () => {
  const input = parseHookInput(JSON.stringify({ transcript_path: '/tmp/abc.jsonl', session_id: 's1' }));
  assert.equal(input.transcriptPath, '/tmp/abc.jsonl');
});

test('parseHookInput tolerates missing transcript_path', () => {
  assert.equal(parseHookInput('{}').transcriptPath, '');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Module '../hooks/summary-relay.js' has no exported member 'parseHookInput'`

- [ ] **Step 3: 写最小实现**

在 `agent-adapter/src/hooks/summary-relay.ts` 顶部追加 import，末尾追加入口：

```typescript
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

export interface HookInput {
  transcriptPath: string;
}

export function parseHookInput(raw: string): HookInput {
  const data = JSON.parse(raw) as { transcript_path?: string };
  return { transcriptPath: data.transcript_path ?? '' };
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
  if (!input.transcriptPath) return;

  let jsonl: string;
  try {
    jsonl = await readFile(input.transcriptPath, 'utf8');
  } catch {
    return;
  }

  const text = extractLastAssistantText(jsonl);
  if (!text) return;

  const relayUrl = process.env.AGENTBRIDGE_RELAY_URL || 'http://127.0.0.1:8787';
  try {
    await fetch(`${relayUrl}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {
    // relay 不可达：静默失败，不影响 claude
  }
  process.stdout.write('{}');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npx tsc && node --test dist/__tests__/summary-relay.test.js`
Expected: 全部 PASS（含 Task 1 的提取测试）

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/hooks/summary-relay.ts agent-adapter/src/__tests__/summary-relay.test.ts
git commit -m "feat: add summary-relay Stop hook entrypoint"
```

---

### Task 4: relay daemon `/summary` 端点 + hash 去重

**Files:**
- Modify: `agent-adapter/src/relay.ts`（`ApprovalRelay` 加 `summarize` 注入 + `lastSummaryHash` + `handleSummaryText`；新增 `handleSummary`；`main()` 挂 `/summary` 路由）
- Test: `agent-adapter/src/__tests__/relay.test.ts`（追加去重 + HTTP 集成测试）

**Interfaces:**
- Consumes: Task 2 的 `summarize`（默认导入）；`node:crypto` 的 `createHash`
- Produces: `handleSummary(req, res, relay)`；`ApprovalRelayOptions` 新增可选 `summarize?: (text: string) => Promise<string>`；`ApprovalRelay.handleSummaryText(text: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

在 `agent-adapter/src/__tests__/relay.test.ts` 顶部 import 追加 `handleSummary` 与类型，文件末尾追加：

```typescript
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApprovalRelay, handleApprove, handleSummary } from '../relay.js';
import type { UnifiedMessage } from '../types.js';

test('handleSummaryText sends task_completed with summary', async () => {
  const sent: UnifiedMessage[] = [];
  const relay = new ApprovalRelay({
    sendEvent: async (m) => { sent.push(m); },
    sessionId: 'default',
    timeoutMs: 0,
    summarize: async () => 'mock summary',
  });
  await relay.handleSummaryText('some raw text');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event_type, 'task_completed');
  assert.equal(sent[0].body, 'mock summary');
});

test('handleSummaryText dedupes identical text', async () => {
  const sent: UnifiedMessage[] = [];
  const relay = new ApprovalRelay({
    sendEvent: async (m) => { sent.push(m); },
    sessionId: 'default',
    timeoutMs: 0,
    summarize: async () => 'mock summary',
  });
  await relay.handleSummaryText('same text');
  await relay.handleSummaryText('same text');
  assert.equal(sent.length, 1);
});

test('POST /summary returns 200 and sends card', async () => {
  let eventSent!: (m: UnifiedMessage) => void;
  const sentPromise = new Promise<UnifiedMessage>((r) => { eventSent = r; });
  const relay = new ApprovalRelay({
    sendEvent: async (m) => eventSent(m),
    sessionId: 'default',
    timeoutMs: 0,
    summarize: async () => 'mock summary',
  });

  const server = createServer((req, res) => { void handleSummary(req, res, relay); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;

  const resp = await fetch(`http://127.0.0.1:${port}/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'some text' }),
  });
  assert.equal(resp.status, 200);

  const msg = await sentPromise;
  assert.equal(msg.event_type, 'task_completed');
  assert.equal(msg.body, 'mock summary');

  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 报错 `Module '../relay.js' has no exported member 'handleSummary'` 或 `Property 'handleSummaryText' does not exist`

- [ ] **Step 3: 写最小实现**

在 `agent-adapter/src/relay.ts` 做如下修改：

**3a.** 顶部 import 追加：

```typescript
import { createHash } from 'node:crypto';
import { summarize as defaultSummarize } from './summarize.js';
```

**3b.** `ApprovalRelayOptions` 追加字段：

```typescript
export interface ApprovalRelayOptions {
  sendEvent: (msg: UnifiedMessage) => Promise<void>;
  sessionId: string;
  agentId?: string;
  timeoutMs?: number;
  summarize?: (text: string) => Promise<string>;
}
```

**3c.** `ApprovalRelay` 类追加字段与构造逻辑（在 `pending` 字段后）：

```typescript
private readonly summarize: (text: string) => Promise<string>;
private lastSummaryHash: string | null = null;
```

构造器内（`this.timeoutMs = ...` 之后）追加：

```typescript
this.summarize = options.summarize ?? defaultSummarize;
```

**3d.** `ApprovalRelay` 类末尾（`handleUserAction` 方法后）追加方法：

```typescript
async handleSummaryText(text: string): Promise<void> {
  const hash = createHash('sha256').update(text).digest('hex');
  if (hash === this.lastSummaryHash) return;
  this.lastSummaryHash = hash;
  const summary = await this.summarize(text);
  const msg = this.normalizer.fromAgentEvent({ type: 'done', text: summary });
  await this.sendEvent(msg);
}
```

**3e.** 在 `handleApprove` 函数之后追加 `handleSummary`：

```typescript
export interface SummaryRequestBody {
  text?: string;
}

export async function handleSummary(
  req: IncomingMessage,
  res: ServerResponse,
  relay: ApprovalRelay,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as SummaryRequestBody;
    const text = body.text ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    if (text) {
      void relay.handleSummaryText(text);
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'bad request' }));
  }
}
```

**3f.** `main()` 的 `createServer` 回调里追加 `/summary` 路由（`/approve` 分支之后）：

```typescript
if (req.method === 'POST' && req.url === '/summary') {
  void handleSummary(req, res, relay);
  return;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd agent-adapter && npx tsc && node --test dist/__tests__/relay.test.js`
Expected: 全部 PASS（含既有 relay 测试 + 新增 3 个）

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/relay.ts agent-adapter/src/__tests__/relay.test.ts
git commit -m "feat: add /summary endpoint with dedup to relay daemon"
```

---

### Task 5: 配置、脚本与文档

**Files:**
- Modify: `.claude/settings.json`（项目根）
- Modify: `agent-adapter/package.json`（`test` script 追加两个新测试）
- Modify: `CLAUDE.md`（自动镜像小节补文字摘要回传）

**Interfaces:**
- Consumes: Task 3 的 `dist/hooks/summary-relay.js`；Task 4 的 `/summary` 端点
- Produces: 无新代码接口，交付可运行配置

- [ ] **Step 1: 更新 `.claude/settings.json`**

在项目根 `.claude/settings.json` 的 `hooks` 对象里，`PreToolUse` 之后追加 `Stop` 段（保留现有 `PreToolUse` 与 `permissions` 不动）：

```json
"Stop": [
  {
    "hooks": [
      {
        "type": "command",
        "command": "node \"D:/project/5project/AgentBridge-master/agent-adapter/dist/hooks/summary-relay.js\"",
        "timeout": 30
      }
    ]
  }
]
```

- [ ] **Step 2: 更新 `agent-adapter/package.json`**

把 `test` script 追加两个测试文件（在 `approval-relay.test.js` 之后）：

```json
"test": "npm run build && node --test dist/__tests__/risk.test.js dist/__tests__/claude.test.js dist/__tests__/hub.test.js dist/__tests__/normalizer.test.js dist/__tests__/relay.test.js dist/__tests__/approval-relay.test.js dist/__tests__/summary-relay.test.js dist/__tests__/summarize.test.js"
```

- [ ] **Step 3: 更新 `CLAUDE.md`**

在「自动镜像（交互模式）」小节末尾追加一段：

> **文字摘要回传**：除审批外，每轮结束 agent 的文字回复会被 LLM 摘要成一句话，经 `Stop` hook + relay daemon 回传到眼镜 status 卡片。摘要用 DeepSeek（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 环境变量，同 `ClaudeAPIAdapter`），LLM 失败时降级为截断前 80 字。

- [ ] **Step 4: 验证**

Run:
```bash
cd agent-adapter && npm run build
node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('settings.json OK')"
cd agent-adapter && npm test
```
Expected: build 无错；`settings.json OK`；全部测试 PASS；确认 `dist/hooks/summary-relay.js` 已生成

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json agent-adapter/package.json CLAUDE.md
git commit -m "chore: wire Stop hook, tests, and docs for summary relay"
```

---

## 完成后手动验证（真机，不在本计划自动执行）

```bash
# 1. 起 Core
cd middleware-core && AGENTBRIDGE_ADDR=:8088 go run cmd/server/main.go

# 2. 起 relay daemon（带摘要 env）
cd agent-adapter && AGENTBRIDGE_URL=http://localhost:8088 AGENTBRIDGE_SESSION=default \
  AGENTBRIDGE_CORE_TIMEOUT=120000 node dist/relay.js

# 3. 用户终端正常交互式 claude（settings.json 已配 PreToolUse + Stop hook）
claude
```

| # | 场景 | 预期 |
|---|------|------|
| 1 | 让 claude 写文件并说明结果 | 眼镜收到 `task_completed` status 卡片，body 为一句话摘要 |
| 2 | 让 claude 读文件并总结内容 | 眼镜收到摘要卡片（agent 的总结文字） |
| 3 | 连续两轮不同回复 | 各自回传摘要，不串、不丢 |

> **实现前建议**：在 Task 1 的 Step 1 之前，先在本机真实 transcript（`~/.claude/projects/**/*.jsonl`）上 dump 一次 `type:"assistant"` 事件的精确结构，与 Global Constraints 里标注的结构核对。若 `content`/`stop_reason` 的嵌套层级不同，先调整 Task 1 的提取函数（它对 `message` 缺省已做兜底）。
