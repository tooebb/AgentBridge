# Claude Code CLI Adapter V2 设计文档

**日期：** 2026-08-11（2026-08-14 修订：raw CLI → Agent SDK）
**阶段：** Phase 3a — 真实本地 Agent 会话适配层 MVP
**状态：** 设计阶段（协议章节已按 Agent SDK 路线重写）
**范围：** 增强 ClaudeCodeAdapter，使真实 Claude Code 会话走审批闭环

---

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-11 | 初版：假设 raw CLI 通过 stream-json `control` 消息双向审批 |
| 2026-08-14 | **推翻 raw CLI 假设**，改用 Agent SDK `query()` + `canUseTool` 回调。实测证明 raw CLI 不吐 `control` 消息、权限只会被静态放行或自动拒绝。详见 §2。 |

---

## 1. 目标与背景

### 1.1 当前状态

`ClaudeCodeAdapter`（`agent-adapter/src/adapters/claude.ts`）当前实现是 `spawn('claude')` + 解析 stdout stream-json + 向 stdin 写 control JSON。**这条路线在真实链路下已被证伪**（2026-08-14 实测，见 §2.1）：

| 假设 | 实测结果 |
|------|---------|
| raw CLI 会吐出 `{"type":"control","control_type":"tool_permission"}` 消息 | ❌ 全程无 `control`/`control_request` 消息 |
| 通过 stdin 写 control JSON 可 allow/deny | ❌ raw CLI 无对应 stdin 响应通道 |
| `--permission-mode default` 下工具调用会等审批 | ⚠️ 会走权限检查，但 headless 下**自动拒绝**（`tool_result` `is_error:true`），而不是可回写的挂起 |

同仓库的 `ClaudeAPIAdapter`（`src/adapters/claude-api.ts`）已完整跑通审批闭环：tool_use 检测 → risk >= 0.3 暂停 → needs_approval → 等待眼镜审批 → 执行/拒绝。12 场景中的 approve→execute 就是用这个验证的。**本 V2 的审批语义完全复用这套闭环，只是把「工具来源」从 Anthropic API SDK 换成 Agent SDK 驱动的真实 Claude Code。**

### 1.2 目标

**让真实 Claude Code 的每一次高风险工具调用，都需要用户在眼镜上审批后才能执行。**

数据流：

```
Claude Code 进程（由 @anthropic-ai/claude-agent-sdk 驱动）
  │  canUseTool(toolName, input) 回调
  ▼
ClaudeCodeAdapter V2
  ├─ 风控分级（risk.ts）：低风险 → 直接 allow
  └─ 高风险 → needs_approval 事件 → Core → 眼镜
                              ↓
                handleUserAction ← 眼镜 approve/reject
                              ↓
        resolve canUseTool → { behavior: "allow"|"deny" } → Claude Code 继续/拒绝
```

### 1.3 非目标

- 不追求通用插件生态（Phase 3c）
- 不改 Core 协议、不改眼镜端代码
- 不要求 Claude Code 以特殊模式编译——通过 Agent SDK 驱动用户已安装的 `claude` 二进制
- 不支持 Claude Code 的交互模式——只支持 headless（SDK `query()` 底层用 `--print`）

---

## 2. Claude Code Agent SDK 协议

### 2.1 为什么放弃 raw CLI（实测证据）

2026-08-14 用真实 `claude` 2.1.116 实测，触发 `Write` 工具（写文件）：

- **全程没有任何 `control` / `control_request` 消息**。raw CLI 的 stream-json 输出只有 `system/init`、`assistant`、`user`、`result` 四种 type。
- 权限请求的真实形态：工具直接收到一条 `user` 消息，`tool_result` 的 `is_error:true`，内容 `"Claude requested permissions to write to ... but you haven't granted it yet."` —— 即 **headless 模式下自动拒绝**，而非可回写的挂起。
- 最终 `result` 消息带 `permission_denials` 数组记录被拒工具。

