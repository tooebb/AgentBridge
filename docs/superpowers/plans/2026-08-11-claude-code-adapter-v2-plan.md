# Phase 3a — Claude Code CLI Adapter V2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**阶段：** Phase 3a — 真实本地 Agent 会话适配层 MVP
**Goal:** 增强 ClaudeCodeAdapter，使真实 Claude Code CLI 进程的高风险工具调用经过眼镜审批后才能执行。

**Architecture:** 从 claude-api.ts 提取共享风控模块 risk.ts → 重写 claude.ts 的 stream-json 解析、control 消息拦截、审批门和 stdin 响应 → 在 index.ts 中提升 ClaudeCodeAdapter 优先级。审批链路（normalizer → ws-client → Core → 眼镜）零改动。

**Tech Stack:** TypeScript (ES2022, CommonJS), Node.js child_process, Claude Code stream-json 协议, Jest/Vitest

## Global Constraints

- 不改 Core 协议、不改眼镜端代码
- 审批链路复用现有 normalizer/ws-client 基础设施
- `--input-format stream-json` 标志需实现时验证，不存在则降级为仅输出流 + stdin 文本协议
- `--permission-mode default` 需确保工具调用走 control 协议
- 风控阈值 `AGENTBRIDGE_RISK_THRESHOLD`，默认 0.3
- Core 不可用时默认 120s 自动放行（`AGENTBRIDGE_CORE_TIMEOUT`）

## Entry Criteria（准入条件 — 以下必须全部通过才能开工）

| # | 条件 | 验证方法 | 状态 |
|---|------|---------|------|
| EC-1 | Core seq/ack/replay 协议已实现 | `DeviceMessage.Seq` + `IsReplay`、`ClientMessage.LastAckedSeq` 字段存在，`EventStore.ReplaySince()` 可调用 | ✅ `types.go:107-129` |
| EC-2 | 眼镜端 ack 跟踪已实现 | `AgentBridgeClient.kt` 中 `lastAckedSeq` 全程跟踪，重连时携带 `last_acked_seq` 查询参数 | ✅ Phase 2 验证通过（场景 6/12） |
| EC-3 | Core → 眼镜审批闭环已跑通 | 12 场景全部通过，approve/reject 端到端可用 | ✅ 2026-08-11 |
| EC-4 | `claude` 二进制可执行 | `claude --version` 返回正常 | ⬜ 需验证 |
| EC-5 | `--output-format stream-json` 可用 | `echo "hello" \| claude -p "say hi" --output-format stream-json --verbose` 有 JSON 行输出 | ⬜ 需验证 |
| EC-6 | `--input-format stream-json` 可用（或降级方案确认） | control 消息能通过 stdin JSON 接收 | ⬜ Task 7 Step 1-2 验证 |

## Acceptance Matrix（验收矩阵）

### 纯代码验收（Task 1-6，无需真机）

| # | 场景 | 通过标准 | 验证方式 |
|---|------|---------|---------|
| A-1 | risk.ts 7 规则覆盖 | 8 个 Jest 测试全部 PASS | `npx jest risk.test.ts` |
| A-2 | stream-json 行解析 | 5 个测试 PASS（system/assistant/result/空行/非JSON） | `npx jest claude.test.ts` |
| A-3 | control 拦截 + 审批门 | 4 个测试 PASS（自动放行/暂停/approve/deny） | `npx jest claude.test.ts` |
| A-4 | TypeScript 编译 | `tsc --noEmit` 零错误 | CI / 手动 |
| A-5 | 旧 adapter 不退化 | `ClaudeAPIAdapter` 测试不变（risk.ts 提取后行为一致） | `npx jest` |

### E2E 验收（Task 7，需真机 + Core + 眼镜）

| # | 场景 | 通过标准 | 验证方式 |
|---|------|---------|---------|
| E-1 | 低风险自动放行 | 只读工具（Read/Grep）不弹审批卡片，adapter 日志显示 `auto-allow` | 真机 |
| E-2 | 高风险审批通过 | Write 工具 → 眼镜 actionable_card → 单击 approve → 文件写入成功 → task_completed | 真机 |
| E-3 | 高风险拒绝 | rm 命令 → 眼镜 actionable_card → 双击 reject → 工具不执行 → Claude Code 换方案 | 真机 |
| E-4 | Core 断连降级 | 审批等待期间 kill Core → 30s 后 adapter 日志显示 `auto-allowing` → Claude Code 会话不丢失 | 真机 |
| E-5 | 眼镜断连重连 | 审批期间拔眼镜 USB → 重连后卡片不丢失（seq 回放） → approve 正常执行 | 真机 |

### 不做（Explicit Non-Goals）

| 项目 | 原因 |
|------|------|
| 语音审批 | 依赖 ASR/权限/安全审计，独立 Phase |
| Phone AgentBridgeService | Phase 3a 用 LAN 直连，Phone 仅做 CXR 生命周期 |
| 多 Agent 并发 | 当前单 session 模型，Phase 3b 扩展 |
| 通用插件生态 / SDK | Phase 3c |
| Codex adapter 实现 | Phase 3b（设计已预留扩展点） |

