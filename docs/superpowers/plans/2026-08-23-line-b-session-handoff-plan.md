# 线 B 会话交接（Session Handoff）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让眼镜语音 daemon 的 claude 用 `cwd=项目根` + `resume=项目最近会话` 续上 PC 终端里开好的任务，实现顺序交接。

**Architecture:** 新增纯函数模块 `session-resolver.ts`（cwd 编码 + 最近会话定位），改 `ClaudeCodeAdapter` 支持可配置 cwd 与初始 resume。Core / 眼镜 / 协议零改动。

**Tech Stack:** TypeScript（Node 22+），node:test + node:assert/strict，Claude Code SDK。

## 全局约束

- 不改 Core 协议、不改 AgentBridgeClient 消息协议、审批链路（canUseTool → needs_approval → approve/reject）不变。
- `session.ts` 的 `main()` 不改；adapter 在构造器读 env 兜底。
- 编码规则：`\` 和 `:` → `-`，仅覆盖 ASCII 路径。
- 顺序交接（非并发）：PC 终端 claude 退出后 daemon 才 resume。

---

### Task 1: session 解析模块 `session-resolver.ts`

**Files:**
- Create: `agent-adapter/src/session-resolver.ts`
- Test: `agent-adapter/src/__tests__/session-resolver.test.ts`
- Modify: `agent-adapter/package.json`（`test` 脚本加 `dist/__tests__/session-resolver.test.js`）

**Interfaces:**
- Consumes: 无（独立模块，仅依赖 node:fs / node:path / node:os）。
- Produces:
  - `encodeProjectDir(cwd: string): string` — 把 `\`、`:` 替换为 `-`。
  - `resolveLatestSessionId(cwd: string, projectsRoot?: string): string | null` — 在 `projectsRoot/<编码cwd>/` 里取 mtime 最新的 `.jsonl` 文件名（去 `.jsonl` 后缀）作为 session id；目录不存在或无文件返回 `null`。默认 `projectsRoot = join(homedir(), '.claude', 'projects')`。

- [ ] **Step 1: 写失败测试**

`agent-adapter/src/__tests__/session-resolver.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, resolveLatestSessionId } from '../session-resolver.js';

test('encodeProjectDir replaces backslashes and colons with dashes', () => {
  assert.equal(
    encodeProjectDir('D:\\project\\5project\\AgentBridge-master'),
    'D--project-5project-AgentBridge-master',
  );
  assert.equal(
    encodeProjectDir('D:\\project\\5project\\AgentBridge-master\\agent-adapter'),
    'D--project-5project-AgentBridge-master-agent-adapter',
  );
});