结论：raw `claude -p --output-format stream-json --input-format stream-json` **没有可双向回写的动态审批协议**。官方文档确认：**动态工具审批回调是 Agent SDK 的特性**（`query()` 的 `canUseTool`），raw CLI 只能 `--allowedTools` 静态放行或 `--permission-mode` 静态策略。

### 2.2 Agent SDK 入口

npm 包 `@anthropic-ai/claude-agent-sdk`，核心入口：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: string | AsyncIterable<SDKUserMessage>,
  options?: Options,  // 含 canUseTool、pathToClaudeCodeExecutable、env 等
});
// q 是 AsyncGenerator<SDKMessage, void>
for await (const message of q) { /* ... */ }
```

SDK 底层仍然 spawn `claude` 二进制，但**代管了双向协议**（含 control_request/control_response 的收发），我们无需手动解析 stdout 或写 stdin。

### 2.3 `canUseTool` 回调（审批拦截点）

**这是 V2 唯一的审批拦截点**，替代原设计里的「解析 control 消息 + 写 stdin control JSON」。

```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };
```

关键特性：

- **回调可 pending**：返回一个尚未 resolve 的 Promise，SDK 的 `query()` 循环会 await 它，工具执行随之挂起。这正是「等待眼镜审批」的挂载点。
- 只有权限流程真正落到「需要询问」时才触发；被 `allowedTools`/allow 规则/`permissionMode` 静态放行的工具不会进来。
- `signal` 可用于感知会话取消（如进程被 kill）。

### 2.4 SDK 输出消息类型

`query()` 产出 `SDKMessage`，与 raw CLI stream-json 同构。V2 只消费其中四类：

| SDKMessage | 触发时机 | 关键字段 | adapter 处理 |
|-----------|---------|---------|-------------|
| `system` | 启动/初始化 | `subtype: "init"`, `session_id` | 触发 `task_started` |
| `assistant` | 模型回复 | `message.content[]`（`thinking`/`text`/`tool_use` block） | `text` block → `text` 事件 |
| `user` | 工具结果回填 | `message.content[]`（`tool_result`） | 忽略（结果在后续 text/result） |
| `result` | 会话结束 | `result`, `is_error`, `permission_denials` | → `task_completed` / `task_failed` |

`stream_event`（增量 token）默认关闭，V2 不消费。

### 2.5 Claude SDK message → OPC 审批语义映射表

「OPC」指 AgentBridge 现有的审批事件语义（`needs_approval` 事件 + `available_actions` + 设备 `approve/reject` 动作），与 `ClaudeAPIAdapter` 已跑通的闭环一致。映射关系如下：

**（A）SDK 输出消息 → `AgentEvent`（adapter 内部事件，`adapters/types.ts`）**

| SDKMessage | 判定条件 | AgentEvent |
|-----------|---------|------------|
| `system`（`subtype:"init"`） | 会话启动 | `{ type: 'task_started', taskId }` |
| `assistant`（`content[]` 含 `text` block） | 提取文本 | `{ type: 'text', content }` |
| `assistant`（`content[]` 含 `tool_use` block） | 已由 `canUseTool` 拦截，此处不重复产生事件 | — |
| `user`（`tool_result`） | — | —（忽略） |
| `result`（`is_error:false`） | 正常结束 | `{ type: 'task_completed', taskId, summary }` |
| `result`（`is_error:true`） | 出错/被拒 | `{ type: 'task_failed', taskId, error }` |

**（B）`canUseTool` 回调 → 审批门（风控分级 + 挂起）**

| canUseTool 输入 | `assessRisk` 结果 | 动作 | PermissionResult |
|----------------|------------------|------|------------------|
| `toolName` + `input` | `risk < threshold` | 直接放行 | 返回 `{ behavior:'allow', updatedInput: input }` |
| `toolName` + `input` | `risk >= threshold` | 发 `needs_approval` 事件 → 挂起 | 返回 pending Promise（由 `handleUserAction` resolve） |

**（C）审批闭环（设备动作 → SDK 决策）**

| 设备动作（`DeviceAction.type`） | 触发来源 | resolve 为 |
|-------------------------------|---------|-----------|
| `approve` / `continue` | 眼镜单击 | `{ behavior:'allow', updatedInput }` |
| `reject` | 眼镜双击 | `{ behavior:'deny', message }` |
| `view_details` / `pause` | 眼镜滑动/其它 | **不 resolve**，仅透传（见 §4 边界约束） |
| 超时（`AGENTBRIDGE_CORE_TIMEOUT`） | Core 不可用/无响应 | `{ behavior:'allow', updatedInput }`（auto-allow 降级） |

### 2.6 已知风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| `@anthropic-ai/claude-agent-sdk` 对 Node 版本有要求，当前环境 Node 18.19.0 可能不满足 | 高 | 装包前先确认 `engines`；不满足则升 Node 或锁兼容版本 |
| Windows 上 SDK spawn claude 同样需要 `CLAUDE_CODE_GIT_BASH_PATH` | 高 | 通过 `Options.env` 透传该环境变量（§6 配置） |
| `canUseTool` 的 `updatedInput`（camelCase）与 SDK 底层 wire 的 `updated_input`（snake_case）不一致 | 低 | 我们只经 `canUseTool` 回调返回，SDK 内部负责转换，adapter 不手写 wire 格式 |
| 部分工具（`AskUserQuestion`、connector/MCP 标 `requiresUserInteraction`）即使被 allow 规则命中仍会进回调 | 低 | 与 `Bash`/`Write` 走同一风控路径，无需特殊处理 |

---

## 3. 组件设计

### 3.1 改造范围

```
agent-adapter/package.json              ← 新增依赖 @anthropic-ai/claude-agent-sdk
agent-adapter/src/adapters/claude.ts    ← 主改造文件：从 spawn+解析 改为 query()+canUseTool
agent-adapter/src/risk.ts               ← 复用（已由 Codex 落地，无需改）
agent-adapter/src/hub.ts                ← 复用（fallback 选择已落地）
agent-adapter/src/adapters/types.ts     ← 无需改动（AgentEvent 已覆盖所需类型）
agent-adapter/src/index.ts              ← 微调：透传 CLAUDE_CODE_GIT_BASH_PATH 等 SDK 配置
```

不改 `normalizer.ts`、`ws-client.ts`——审批链路复用现有基础设施。

### 3.2 ClaudeCodeAdapter V2 内部结构

```
┌──────────────────────────────────────────────────┐
│            ClaudeCodeAdapter V2                  │
│                                                  │
│  send(input)                                     │
│    └→ query({ prompt, options: { canUseTool } }) │
│                                                  │
│  for await (msg of queryResult):                 │
│    system/init  → yield task_started             │
│    assistant text → yield text                   │
│    result       → yield task_completed/failed    │
│    (tool_use 不进这里——已被 canUseTool 拦截)       │
│                                                  │
│  canUseTool(toolName, input):                    │
│    risk = assessRisk(toolName, input)            │
│    if risk < threshold:                          │
│      return { behavior:'allow', updatedInput }   │
│    else:                                         │
│      emit needs_approval 事件（→ Core → 眼镜）     │
│      return new Promise(resolve => {             │
│        this.pending = { resolve, input }         │
│      })   ← 挂起，SDK query 循环 await 它          │
│                                                  │
│  handleUserAction(action):                       │
│    approve/continue → pending.resolve(allow)     │
│    reject           → pending.resolve(deny)      │
│    view_details/pause → 不 resolve（仅透传）       │
│    超时（timer）    → pending.resolve(allow)      │
│                                                  │
│  disconnect() → abort query + 清理 pending        │
└──────────────────────────────────────────────────┘
```

**与旧设计的本质区别**：不再有 `spawn('claude')`、不再解析 stdout 的 `control` 消息、不再向 stdin 写 JSON。审批挂起从「保存 request_id + 写 stdin」变成「`canUseTool` 返回 pending Promise」。`this.pending` 保存的是 `resolve` 函数和 `input`，由 `handleUserAction` 或超时定时器触发。

### 3.3 风控规则

复用 `ClaudeAPIAdapter` 的 `assessRisk()` 逻辑，泛化为基于 tool_name + input 的规则表：

```typescript
const RISK_RULES: RiskRule[] = [
  // 高危：系统级破坏命令
  { toolPattern: /^(execute_command|Bash)$/,
    inputMatch: (args) => /\b(rm\s+-rf|sudo|chmod|chown|mkfs|dd|format|shutdown|reboot)\b/i.test(args?.command || ''),
    risk: 0.9 },
  // 高危：git force push
  { toolPattern: /^(execute_command|Bash)$/,
    inputMatch: (args) => /\bgit\s+push\s+.*(-f|--force|--force-with-lease)\b/i.test(args?.command || ''),
    risk: 0.85 },
  // 中高：git push / 远程操作
  { toolPattern: /^(execute_command|Bash)$/,
    inputMatch: (args) => /\b(git\s+push|npm\s+publish|docker\s+push|gh\s+release)\b/i.test(args?.command || ''),
    risk: 0.6 },
  // 中：文件写入/编辑
  { toolPattern: /^(Write|Edit|write_to_file|replace_in_file)$/, risk: 0.4 },
  // 中：任意 shell 命令（catch-all）
  { toolPattern: /^(execute_command|Bash)$/, risk: 0.3 },
  // 低：只读操作
  { toolPattern: /^(Read|read_file|Grep|Glob|search|list_files|TodoRead|TaskList|LSP)$/, risk: 0 },
  // 未知工具：默认 0.4（偏保守）
  { toolPattern: /.*/, risk: 0.4 },
]
```

阈值 `APPROVAL_THRESHOLD = 0.3`，可通过环境变量 `AGENTBRIDGE_RISK_THRESHOLD` 覆盖。

### 3.4 状态机（适配器内部）

```
IDLE → RUNNING (query() 启动)
RUNNING → AWAITING_APPROVAL (canUseTool 命中 risk >= threshold，返回 pending Promise)
AWAITING_APPROVAL → RUNNING (handleUserAction 或超时 resolve pending Promise)
RUNNING → DONE (result 消息或 query 结束)
任意状态 → ERROR (SDK 抛错 / query 异常退出)
```

### 3.5 AgentEvent 映射

权威映射表见 **§2.5**（SDK message → AgentEvent 表 A，`canUseTool` → 审批门表 B，设备动作 → SDK 决策表 C）。此处不再重复。

实现约束：`tool_use` 不再产生独立的 `tool_call` 事件——低风险工具在 `canUseTool` 里直接 `allow`，SDK 会自行执行并产出 `tool_result`，adapter 无需也不应二次广播 `tool_call`。

---

## 4. 审批流（端到端）

```
1. Claude Code 决定写入文件 → SDK 触发 canUseTool("Write", {file_path, content})