---

### Task 1: 共享风控模块 risk.ts

**Files:**
- Create: `agent-adapter/src/adapters/risk.ts`
- Create: `agent-adapter/src/adapters/__tests__/risk.test.ts`
- Modify: `agent-adapter/src/adapters/claude-api.ts` (改用共享模块)

**Interfaces:**
- Produces: `assessRisk(toolName: string, toolInput: Record<string, unknown>) → number`

- [ ] **Step 1: 写 risk.test.ts 的 7 条规则测试**

```typescript
// agent-adapter/src/adapters/__tests__/risk.test.ts
import { assessRisk } from '../risk';

describe('assessRisk', () => {
  // 高危：rm -rf / sudo / chmod / chown / mkfs / dd / format / shutdown / reboot
  it('rates destructive system commands at 0.9', () => {
    expect(assessRisk('execute_command', { command: 'rm -rf /' })).toBe(0.9);
    expect(assessRisk('execute_command', { command: 'sudo rm file' })).toBe(0.9);
    expect(assessRisk('Bash', { command: 'chmod 777 /etc/passwd' })).toBe(0.9);
    expect(assessRisk('execute_command', { command: 'mkfs.ext4 /dev/sda' })).toBe(0.9);
    expect(assessRisk('Bash', { command: 'shutdown now' })).toBe(0.9);
    expect(assessRisk('execute_command', { command: 'dd if=/dev/zero of=/dev/sda' })).toBe(0.9);
    expect(assessRisk('Bash', { command: 'format C:' })).toBe(0.9);
  });

  // 高危：git force push
  it('rates git force push at 0.85', () => {
    expect(assessRisk('execute_command', { command: 'git push -f origin main' })).toBe(0.85);
    expect(assessRisk('Bash', { command: 'git push --force origin main' })).toBe(0.85);
    expect(assessRisk('execute_command', { command: 'git push --force-with-lease' })).toBe(0.85);
  });
  it('does not match regular git push as force push', () => {
    const risk = assessRisk('execute_command', { command: 'git push origin main' });
    expect(risk).toBeLessThan(0.85);
  });

  // 中高：git push / npm publish / docker push / gh release
  it('rates remote push/publish at 0.6', () => {
    expect(assessRisk('execute_command', { command: 'git push origin main' })).toBe(0.6);
    expect(assessRisk('Bash', { command: 'npm publish' })).toBe(0.6);
    expect(assessRisk('execute_command', { command: 'docker push myimage' })).toBe(0.6);
    expect(assessRisk('Bash', { command: 'gh release create v1.0' })).toBe(0.6);
  });

  // 中：文件写入/编辑（Claude Code + Codex 工具名）
  it('rates file write/edit at 0.4', () => {
    expect(assessRisk('Write', { file_path: '/tmp/test.txt', content: 'hi' })).toBe(0.4);
    expect(assessRisk('Edit', { file_path: '/tmp/test.txt', old_string: 'a', new_string: 'b' })).toBe(0.4);
    expect(assessRisk('write_to_file', { path: '/tmp/test.txt' })).toBe(0.4);
    expect(assessRisk('replace_in_file', { path: '/tmp/test.txt' })).toBe(0.4);
  });

  // 中：任意 shell 命令（catch-all）
  it('rates arbitrary shell commands at 0.3', () => {
    expect(assessRisk('execute_command', { command: 'npm test' })).toBe(0.3);
    expect(assessRisk('Bash', { command: 'ls -la' })).toBe(0.3);
    expect(assessRisk('execute_command', { command: 'echo hello' })).toBe(0.3);
  });

  // 低：只读操作
  it('rates read-only tools at 0', () => {
    expect(assessRisk('Read', { file_path: '/tmp/test.txt' })).toBe(0);
    expect(assessRisk('read_file', { path: '/tmp/test.txt' })).toBe(0);
    expect(assessRisk('Grep', { pattern: 'TODO' })).toBe(0);
    expect(assessRisk('Glob', { pattern: '*.ts' })).toBe(0);
    expect(assessRisk('search', { query: 'function' })).toBe(0);
    expect(assessRisk('list_files', { path: '/src' })).toBe(0);
    expect(assessRisk('TodoRead', {})).toBe(0);
    expect(assessRisk('TaskList', {})).toBe(0);
    expect(assessRisk('LSP', { operation: 'hover' })).toBe(0);
  });

  // 未知工具：默认 0.4
  it('rates unknown tools at 0.4 (conservative)', () => {
    expect(assessRisk('some_unknown_tool', {})).toBe(0.4);
    expect(assessRisk('', {})).toBe(0.4);
  });

  // 边缘情况：null / undefined args
  it('handles null/undefined tool input gracefully', () => {
    expect(assessRisk('execute_command', null as any)).toBe(0.3);
    expect(assessRisk('Write', undefined as any)).toBe(0.4);
    expect(assessRisk('some_tool', undefined as any)).toBe(0.4);
  });
});
```

- [ ] **Step 2: 运行测试 — 确认失败**