test('resolveLatestSessionId returns null when project has no sessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'abr-sessions-'));
  try {
    assert.equal(resolveLatestSessionId('D:\\no\\such\\project', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveLatestSessionId returns the most recently modified session', () => {
  const root = mkdtempSync(join(tmpdir(), 'abr-sessions-'));
  try {
    const dir = join(root, 'D--proj');
    mkdirSync(dir, { recursive: true });
    const older = join(dir, '11111111-1111-1111-1111-111111111111.jsonl');
    const newer = join(dir, '22222222-2222-2222-2222-222222222222.jsonl');
    writeFileSync(older, '{}\n');
    writeFileSync(newer, '{}\n');
    const now = new Date();
    utimesSync(older, now, new Date(now.getTime() - 10000));
    utimesSync(newer, now, new Date(now.getTime()));
    assert.equal(
      resolveLatestSessionId('D:\\proj', root),
      '22222222-2222-2222-2222-222222222222',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑构建验证失败**

Run: `cd agent-adapter && npm run build`
Expected: FAIL，tsc 报 `Cannot find module '../session-resolver.js'`（模块尚不存在，证明功能缺失）。

- [ ] **Step 3: 写最小实现**

`agent-adapter/src/session-resolver.ts`：

```typescript
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[\\:]/g, '-');
}

export function resolveLatestSessionId(
  cwd: string,
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): string | null {
  const dir = join(projectsRoot, encodeProjectDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let latest: { id: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = join(dir, name);
    try {
      const mtime = statSync(file).mtimeMs;
      if (!latest || mtime > latest.mtime) {
        latest = { id: name.slice(0, -'.jsonl'.length), mtime };
      }
    } catch {
      // 单个文件读不到就跳过
    }
  }
  return latest?.id ?? null;
}
```

- [ ] **Step 4: 把新测试加进 test 脚本**

`agent-adapter/package.json` 的 `test` 脚本末尾（`dist/__tests__/stt.test.js` 后）加 ` dist/__tests__/session-resolver.test.js`。

- [ ] **Step 5: 跑测试验证通过**

Run: `cd agent-adapter && npm run build && node --test dist/__tests__/session-resolver.test.js`
Expected: PASS（3 个测试全绿）。

- [ ] **Step 6: Commit**

```bash
git add agent-adapter/src/session-resolver.ts agent-adapter/src/__tests__/session-resolver.test.ts agent-adapter/package.json
git commit -m "feat: add session resolver (cwd encoding + latest session lookup)"
```

---

### Task 2: `ClaudeCodeAdapter` 支持 cwd + 初始 resume

**Files:**
- Modify: `agent-adapter/src/adapters/claude.ts`
- Test: `agent-adapter/src/__tests__/claude.test.ts`

**Interfaces:**
- Consumes: `resolveLatestSessionId`（Task 1）。
- Produces: `ClaudeAdapterOptions` 新增 `cwd?: string`、`initialSessionId?: string`；构造器读 env `AGENTBRIDGE_CWD` / `AGENTBRIDGE_RESUME_SESSION` 兜底。

- [ ] **Step 1: 写失败测试（新增一条 + 强化一条）**

在 `agent-adapter/src/__tests__/claude.test.ts` 末尾（`settlesWithin` 之前）新增：

```typescript
test('ClaudeCodeAdapter uses configured cwd and resumes initial session on first user_message', async () => {
  const seen: { cwd?: string; resume?: string }[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    cwd: 'C:\\proj',
    initialSessionId: 'pc-session-123',
    queryFactory: ({ options }) => {
      seen.push({ cwd: options?.cwd, resume: options?.resume });
      const q = (async function* () {
        yield sdkInit('pc-session-123');
        yield sdkResult('pc-session-123', 'done');
      })() as Query;
      q.close = () => undefined;
      return q;
    },
  });

  for await (const _ of adapter.send({ type: 'user_message', text: 'continue', sessionId: 'session-1' })) {}

  assert.deepEqual(seen, [{ cwd: 'C:\\proj', resume: 'pc-session-123' }]);
});
```

同时把现有的 `ClaudeCodeAdapter resumes session for user_message inputs` 测试改成注入 `cwd` + `initialSessionId`（证明 `lastSessionId` 优先级高于 `initialSessionId`）：

```typescript
test('ClaudeCodeAdapter resumes session for user_message inputs', async () => {
  const resumeIds: (string | undefined)[] = [];
  const adapter = new ClaudeCodeAdapter({
    sessionId: 'session-1',
    cwd: 'C:\\nonexistent',
    initialSessionId: 'pc-session-123',
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

- [ ] **Step 2: 跑构建验证失败**

Run: `cd agent-adapter && npm run build`
Expected: FAIL，tsc 报 `Object literal may only specify known properties ... 'cwd'/'initialSessionId'`（`ClaudeAdapterOptions` 还没有这两个字段，证明功能缺失）。

- [ ] **Step 3: 写最小实现**

`agent-adapter/src/adapters/claude.ts` 三处改动：

① 文件顶部加 import（`mapClaudeSDKMessage` 相关 import 之后）：

```typescript
import { resolveLatestSessionId } from '../session-resolver.js';
```

② `ClaudeAdapterOptions` 接口加两个可选字段：

```typescript
export interface ClaudeAdapterOptions {
  claudePath?: string;
  sessionId: string;
  riskThreshold?: number;
  approvalTimeoutMs?: number;
  queryFactory?: ClaudeQueryFactory;
  cwd?: string;
  initialSessionId?: string;
}
```

③ 类字段 + 构造器 + `send()`：

字段区（`private lastAssistantText = '';` 之后）加：

```typescript
  private readonly cwd: string;
  private readonly initialSessionId: string | null;
```

构造器末尾（`this.approvalTimeoutMs = ...` 之后）加：

```typescript
    this.cwd = options.cwd || process.env.AGENTBRIDGE_CWD || process.cwd();
    this.initialSessionId = options.initialSessionId || process.env.AGENTBRIDGE_RESUME_SESSION || null;
```

`send()` 里 `cwd: process.cwd(),` 改为 `cwd: this.cwd,`；`if (input.type === 'user_message' && this.lastSessionId) { options.resume = this.lastSessionId; }` 改为：

```typescript
    if (input.type === 'user_message') {
      const resume = this.lastSessionId ?? this.initialSessionId ?? resolveLatestSessionId(this.cwd);
      if (resume) options.resume = resume;
    }
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd agent-adapter && npm run build && node --test dist/__tests__/claude.test.js`
Expected: PASS（含新增的 cwd/initialSession 测试 + 强化后的 resume 优先级测试，且原有多条用例仍绿）。

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `cd agent-adapter && npm test`
Expected: PASS（所有测试绿，无 error/warning 输出）。

- [ ] **Step 6: Commit**

```bash
git add agent-adapter/src/adapters/claude.ts agent-adapter/src/__tests__/claude.test.ts
git commit -m "feat: ClaudeCodeAdapter supports cwd + initial session resume"
```

---

### Task 3: 真机 E2E（手动验证跨进程 resume）

**Files:** 无代码改动。

**验证点（spec 唯一真机风险）：** PC 终端 claude 退出后，daemon 用 SDK `resume` 能否干净续上并继续写同一 session 文件。

- [ ] **Step 1: PC 终端开一个任务会话**

```bash
cd "D:\project\5project\AgentBridge-master"
claude
# 说一句会留下上下文的任务，例如「记住数字 42，待会儿我要你复述」，确认它回应后 Ctrl+C 退出
```

- [ ] **Step 2: 确认 session 落盘**

Run: `ls -lat "C:/Users/_/.claude/projects/D--project-5project-AgentBridge-master/" | head -3`
Expected: 最新一条 `.jsonl` 即刚退出那次会话（记下它的 uuid）。

- [ ] **Step 3: 起 daemon（带项目 cwd）**

```bash
cd agent-adapter
AGENTBRIDGE_CWD="D:\project\5project\AgentBridge-master" AGENTBRIDGE_AUDIO_PORT=8788 AGENTBRIDGE_SESSION=default node dist/session.js
```

- [ ] **Step 4: 眼镜语音续会话**

单击→说话：「我刚才让你记住的数字是多少？」→ 观察回复。
Expected: 回复复述「42」，证明上下文延续了 PC 终端的那个 session（而非新开）。

- [ ] **Step 5: 观察 daemon 日志**

Expected: 首句日志显示 `resume` 到了 Step 2 记下的 uuid；`[session] STT: ...` 正常；无 session 锁报错。

---

## 自检

- **Spec 覆盖**：改动 1 → Task 1；改动 2 → Task 2；改动 3（session.ts 不改）→ 全计划不碰 session.ts；验证点 → Task 3。全覆盖。
- **占位符**：无 TBD/TODO，所有代码块含真实内容。
- **类型一致**：`encodeProjectDir` / `resolveLatestSessionId` 命名与签名在 Task 1 定义、Task 2 消费一致；`cwd` / `initialSessionId` 字段名在 spec、Task 2 一致。