2. canUseTool 内 assessRisk("Write", {...}) → 0.4 >= 0.3 → 进入审批门

3. Adapter emit AgentEvent { type: "needs_approval", tool: "Write", risk: 0.4 }
   → normalizer.fromAgentEvent() → UnifiedMessage { event_type: "needs_approval",
     available_actions: [approve, reject, view_details] }
   → POST /api/v1/events → Core processing pipeline → 眼镜 actionable_card

4. canUseTool 返回 pending Promise，this.pending = { resolve, input }
   SDK query 循环 await 该 Promise → 工具执行挂起

5. 用户单击（approve）→ Core WS → AgentBridgeClient emits 'user_action'
   → index.ts handler → hub.handleUserAction() → adapter.handleUserAction()

6. ClaudeCodeAdapter.handleUserAction():
   - 读取 this.pending
   - approve → pending.resolve({ behavior:'allow', updatedInput })
   - 清除 this.pending

7. SDK 收到 allow → 执行工具 → tool_result 回填 → query 继续
   → 循环回到步骤 1（下一轮工具调用）
```

**超时处理：** `canUseTool` 挂起时启动 `AGENTBRIDGE_CORE_TIMEOUT` 定时器。超时未收到设备动作 → 按 §5.1 降级 auto-allow（`resolve({ behavior:'allow' })`），避免 Claude Code 会话永久挂死。

**拒绝处理：** `reject` → `resolve({ behavior:'deny', message })` → SDK 向 Claude Code 回传拒绝 → 工具不执行，Claude Code 转为提出替代方案或结束任务。

**边界约束（重要）：** `handleUserAction` 只有 `approve`/`continue`/`reject` 才会 resolve 当前 pending；`view_details`/`pause` 等非决策动作**不得** resolve，否则会把「看详情」误判成「拒绝」（这是旧实现踩过的坑）。

---

## 5. 重连与异常处理

| 场景 | 行为 |
|------|------|
| 眼镜断连 | pending Promise 由超时兜底（默认 120s auto-allow）。`AGENTBRIDGE_CORE_TIMEOUT=0` 可禁用超时改为无限等待。 |
| Core 重启 | `AgentBridgeClient` 自动重连（指数退避 2-30s），重连后 `last_acked_seq` 回放事件。adapter 本身不受影响——query 继续运行。 |
| Adapter 进程 crash | Claude Code 子进程随 SDK 关闭被 OS 清理。用户重新 `npm run dev` 即可。 |
| Claude Code 进程 crash | SDK `query()` 异常/结束 → yield `task_failed` → adapter 清理 pending 状态。 |
| Adapter/Core 刚启动，Claude Code 已触发 canUseTool | 高风险工具挂起 pending，等待 Core 连接完成后发送 `needs_approval`。Core 长时间不可用（> 120s）→ 超时 auto-allow 防挂死。 |

### 5.1 Core 不可用时的降级策略

`canUseTool` 挂起时启动 `AGENTBRIDGE_CORE_TIMEOUT`（默认 120000ms）定时器。若设备动作未在超时前返回（Core 不可达、HTTP 错误、眼镜断连、用户无操作），adapter **不**无限等待——超时后 `resolve({ behavior:'allow' })` 自动放行并记录 WARN：

```
[ClaudeCodeAdapter] approval timed out after 120000ms, auto-allowing tool: Write (risk=0.4)
```

这样确保用户不会因为 Core 挂了而丢失 Claude Code 会话。`AGENTBRIDGE_CORE_TIMEOUT=0` 表示禁用超时、无限等待（适用于需要强审批保证的场景）。

---

## 6. 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CLAUDE_PATH` | `claude` | claude 二进制路径，映射到 SDK `Options.pathToClaudeCodeExecutable` |
| `CLAUDE_CODE_GIT_BASH_PATH` | — | **Windows 必需**。指向 git-bash 的 `bash.exe`（如 `D:/Software/Git/bin/bash.exe`）。SDK spawn claude 时通过 `Options.env` 透传，缺失则 Windows 上 claude 直接报 `requires git-bash` |
| `AGENTBRIDGE_URL` | `http://localhost:8088` | Core 地址 |
| `AGENTBRIDGE_SESSION` | `default` | 会话 ID |
| `AGENTBRIDGE_PROMPT` | — | 初始 prompt |
| `AGENTBRIDGE_RISK_THRESHOLD` | `0.3` | 审批触发阈值（0 = 全部审批，1 = 全部放行） |
| `AGENTBRIDGE_CORE_TIMEOUT` | `120000` | 审批超时自动放行等待时间（ms）；`0` = 禁用超时、无限等待；真机联调建议显式设置为 `120000` |