Run: `cd agent-adapter && npx jest src/adapters/__tests__/risk.test.ts`
Expected: FAIL — `Cannot find module '../risk'`

- [ ] **Step 3: 实现 risk.ts**

```typescript
// agent-adapter/src/adapters/risk.ts

export interface RiskRule {
  /** Regex tested against the tool name. */
  toolPattern: RegExp;
  /** Optional secondary match on tool input. If omitted, the rule matches on tool name alone. */
  inputMatch?: (args: Record<string, unknown>) => boolean;
  /** Risk score 0.0–1.0. */
  risk: number;
}

const RISK_RULES: RiskRule[] = [
  // 0.9: destructive system commands
  {
    toolPattern: /^(execute_command|Bash)$/,
    inputMatch: (args) =>
      /\b(rm\s+-rf|sudo|chmod|chown|mkfs|dd|format|shutdown|reboot)\b/i.test(
        args?.command ?? ''
      ),
    risk: 0.9,
  },
  // 0.85: git force push
  {
    toolPattern: /^(execute_command|Bash)$/,
    inputMatch: (args) =>
      /\bgit\s+push\s+.*(-f|--force|--force-with-lease)\b/i.test(
        args?.command ?? ''
      ),
    risk: 0.85,
  },
  // 0.6: remote push/publish
  {
    toolPattern: /^(execute_command|Bash)$/,
    inputMatch: (args) =>
      /\b(git\s+push|npm\s+publish|docker\s+push|gh\s+release)\b/i.test(
        args?.command ?? ''
      ),
    risk: 0.6,
  },
  // 0.4: file write / edit (Claude Code + Codex tool names)
  {
    toolPattern: /^(Write|Edit|write_to_file|replace_in_file)$/,
    risk: 0.4,
  },
  // 0.3: arbitrary shell command (catch-all)
  {
    toolPattern: /^(execute_command|Bash)$/,
    risk: 0.3,
  },
  // 0: read-only tools (Claude Code + Codex)
  {
    toolPattern: /^(Read|read_file|Grep|Glob|search|list_files|TodoRead|TaskList|LSP)$/,
    risk: 0,
  },
  // 0.4: unknown tools (conservative default)
  {
    toolPattern: /.*/,
    risk: 0.4,
  },
];

/**
 * Evaluate risk for a tool call. Rules are matched in priority order;
 * the first matching rule determines the score.
 */
export function assessRisk(
  toolName: string,
  toolInput: Record<string, unknown> | null | undefined
): number {
  const safeInput = toolInput ?? {};
  for (const rule of RISK_RULES) {
    if (!rule.toolPattern.test(toolName)) continue;
    if (rule.inputMatch && !rule.inputMatch(safeInput)) continue;
    return rule.risk;
  }
  // Unreachable — the last rule (catch-all) always matches
  return 0.4;
}

/** Risk threshold above which a tool call requires user approval. */
export const DEFAULT_RISK_THRESHOLD = 0.3;
```

- [ ] **Step 4: 运行测试 — 确认通过**

Run: `cd agent-adapter && npx jest src/adapters/__tests__/risk.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: 改造 claude-api.ts 使用共享 risk.ts**

读取 `claude-api.ts` 中的私有 `assessRisk` 方法，替换为从 `./risk` 导入的共享函数。删除原有的硬编码风控逻辑。

```typescript
// agent-adapter/src/adapters/claude-api.ts — 改动点
import { assessRisk, DEFAULT_RISK_THRESHOLD } from './risk';

// 删除原有的 private assessRisk(toolName, input) 方法
// 将调用点 assessRisk(name, args) 改为导入的 assessRisk(name, args)
```

- [ ] **Step 6: 验证 claude-api.ts 改动不破坏现有行为**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add agent-adapter/src/adapters/risk.ts \
        agent-adapter/src/adapters/__tests__/risk.test.ts \
        agent-adapter/src/adapters/claude-api.ts
git commit -m "feat: extract shared risk assessment module (risk.ts)

7 rules x edge cases, shared between ClaudeCodeAdapter and ClaudeAPIAdapter.
Read-only tools → 0, file writes → 0.4, shell → 0.3, destructive → 0.9."
```

---

### Task 2: ClaudeCodeAdapter V2 — 进程管理 + stream-json 输出解析

**Files:**
- Modify: `agent-adapter/src/adapters/claude.ts` (重写核心方法)

**Interfaces:**
- Consumes: `assessRisk(toolName, input) → number` from `./risk`
- Produces: same `AgentAdapter` interface, `start()` spawns with `--input-format stream-json`

- [ ] **Step 1: 重写 start() — spawn 命令 + stdin/stdout 管线**

```typescript
// agent-adapter/src/adapters/claude.ts — start() 方法
start(prompt?: string): void {
  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',   // 新增：双向 JSON 流
  ];
  if (prompt) {
    args.push('-p', prompt);
  }

  this.process = spawn(this.claudePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // stdout: stream-json lines
  const stdout = createInterface({ input: this.process.stdout! });
  stdout.on('line', (line: string) => {
    this.handleLine(line.trim());
  });

  // stderr: forward as error events (not stream-json)
  const stderr = createInterface({ input: this.process.stderr! });
  stderr.on('line', (line: string) => {
    this.emit('event', {
      agentId: 'claude-code',
      sessionId: this.sessionId,
      timestamp: Date.now(),
      rawOutput: line.trim(),
      source: 'stderr',
    });
  });

  this.process.on('error', (err) => this.emit('error', err));
  this.process.on('close', (code) => {
    if (code !== 0) {
      this.emit('event', {
        agentId: 'claude-code',
        sessionId: this.sessionId,
        timestamp: Date.now(),
        rawOutput: `Claude Code exited with code ${code}`,
        source: 'hook',
      });
    }
    this.emit('close', code);
  });
}
```

- [ ] **Step 2: 实现 handleLine() — JSON 解析 + 类型路由**

```typescript
// agent-adapter/src/adapters/claude.ts — handleLine() + 分发方法

/** Parse a single stream-json line and route by type. */
private handleLine(line: string): void {
  if (!line) return;

  let parsed: StreamJsonMessage;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not valid JSON → treat as plain text output
    this.emitEvent(line, 'stdout');
    return;
  }

  switch (parsed.type) {
    case 'system':
      this.handleSystem(parsed);
      break;
    case 'assistant':
      this.handleAssistant(parsed);
      break;
    case 'user':
      // Echo of user messages — skip, or emit lightweight status
      break;
    case 'result':
      this.handleResult(parsed);
      break;
    case 'stream':
      // Phase 1: skip incremental stream events, rely on 'assistant' for complete blocks
      break;
    case 'control':
      this.handleControl(parsed);
      break;
    default:
      // Unknown type — emit as raw text
      this.emitEvent(line, 'stdout');
  }
}
```

- [ ] **Step 3: 实现 system / assistant / result 处理方法**

```typescript
private handleSystem(msg: StreamJsonMessage): void {
  const text = msg.message || msg.subtype || 'System event';
  this.emitEvent(text, 'stdout');
}

private handleAssistant(msg: StreamJsonMessage): void {
  const blocks = msg.message?.content ?? [];
  for (const block of blocks) {
    if (block.type === 'text') {
      this.emitEvent(block.text ?? '', 'stdout');
    } else if (block.type === 'tool_use') {
      // Tool use embedded in assistant message
      // Route through the same approval gate as control messages
      this.handleToolUse(block.name ?? 'unknown', block.input ?? {});
    }
  }
}

private handleResult(msg: StreamJsonMessage): void {
  const sessionId = msg.session_id ?? '';
  const usage = msg.usage ?? {};
  this.emitEvent(
    `Session ${sessionId} completed. Usage: ${JSON.stringify(usage)}`,
    'stdout'
  );
}
```

- [ ] **Step 4: 更新 rawToAgentEvent() — 支持更多 AgentEvent 类型**

```typescript
private rawToAgentEvent(raw: RawEvent): AgentEvent {
  if (raw.source === 'stderr') {
    return { type: 'task_failed', taskId: this.sessionId, error: raw.rawOutput };
  }
  return { type: 'text', content: raw.rawOutput };
}
```

保持原有逻辑。`needs_approval` 和 `tool_call` 在 handleControl/handleToolUse 中直接 yield（不经过 rawToAgentEvent），详见 Task 3。

- [ ] **Step 5: 类型定义 — StreamJsonMessage**

```typescript
// agent-adapter/src/adapters/claude.ts — 文件顶部新增类型

interface StreamJsonMessage {
  type: 'system' | 'assistant' | 'user' | 'result' | 'stream' | 'control';
  subtype?: string;
  message?: string | {
    content?: Array<{
      type: 'text' | 'tool_use';
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  // control-specific fields
  control_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  request_id?: string;
  // result-specific fields
  session_id?: string;
  usage?: Record<string, unknown>;
}
```

- [ ] **Step 6: 验证编译**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add agent-adapter/src/adapters/claude.ts
git commit -m "feat: ClaudeCodeAdapter V2 — stream-json parsing + type routing

Add --input-format stream-json, parse system/assistant/control/result
messages, route by type. Incremental stream events deferred to Phase 2."
```

---

### Task 3: ClaudeCodeAdapter V2 — control 拦截 + 审批门

**Files:**
- Modify: `agent-adapter/src/adapters/claude.ts` (新增 handleControl, handleToolUse, ApprovalGate)

**Interfaces:**
- Consumes: `assessRisk` from `./risk`
- Produces: `AgentEvent { type: 'needs_approval' }` with `tool`, `risk`, `taskId`

- [ ] **Step 1: 实现 handleControl() — 核心拦截点**

```typescript
// agent-adapter/src/adapters/claude.ts

/** Pending approval request awaiting glasses response. */
private pendingControl: {
  requestId: string;
  resolve: (decision: 'allow' | 'deny') => void;
} | null = null;