---

## 7. 与 ClaudeAPIAdapter 的关系

| 维度 | ClaudeAPIAdapter | ClaudeCodeAdapter V2 |
|------|-----------------|---------------------|
| Agent 来源 | Anthropic SDK 调 API | Agent SDK 驱动真实 `claude` 二进制 |
| 工具集 | 3 个硬编码（run_shell, read_file, write_file） | Claude Code 全部原生工具 |
| 项目上下文 | 无（仅 prompt） | 完整（CLAUDE.md, git, 文件树） |
| 审批流 | ✅ 完整 | ✅ 复用相同 AgentEvent 接口（`canUseTool` 拦截） |
| 并发 | 支持多轮 tool loop | 单会话，SDK `query()` 管线 |
| 适用场景 | 轻量任务、自动化脚本 | 日常编码、完整项目工作 |

两者并存，通过 `--adapter claude-api` / `--adapter claude-code` 选择。`ClaudeCodeAdapter` 设为首选适配器（优先级高于 `claude-api`）。

---

## 8. 多 Agent 扩展性

Claude Code 是第一个，但不是唯一目标。架构从第一天起就预留了多 agent 接入点：

### 8.1 扩展点

```
                    AgentAdapter 接口（agent 无关）
                    ┌─────────────────────────┐
                    │ connect()                │
                    │ send(input) → AgentEvent │
                    │ handleUserAction(action) │
                    │ disconnect()             │
                    └──────────┬──────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
   ClaudeCodeAdapter    CodexAdapter       GenericTerminalAdapter
   (Agent SDK)          (Codex CLI/WSS)    (PTY + 文本规则)
```