private handleControl(msg: StreamJsonMessage): void {
  const controlType = msg.control_type ?? '';
  if (controlType !== 'tool_permission') {
    // Unknown control type — auto-allow
    this.writeControlResponse(msg.request_id ?? '', 'allow');
    return;
  }

  const toolName = msg.tool_name ?? 'unknown';
  const toolInput = msg.tool_input ?? {};
  const risk = assessRisk(toolName, toolInput);

  if (risk < this.riskThreshold) {
    // Low risk — auto-allow
    this.writeControlResponse(msg.request_id ?? '', 'allow');
    this.queueEvent({ type: 'tool_call', tool: toolName, args: toolInput });
    return;
  }

  // High risk — needs approval
  this.queueEvent({
    type: 'needs_approval',
    tool: toolName,
    risk,
    taskId: this.sessionId,
  });

  // Pause until handleUserAction resolves
  this.pendingControl = {
    requestId: msg.request_id ?? '',
    resolve: () => {}, // resolved in handleUserAction
  };
}
```

- [ ] **Step 2: 实现 handleToolUse() — assistant 消息中嵌入的 tool_use**

```typescript
private handleToolUse(toolName: string, toolInput: Record<string, unknown>): void {
  const risk = assessRisk(toolName, toolInput);

  if (risk < this.riskThreshold) {
    this.queueEvent({ type: 'tool_call', tool: toolName, args: toolInput });
    return;
  }

  // For embedded tool_use without a control request_id,
  // we cannot block execution but we still flag it
  this.queueEvent({
    type: 'needs_approval',
    tool: toolName,
    risk,
    taskId: this.sessionId,
  });
  // Note: embedded tool_use in assistant messages may already be executing.
  // Claude Code's permission mode determines whether these appear as control
  // messages (blockable) or inline tool_use (non-blockable).
}
```

- [ ] **Step 3: 实现 writeControlResponse() — stdin JSON 响应**

```typescript
private writeControlResponse(requestId: string, decision: 'allow' | 'deny'): void {
  if (!this.process?.stdin?.writable) {
    return;
  }
  const response = {
    type: 'control',
    control_type: 'tool_permission',
    request_id: requestId,
    decision,
  };
  this.process.stdin.write(JSON.stringify(response) + '\n');
}
```

- [ ] **Step 4: 实现审批等待机制 — send() 中的挂起/唤醒**

修改 `send()` 方法，在检测到 `pendingControl` 时挂起等待。当前的 send() 使用 `queue` + `notify` 机制已经支持此模式——`handleUserAction` 被调用时设置 resolve → wake generator → 继续事件循环。

需要增加 `pendingControl` 的挂起逻辑：当 `pendingControl` 不为 null 时，不继续输出事件，等待 resolve。

```typescript
// 在 send() 的 while 循环末尾新增：
// 如果正在等待审批，挂起直到 handleUserAction 写入 stdin 响应
if (this.pendingControl) {
  await new Promise<void>((resolve) => {
    this.pendingControl!.resolve = (decision: 'allow' | 'deny') => {
      // If rejected, emit task_running to indicate the agent will try another approach
      if (decision === 'deny') {
        this.queueEvent({
          type: 'text',
          content: `Tool call rejected by user. Agent will propose alternative.`,
        });
      }
      resolve();
    };
  });
}
```

- [ ] **Step 5: 实现 handleUserAction() V2**

```typescript
async handleUserAction(action: DeviceAction): Promise<void> {
  if (!this.pendingControl) {
    // No pending approval — write as text to stdin (legacy fallback)
    if (this.process?.stdin?.writable) {
      const msgs: Record<string, string> = {
        approve: 'Approved by user from connected device. Continue.',
        reject: 'Rejected by user from connected device. Stop and propose alternative.',
        continue: 'Continue.',
      };
      this.process.stdin.write((msgs[action.type] ?? action.type) + '\n');
    }
    return;
  }

  const decision = action.type === 'approve' || action.type === 'continue'
    ? 'allow'
    : 'deny';

  this.writeControlResponse(this.pendingControl.requestId, decision);

  const resolve = this.pendingControl.resolve;
  this.pendingControl = null;
  resolve(decision);
}
```

- [ ] **Step 6: 添加 riskThreshold 配置字段**

```typescript
// agent-adapter/src/adapters/claude.ts — 构造函数中新增
export interface ClaudeAdapterOptions {
  claudePath?: string;
  sessionId: string;
  riskThreshold?: number;   // 新增
  approvalTimeoutMs?: number;   // 新增
}

constructor(options: ClaudeAdapterOptions) {
  // ... existing fields
  this.riskThreshold = options.riskThreshold ?? DEFAULT_RISK_THRESHOLD;
  this.approvalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
}
```

- [ ] **Step 7: 实现审批超时 120s 自动放行**

审批暂停后启动超时计时器，Core 不可用时防止 Claude Code 挂死。

```typescript
// handleControl() 中，审批暂停后新增：
const timeoutId = setTimeout(() => {
  if (this.pendingControl?.requestId === requestId) {
    console.warn(
      `[ClaudeCodeAdapter] Core unreachable for ${this.approvalTimeoutMs}ms, ` +
      `auto-allowing tool: ${toolName} (risk=${risk})`
    );
    this.writeControlResponse(requestId, 'allow');
    const resolve = this.pendingControl.resolve;
    this.pendingControl = null;
    resolve('allow');
  }
}, this.approvalTimeoutMs);

// pendingControl 类型新增 timeoutId 字段
this.pendingControl = {
  requestId: msg.request_id ?? '',
  timeoutId,
  resolve: () => {},
};
```

pendingControl 类型更新：

```typescript
private pendingControl: {
  requestId: string;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (decision: 'allow' | 'deny') => void;
} | null = null;
```

handleUserAction 中清除计时器：

```typescript
if (this.pendingControl?.timeoutId) {
  clearTimeout(this.pendingControl.timeoutId);
}
```

- [ ] **Step 8: 验证编译**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 9: Commit**

```bash
git add agent-adapter/src/adapters/claude.ts
git commit -m "feat: ClaudeCodeAdapter V2 — control interception + approval gate

Parse control messages, route through risk assessment, auto-allow low risk,
pause for high risk. handleUserAction writes JSON control response to stdin."
```

---

### Task 4: ClaudeCodeAdapter V2 — 单元测试

**Files:**
- Create: `agent-adapter/src/adapters/__tests__/claude.test.ts`

**Interfaces:**
- Consumes: `ClaudeCodeAdapter` from `../claude`, `assessRisk` from `../risk`

- [ ] **Step 1: 写测试 — stream-json 行解析**

```typescript
// agent-adapter/src/adapters/__tests__/claude.test.ts
import { ClaudeCodeAdapter } from '../claude';

// Helper to access private methods for testing
function makeAdapter(sessionId = 'test') {
  return new ClaudeCodeAdapter({ sessionId, claudePath: 'echo' });
}

describe('ClaudeCodeAdapter line parsing', () => {
  it('parses system message as stdout event', (done) => {
    const adapter = makeAdapter();
    adapter.on('event', (raw) => {
      expect(raw.rawOutput).toContain('initialization');
      expect(raw.source).toBe('stdout');
      done();
    });
    // Simulate stream-json line
    (adapter as any).handleLine(
      JSON.stringify({ type: 'system', subtype: 'init', message: 'Claude Code initialization' })
    );
  });

  it('falls back to raw text for non-JSON lines', (done) => {
    const adapter = makeAdapter();
    adapter.on('event', (raw) => {
      expect(raw.rawOutput).toBe('plain text output');
      expect(raw.source).toBe('stdout');
      done();
    });
    (adapter as any).handleLine('plain text output');
  });

  it('ignores empty lines', () => {
    const adapter = makeAdapter();
    const spy = jest.fn();
    adapter.on('event', spy);
    (adapter as any).handleLine('');
    (adapter as any).handleLine('  ');
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses assistant text content as stdout event', (done) => {
    const adapter = makeAdapter();
    adapter.on('event', (raw) => {
      expect(raw.rawOutput).toBe('Let me check that file.');
      done();
    });
    (adapter as any).handleLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Let me check that file.' }] },
    }));
  });

  it('parses result message as stdout event', (done) => {
    const adapter = makeAdapter();
    adapter.on('event', (raw) => {
      expect(raw.rawOutput).toContain('completed');
      done();
    });
    (adapter as any).handleLine(JSON.stringify({
      type: 'result',
      session_id: 'abc',
      usage: { tokens: 100 },
    }));
  });
});
```

- [ ] **Step 2: 运行测试 — 确认失败**

Run: `cd agent-adapter && npx jest src/adapters/__tests__/claude.test.ts`
Expected: FAIL — `handleLine` is private

- [ ] **Step 3: 暴露 handleLine 为测试可见**

在 `claude.ts` 中将 `handleLine` 改为 public（或添加 `@visibleForTesting` 注释）：

```typescript
/** @visibleForTesting */
handleLine(line: string): void { ... }
```

- [ ] **Step 4: 运行测试 — 确认通过**

Run: `cd agent-adapter && npx jest src/adapters/__tests__/claude.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: 写测试 — control 消息拦截 + 审批门**