**三个扩展维度：**

| 维度 | 说明 | 例子 |
|------|------|------|
| 新 adapter 实现 | 新文件实现 `AgentAdapter` 接口，注册到 Hub | `codex.ts`, `windsurf.ts`, `aider.ts` |
| 共享风控规则 | `risk.ts` 用 `toolPattern` 正则，同时覆盖多 agent 工具名 | `/^(Write\|write_to_file\|Edit\|replace_in_file)$/` |
| 共享审批管道 | normalizer → ws-client → Core → 眼镜，完全不感知 agent 类型 | 零改动 |

### 8.2 接入新 Agent 的代价

| Agent | 通信协议 | 预计工作量 | 关键挑战 |
|-------|---------|-----------|---------|
| **Codex CLI** | 用 stream-json 协议（审批机制需单独调研） | 低（~100 行新文件） | Codex 的审批拦截机制可能与 Claude SDK 不同 |
| **Codex (OpenAI API)** | HTTP SSE / streaming chat completions | 中（~200 行新文件） | tool_use 格式不同（`function_call` vs `tool_use`），需要翻译层 |
| **任意 CLI Agent** | PTY stdin/stdout | 中高（~300 行） | 无结构化输出，依赖 regex 规则解析工具调用 |
| **Aider / Continue / Cline** | 各有自己的 CLI 协议 | 视情况 | 每个都要单独调研协议 |