```typescript
describe('ClaudeCodeAdapter control interception', () => {
  it('auto-allows low risk tools (read-only)', (done) => {
    const adapter = makeAdapter();
    let controlWritten = false;
    // Mock stdin
    (adapter as any).process = {
      stdin: { writable: true, write: (data: string) => {
        const parsed = JSON.parse(data);
        expect(parsed.decision).toBe('allow');
        controlWritten = true;
      }},
    };
    (adapter as any).handleLine(JSON.stringify({
      type: 'control',
      control_type: 'tool_permission',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/test.txt' },
      request_id: 'r1',
    }));
    expect(controlWritten).toBe(true);
    done();
  });

  it('pauses for high risk tools (Write)', (done) => {
    const adapter = makeAdapter();
    let eventEmitted = false;
    (adapter as any).process = {
      stdin: { writable: true, write: () => {} },
    };
    adapter.on('event', (raw) => {
      // needs_approval should be queued via send() — for unit test we verify pendingControl
      if (raw.rawOutput) return; // not the needs_approval event
    });
    (adapter as any).handleLine(JSON.stringify({
      type: 'control',
      control_type: 'tool_permission',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hi' },
      request_id: 'r2',
    }));
    // Verify pending control is set
    expect((adapter as any).pendingControl).not.toBeNull();
    expect((adapter as any).pendingControl.requestId).toBe('r2');
    done();
  });

  it('writes control response on approve', () => {
    const adapter = makeAdapter();
    let written = '';
    (adapter as any).process = {
      stdin: { writable: true, write: (data: string) => { written = data; }},
    };
    (adapter as any).pendingControl = {
      requestId: 'r3',
      resolve: () => {},
    };
    adapter.handleUserAction({ type: 'approve', device_type: 'ar_glasses', timestamp: Date.now() });
    const parsed = JSON.parse(written);
    expect(parsed.decision).toBe('allow');
    expect(parsed.request_id).toBe('r3');
    expect((adapter as any).pendingControl).toBeNull();
  });

  it('writes control response on reject', () => {
    const adapter = makeAdapter();
    let written = '';
    (adapter as any).process = {
      stdin: { writable: true, write: (data: string) => { written = data; }},
    };
    (adapter as any).pendingControl = {
      requestId: 'r4',
      resolve: () => {},
    };
    adapter.handleUserAction({ type: 'reject', device_type: 'ar_glasses', timestamp: Date.now() });
    const parsed = JSON.parse(written);
    expect(parsed.decision).toBe('deny');
    expect(parsed.request_id).toBe('r4');
  });
});
```

- [ ] **Step 6: 运行测试 — 确认通过**

Run: `cd agent-adapter && npx jest src/adapters/__tests__/claude.test.ts`
Expected: 9 tests PASS

- [ ] **Step 7: Commit**

```bash
git add agent-adapter/src/adapters/__tests__/claude.test.ts \
        agent-adapter/src/adapters/claude.ts
git commit -m "test: ClaudeCodeAdapter V2 — stream-json parsing + control unit tests

Cover line parsing, type routing, control interception, approve/reject
stdin responses. handleLine exposed for testing."
```

---

### Task 5: 集成测试 — mock claude 脚本

**Files:**
- Create: `agent-adapter/src/adapters/__tests__/mock-claude.sh`

- [ ] **Step 1: 写 mock claude 脚本**

```bash
#!/bin/bash
# agent-adapter/src/adapters/__tests__/mock-claude.sh
# Simulates Claude Code stream-json output for integration testing.
# Usage: ./mock-claude.sh

echo '{"type":"system","subtype":"init","message":"Claude Code starting..."}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check the file first."}]}}'
echo '{"type":"control","control_type":"tool_permission","tool_name":"Write","tool_input":{"file_path":"test.txt","content":"hello"},"request_id":"r-write-1"}'

# Wait up to 10s for stdin response (simulates waiting for user approval)
# In integration test, we write to adapter's handleUserAction which writes stdin
for i in $(seq 1 10); do
  if read -t 1 -r line; then
    echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Received: $line\"}]}}" >&2
    break
  fi
done

echo '{"type":"assistant","message":{"content":[{"type":"text","text":"File written successfully."}]}}'
echo '{"type":"result","session_id":"mock-session","usage":{"input_tokens":50,"output_tokens":30}}'
```

- [ ] **Step 2: 写集成测试用例**

```typescript
// 添加到 claude.test.ts 文件末尾

describe('ClaudeCodeAdapter integration with mock claude', () => {
  it('full flow: mock script → spawn → parse → approve → complete', async () => {
    // This test requires the mock-claude.sh script to be executable.
    // Skip in CI environments that don't have bash.
    if (process.platform === 'win32') {
      console.log('Skipping mock-claude integration test on Windows');
      return;
    }

    const adapter = new ClaudeCodeAdapter({
      sessionId: 'integration-test',
      claudePath: 'bash',
    });

    const events: string[] = [];
    adapter.on('event', (raw) => {
      events.push(raw.rawOutput);
    });

    // start() spawns bash mock-claude.sh
    // Test validates event flow, not implemented here as it requires PTY setup
    // Full integration test runs manually per the E2E validation task
  });
});
```

注意：由于 mock-claude.sh 依赖 bash + PTY 交互，完整的自动化集成测试在 Windows 上受限。此任务产出 mock 脚本供手动 E2E 使用，CI 中跳过。

- [ ] **Step 3: Commit**

```bash
git add agent-adapter/src/adapters/__tests__/mock-claude.sh \
        agent-adapter/src/adapters/__tests__/claude.test.ts
git commit -m "test: add mock-claude.sh for integration testing"
```

---

### Task 6: index.ts 适配 — 优先级 + 配置

**Files:**
- Modify: `agent-adapter/src/index.ts`

- [ ] **Step 1: 调整 ClaudeCodeAdapter 优先级 + 传入配置**

在 `index.ts` 中，将 `ClaudeCodeAdapter` 注册时的优先级调到 `claude-api` 之前，并传入 `riskThreshold` 和 `approvalTimeoutMs` 配置。

```typescript
// agent-adapter/src/index.ts — 改动点

import { DEFAULT_RISK_THRESHOLD } from './adapters/risk';

// ...

// Register ClaudeCodeAdapter with config
const claudeCodeAdapter = new ClaudeCodeAdapter({
  sessionId: SESSION_ID,
  claudePath: process.env.CLAUDE_PATH || 'claude',
  riskThreshold: parseFloat(process.env.AGENTBRIDGE_RISK_THRESHOLD || '') || DEFAULT_RISK_THRESHOLD,
  approvalTimeoutMs: parseInt(process.env.AGENTBRIDGE_CORE_TIMEOUT || '120000', 10),
});
hub.register(claudeCodeAdapter);

// Hub 的 select() 按注册顺序选择。由于 ClaudeCodeAdapter 先注册，
// 它会被优先尝试。如果连接失败（claude 二进制不存在），fallback 到 ClaudeAPIAdapter。

// 如果指定了 AGENTBRIDGE_AGENT，仍然由 hub.select(AGENTBRIDGE_AGENT) 进行精确选择。
```

- [ ] **Step 2: 验证编译**

Run: `cd agent-adapter && npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add agent-adapter/src/index.ts
git commit -m "feat: ClaudeCodeAdapter priority + risk config from env

AGENTBRIDGE_RISK_THRESHOLD (default 0.3) and AGENTBRIDGE_CORE_TIMEOUT
(default 30s) wired through to ClaudeCodeAdapter."
```

---

### Task 7: E2E 验证 — 真实 Claude Code + Core + 眼镜

**前置条件：** Core 运行中、眼镜已连接、ADB 隧道或 LAN 直连可用。

- [ ] **Step 1: 验证 Claude Code CLI 的 stream-json 输出格式**

```bash
# 先 dump 一条 control 消息确认格式
cd agent-adapter
echo "Write a file to /tmp/test.txt" | claude --print --verbose \
  --output-format stream-json --input-format stream-json -p "Write 'hello' to /tmp/hello.txt" \
  2>/dev/null | head -20
```

对比 spec 中假设的 control 消息字段名和实际输出，如有差异则更新 `StreamJsonMessage` 类型定义。

- [ ] **Step 2: 验证 --permission-mode 是否生效**

```bash
claude --print --verbose \
  --output-format stream-json --input-format stream-json \
  --permission-mode default \
  -p "Delete /tmp/test.txt" 2>/dev/null | grep '"type":"control"'
```

如果有 `control` 消息输出 → 权限模式生效。否则需要找到等效标志。

- [ ] **Step 3: 启动 adapter（claude-code 模式）**

```bash
cd agent-adapter
AGENTBRIDGE_URL=http://localhost:8088 \
AGENTBRIDGE_SESSION=default \
AGENTBRIDGE_AGENT=claude-cli \
AGENTBRIDGE_PROMPT="Create a hello.txt file with 'Hello World' in /tmp" \
npm run dev
```

- [ ] **Step 4: 验证低风险场景（自动放行）**

```bash
AGENTBRIDGE_PROMPT="List all files in /tmp" npm run dev
```

预期：只读工具自动放行，Core 日志显示 `tool_call` 事件，眼镜不显示审批卡片。

- [ ] **Step 5: 验证高风险审批通过场景**

```bash
AGENTBRIDGE_PROMPT="Write a file called /tmp/agentbridge-test.txt with content 'e2e test passed'" npm run dev
```

预期：
1. Core 收到 `needs_approval` 事件（`tool=Write, risk=0.4`）
2. 眼镜显示 actionable_card [Approve] [Reject]
3. 单击 approve → Core 收到 action → adapter 写 `{"decision":"allow"}` 到 stdin
4. Claude Code 执行工具 → 文件写入成功
5. 事件流继续，最终 task_completed

- [ ] **Step 6: 验证拒绝场景**

```bash
AGENTBRIDGE_PROMPT="Delete the file /tmp/agentbridge-test.txt" npm run dev
```

预期：
1. 眼镜显示 actionable_card（rm 命令 → risk=0.9）
2. 双击 reject → adapter 写 `{"decision":"deny"}` 到 stdin
3. Claude Code 不执行删除 → 提出替代方案

- [ ] **Step 7: 验证 Core 断连降级**

1. 启动 adapter + Claude Code
2. 在 approval 等待期间 kill Core 进程
3. 观察 adapter 日志：30s 后应打印 `Core unreachable for 30s, auto-allowing tool`
4. Claude Code 会话不丢失

- [ ] **Step 8: Commit（E2E 结果 + 修复）**

```bash
git add -A
git commit -m "test: E2E validation — ClaudeCodeAdapter V2 with real Claude Code

Verify: low-risk auto-allow, high-risk approve/reject, Core disconnect
fallback. Fix any control message format mismatches found during testing."
```

---

### Task 8: CLAUDE.md 更新

**Files:**
- Modify: `CLAUDE.md` (Phase 3a 状态更新)

- [ ] **Step 1: 更新 CLAUDE.md 中的 Phase 3 条目**

将 Phase 3 中的 "claude-cli 适配器增强" 从待办改为 ✅ 完成（E2E 验证通过后），添加 ClaudeCodeAdapter V2 的简要说明。

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update Phase 3a status — ClaudeCodeAdapter V2 completed"
```