### 8.3 Phase 3b 预埋

当前设计中的 `GenericTerminalAdapter`（`src/adapters/generic-cli.ts`）已经是 PTY 模式的雏形。V2 完成后，下一步自然演进：

1. 把 `risk.ts` 和审批门从 `ClaudeCodeAdapter` 中解耦为独立模块
2. `GenericTerminalAdapter` 接入同一套风控 + 审批管道
3. 任何新 agent 只需要写"协议翻译"层（agent 输出 → `AgentEvent`），审批逻辑零重复

---

## 9. 测试策略

### 9.0 mock 策略（关键设计决策）

`@anthropic-ai/claude-agent-sdk` 的 `query()` 会真 spawn `claude`，单测不能真起进程。项目测试框架是 `node:test`（非 jest），无 `jest.mock`。

因此 **`ClaudeCodeAdapter` 构造函数接受可注入的 `queryFactory`**（类型为 `typeof query`，默认 import 真实 SDK），把「SDK message → AgentEvent 映射」「`canUseTool` 决策」抽成纯函数，测试直接注入 mock `queryFactory` 返回假 `AsyncGenerator<SDKMessage>`。

### 9.1 单元测试

| 测试 | 验证点 |
|------|--------|
| `assessRisk` 全部规则 | 7 条规则 × 边界值（rm -rf → 0.9, git push -f → 0.85, git push → 0.6, Write → 0.4, Bash → 0.3, Read → 0, unknown → 0.4）；补 `rm -fr`/`rm --recursive` 边界 |
| SDKMessage → AgentEvent 映射（纯函数） | `system/init`→`task_started`；`assistant`(text)→`text`；`result`(success)→`task_completed`；`result`(error)→`task_failed` |
| `canUseTool` 决策（纯函数） | risk < threshold → `{behavior:'allow', updatedInput}`；risk >= threshold → 触发 `needs_approval` + 返回 pending |
| `handleUserAction` | approve → resolve allow；reject → resolve deny；**view_details/pause → 不 resolve**（回归测试，防旧 bug） |
| 超时 | 挂起后触发 `AGENTBRIDGE_CORE_TIMEOUT` → 自动 resolve allow |

### 9.2 集成测试（mock queryFactory）

注入 mock `queryFactory`，返回可控的 `AsyncGenerator`：

1. 喂 `system/init` + `assistant`(text) + `result`(success) → 断言依次产出 `task_started`/`text`/`task_completed`
2. mock 的 `canUseTool` 触发高风险工具 → 断言 `needs_approval` 事件发出、query 循环挂起（不继续消费）
3. 调用 `handleUserAction('approve')` → 断言 query 恢复、后续 message 被消费
4. 模拟 Core 不可用（不调用 `handleUserAction`）→ 断言超时后 auto-allow

### 9.3 E2E 测试（真机）

```bash
# 启动 Core
cd middleware-core && AGENTBRIDGE_ADDR=:8088 go run cmd/server/main.go &

# 启动 adapter（claude-cli 模式，Windows 需设 git-bash 路径）
cd agent-adapter && AGENTBRIDGE_AGENT=claude-cli AGENTBRIDGE_SESSION=default \
  CLAUDE_CODE_GIT_BASH_PATH="D:/Software/Git/bin/bash.exe" \
  AGENTBRIDGE_PROMPT="Create a hello.txt file with 'Hello World' in /tmp" \
  npm run dev &

# 启动眼镜 → 连接 Core → 应收到 actionable_card → approve → 文件创建
```

预期 4 个场景：
1. **低风险自动通过**：`list files in /tmp` → 只读工具 `canUseTool` 直接 allow，无卡片
2. **高风险审批通过**：`write a file` → 眼镜收到卡片 → approve → 文件写入成功
3. **高风险拒绝**：`delete config file` → 眼镜收到卡片 → reject → 工具不执行，Claude Code 换方案
4. **超时降级**：kill Core → 高风险工具挂起 → 30s 后 auto-allow，adapter 不卡死

---

## 10. 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `agent-adapter/package.json` | 修改 | 新增依赖 `@anthropic-ai/claude-agent-sdk`；修正 `test` 脚本 glob（Windows 兼容） |
| `agent-adapter/src/adapters/claude.ts` | 重写 | ClaudeCodeAdapter V2：`query()` + `canUseTool`，移除旧 raw CLI control 逻辑 |
| `agent-adapter/src/risk.ts` | 复用+补正则 | 共享风控逻辑（已由 Codex 落地）；补 `rm -fr`/`rm --recursive` 边界 |
| `agent-adapter/src/hub.ts` | 复用 | fallback 选择已落地 |
| `agent-adapter/src/adapters/types.ts` | 不改 | AgentEvent 接口不变 |
| `agent-adapter/src/index.ts` | 微调 | 透传 `CLAUDE_CODE_GIT_BASH_PATH` 等 SDK 配置 |
| `agent-adapter/src/adapters/__tests__/claude.test.ts` | 重写 | 单元测试（mock `queryFactory`） |
| ~~`agent-adapter/src/adapters/__tests__/mock-claude.sh`~~ | 删除 | 旧 mock claude 脚本，随 raw CLI 方案废弃 |
