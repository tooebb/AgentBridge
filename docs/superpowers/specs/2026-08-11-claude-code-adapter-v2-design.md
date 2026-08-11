# Claude Code CLI Adapter V2 设计文档

**日期：** 2026-08-11
**阶段：** Phase 3a — 真实本地 Agent 会话适配层 MVP
**状态：** 设计阶段
**范围：** 增强 ClaudeCodeAdapter，使真实 Claude Code CLI 进程走审批闭环

---

## 1. 目标与背景

### 1.1 当前状态

`ClaudeCodeAdapter`（`agent-adapter/src/adapters/claude.ts`）已能 spawn `claude --print --verbose --output-format stream-json`，但存在三个缺陷：

| 缺陷 | 现状 | 影响 |
|------|------|------|
| stream-json 解析不完整 | 只提取 `text`/`message` 字段，丢弃 `tool_use`、`control` 等结构化事件 | 工具调用全部丢失 |
| stdin 协议错误 | `handleUserAction` 写文本（`/approve`），但 stream-json 模式要求 JSON control 响应 | 审批无法回传 |
| 无风险分级 | 所有输出一视同仁，不区分高低风险工具 | 所有操作都无审批 |

而同仓库的 `ClaudeAPIAdapter`（`src/adapters/claude-api.ts`）已完整跑通审批闭环：tool_use 检测 → risk >= 0.3 暂停 → needs_approval → 等待眼镜审批 → 执行/拒绝。12 场景中的 approve→execute 就是用这个验证的。

### 1.2 目标

**让真实 Claude Code CLI 的每一次高风险工具调用，都需要用户在眼镜上审批后才能执行。**

数据流：

```
Claude Code CLI (stream-json 双向)
  ← stdout: control { tool_name, input }
  → stdin:  control { decision: "allow"|"deny" }
     │
     ▼
ClaudeCodeAdapter V2
  ← 解析 control 消息 → 风控分级 → needs_approval 事件 → Core → 眼镜
  ← 眼镜审批返回 → handleUserAction → stdin control allow/deny → Claude Code 继续
```

### 1.3 非目标

- 不追求通用插件生态（Phase 3c）
- 不改 Core 协议、不改眼镜端代码
- 不要求 Claude Code 以特殊模式编译——使用用户已安装的 `claude` 二进制
- 不支持 Claude Code 的交互模式（`claude` 不带 `-p`）——只支持 headless `--print` 模式

---

## 2. Claude Code stream-json 协议

### 2.1 stdout 消息类型

Claude Code 在 `--output-format stream-json --verbose` 下，stdout 每行一个 JSON 对象：

| type | 触发时机 | 关键字段 | adapter 处理 |
|------|---------|---------|-------------|
| `system` | 启动/初始化/错误 | `subtype`, `message` | 转发为 `task_running` |
| `assistant` | 模型回复完成 | `message.content[]` (text, tool_use blocks) | text → `task_running`; tool_use → 审批门 |
| `user` | 用户消息回显 | `message.content[]` | 可选转发轻量 status_card |
| `result` | 会话结束 | `session_id`, `usage` | 转发为 `task_completed` |
| `stream` | 增量生成 | `content_block_start` (含 tool_use_start) | 收集完整 tool_use 后进入审批门 |

**`control` 类型（核心拦截点）：**

```json
{
  "type": "control",
  "control_type": "tool_permission",
  "tool_name": "Write",
  "tool_input": { "file_path": "...", "content": "..." },
  "request_id": "uuid"
}
```

adapter 必须通过 stdin 回复 same `request_id`：

```json
{"type": "control", "control_type": "tool_permission", "request_id": "uuid", "decision": "allow"}
```

### 2.2 stdin 协议

**所有 adapter 写入 stdin 的内容必须是单行 JSON。** 当前实现写文本（`/approve`、`/reject`）在 stream-json 模式下无效。

同时需要 `--input-format stream-json` 标志（当前实现未传递）。

### 2.3 spawn 命令

```
claude --print --verbose --output-format stream-json --input-format stream-json -p "<prompt>"
```

注意：`--input-format stream-json` 是新增的，当前实现没有这个标志。

### 2.4 已知风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| `--input-format stream-json` 标志可能不存在于旧版 Claude Code CLI | 中 | 实现时先验证，不存在则降级为仅输出流 + stdin 文本协议 |
| `control` 消息的确切字段名可能与文档有差异 | 低 | 用真实 claude 二进制 dump 一条 control 消息确认格式 |
| Claude Code 默认权限模式可能跳过 control 消息直接执行 | 高 | 需要 `--permission-mode default`（或等效标志）确保工具调用走 control 协议。实现时第一个验证项。 |
| stream-json `stream` 类型中的增量 tool_use 拼装逻辑复杂 | 中 | Phase 1 优先处理 `assistant` 和 `control` 消息（完整事件），`stream` 增量解析推迟到 Phase 2 |

---

## 3. 组件设计

### 3.1 改造范围

```
agent-adapter/src/adapters/claude.ts    ← 主改造文件（~200 行 → ~350 行）
agent-adapter/src/adapters/types.ts     ← 无需改动（AgentEvent 已覆盖所需类型）
agent-adapter/src/index.ts              ← 微调：传入 riskThreshold 配置
```

不改 `normalizer.ts`、`ws-client.ts`、`hub.ts`——审批链路复用现有基础设施。

### 3.2 ClaudeCodeAdapter V2 内部结构

```
┌────────────────────────────────────────────┐
│          ClaudeCodeAdapter V2              │
│                                            │
│  start(prompt)                             │
│    └→ spawn claude --print --verbose       │
│       --output-format stream-json           │
│       --input-format stream-json            │
│       -p <prompt>                           │
│                                            │
│  stdout line → parseJSON → route by type:  │
│    ┌──────────────────────────────────┐    │
│    │ system    → text AgentEvent      │    │
│    │ assistant → text+tool_use(s)     │    │
│    │ stream    → collect in buffer    │    │
│    │ control   → ApprovalGate ────────│───→ needs_approval / auto-allow
│    │ result    → task_completed       │    │
│    └──────────────────────────────────┘    │
│                                            │
│  ApprovalGate:                             │
│    risk = assessRisk(tool_name, input)      │
│    if risk < 0.3:                          │
│      write stdin: {"decision":"allow"}      │
│      yield tool_call AgentEvent             │
│    else:                                    │
│      save pending request_id                 │
│      yield needs_approval AgentEvent        │
│      PAUSE (don't write stdin yet)          │
│                                            │
│  handleUserAction(action):                  │
│    if approve:                              │
│      write stdin: {"decision":"allow"}      │
│    if reject:                               │
│      write stdin: {"decision":"deny"}       │
│    clear pending → wake generator           │
│    → send() resumes event loop              │
└────────────────────────────────────────────┘
```

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
IDLE → RUNNING (spawn claude)
RUNNING → AWAITING_APPROVAL (control msg, risk >= 0.3)
AWAITING_APPROVAL → RUNNING (user approve/reject → stdin response)
RUNNING → DONE (result msg or process exit)
任意状态 → ERROR (process crash / spawn fail)
```

### 3.5 AgentEvent 映射

| stream-json type | 内部处理 | AgentEvent |
|-----------------|---------|------------|
| `system` (init) | — | `{ type: 'task_started', taskId }` |
| `system` (error) | — | `{ type: 'task_blocked', taskId, reason }` |
| `assistant` (text only) | content_block.text | `{ type: 'text', content }` |
| `assistant` (tool_use, low risk) | auto-allow | `{ type: 'tool_call', tool, args }` |
| `control` (tool, high risk) | 审批门 | `{ type: 'needs_approval', tool, risk, taskId }` |
| `result` | — | `{ type: 'task_completed', taskId, summary }` |
| process exit (non-zero) | — | `{ type: 'task_failed', taskId, error }` |

---

## 4. 审批流（端到端）

```
1. Claude Code 决定写入文件 → stdout 发出 control 消息
   {"type":"control","control_type":"tool_permission","tool_name":"Write",
    "tool_input":{"file_path":"src/app.ts","content":"..."},"request_id":"r1"}

2. Adapter parse → route to ApprovalGate
   assessRisk("Write", {...}) → 0.4 >= 0.3 → 暂停

3. Adapter yield AgentEvent { type: "needs_approval", tool: "Write", risk: 0.4 }
   → normalizer.fromAgentEvent() → UnifiedMessage { event_type: "needs_approval",
     available_actions: [approve, reject, view_details] }
   → POST /api/v1/events → Core processing pipeline → 眼镜 actionable_card

4. Adapter 保存 { request_id: "r1", wake: () => resume } 进入等待

5. 用户单击（approve）→ Core WS → AgentBridgeClient emits 'user_action'
   → index.ts handler → hub.handleUserAction() → adapter.handleUserAction()

6. ClaudeCodeAdapter.handleUserAction():
   - 读取 pending request_id
   - 构造: {"type":"control","control_type":"tool_permission","request_id":"r1","decision":"allow"}
   - 写入 stdin
   - 清除 pending，wake generator 继续

7. Claude Code 收到 allow → 执行工具 → stdout 继续输出
   → 循环回到步骤 1（下一轮工具调用）
```

**超时处理：** 审批等待期间无超时限制（跟现有 ClaudeAPIAdapter 一致）。如果进程被外部 kill，process `close` 事件触发 → yield `task_failed`。

**拒绝处理：** `decision: "deny"` → Claude Code 收到拒绝，不会执行工具，转为提出替代方案或结束任务。

---

## 5. 重连与异常处理

| 场景 | 行为 |
|------|------|
| 眼镜断连 | adapter 继续等待（不超时）。用户回座位后可在电脑上直接操作 Claude Code。 |
| Core 重启 | `AgentBridgeClient` 自动重连（指数退避 2-30s），重连后 `last_acked_seq` 回放事件。adapter 本身不受影响——进程继续运行。 |
| Adapter 进程 crashe | Claude Code 子进程随父进程被 OS 清理。用户重新 `npm run dev` 即可。 |
| Claude Code 进程 crash | `close` 事件触发 → yield `task_failed` → adapter 清理 pending 状态。 |
| Adapter/Core 刚启动，Claude Code 已发出 control | control 消息被 adapter 缓存到 pending，等待 Core 连接完成后发送。如果 Core 长时间不可用（> 30s），adapter 自动 allow 防止 Claude Code 挂死。 |

### 5.1 Core 不可用时的降级策略

如果 `needs_approval` 事件发送到 Core 失败（HTTP 错误或超时），adapter **不**无限等待——30 秒后自动 allow 并记录 WARN 日志：

```
[ClaudeCodeAdapter] Core unreachable for 30s, auto-allowing tool: Write (risk=0.4)
```

这样确保用户不会因为 Core 挂了而丢失 Claude Code 会话。

---

## 6. 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `CLAUDE_PATH` | `claude` | claude 二进制路径 |
| `AGENTBRIDGE_URL` | `http://localhost:8088` | Core 地址 |
| `AGENTBRIDGE_SESSION` | `default` | 会话 ID |
| `AGENTBRIDGE_PROMPT` | — | 初始 prompt |
| `AGENTBRIDGE_RISK_THRESHOLD` | `0.3` | 审批触发阈值（0 = 全部审批，1 = 全部放行） |
| `AGENTBRIDGE_CORE_TIMEOUT` | `30000` | Core 不可用自动放行等待时间（ms） |

---

## 7. 与 ClaudeAPIAdapter 的关系

| 维度 | ClaudeAPIAdapter | ClaudeCodeAdapter V2 |
|------|-----------------|---------------------|
| Agent 来源 | Anthropic SDK 调 API | spawn 真实 `claude` 二进制 |
| 工具集 | 3 个硬编码（run_shell, read_file, write_file） | Claude Code 全部原生工具 |
| 项目上下文 | 无（仅 prompt） | 完整（CLAUDE.md, git, 文件树） |
| 审批流 | ✅ 完整 | ✅ 复用相同 AgentEvent 接口 |
| 并发 | 支持多轮 tool loop | 单进程，stream-json 管线 |
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
   (stream-json)        (Codex CLI/WSS)    (PTY + 文本规则)
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
| **Codex CLI** | 也是 stream-json（跟 Claude Code 同源） | 低（~100 行新文件） | Codex 的 control 消息格式可能有微小差异 |
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

### 9.1 单元测试（`agent-adapter/src/adapters/__tests__/claude.test.ts`）

| 测试 | 验证点 |
|------|--------|
| `assessRisk` 全部规则 | 7 条规则 × 边界值（rm -rf → 0.9, cat file → 0.3, Read → 0） |
| stream-json line parse | 各 type 的 JSON 解析正确性（system/assistant/control/result/stream） |
| control 消息路由 | risk < 0.3 → auto-allow, risk >= 0.3 → needs_approval + pending |
| handleUserAction | approve → stdin `"allow"`, reject → stdin `"deny"` |
| 异常 JSON / 非 JSON 行 | 不崩溃，fallback 为 text event |

### 9.2 集成测试（mock claude 脚本）

用一个 shell 脚本模拟 Claude Code 的 stream-json 输出：

```bash
#!/bin/bash
echo '{"type":"system","subtype":"init","message":"Claude Code starting..."}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check the file."}]}}'
echo '{"type":"control","control_type":"tool_permission","tool_name":"Write","tool_input":{"file_path":"test.txt","content":"hello"},"request_id":"r1"}'
sleep 5  # 模拟等待审批
echo '{"type":"result","session_id":"test","usage":{}}'
```

验证 adapter 正确拦截 control、等待 Core 响应、写入 stdin allow/deny。

### 9.3 E2E 测试（真机）

```bash
# 启动 Core
cd middleware-core && AGENTBRIDGE_ADDR=:8088 go run cmd/server/main.go &

# 启动 adapter（claude-code 模式）
cd agent-adapter && AGENTBRIDGE_AGENT=claude-cli AGENTBRIDGE_SESSION=default \
  AGENTBRIDGE_PROMPT="Create a hello.txt file with 'Hello World' in /tmp" \
  npm run dev &

# 启动眼镜 → 连接 Core → 应收到 actionable_card → approve → 文件创建
```

预期 3 个场景：
1. **低风险自动通过**：`claude -p "list files in /tmp"` → 只读工具自动放行，无卡片
2. **高风险审批通过**：`claude -p "write a file"` → 眼镜收到卡片 → approve → 文件写入成功
3. **高风险拒绝**：`claude -p "delete config file"` → 眼镜收到卡片 → reject → 工具不执行，Claude Code 换方案

---

## 10. 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `agent-adapter/src/adapters/claude.ts` | 重写 | ClaudeCodeAdapter V2 |
| `agent-adapter/src/adapters/claude-api.ts` | 不改 | 提取 `assessRisk` 为共享函数 |
| `agent-adapter/src/adapters/risk.ts` | 新建 | 共享风控逻辑（从 claude-api.ts 提取） |
| `agent-adapter/src/adapters/types.ts` | 不改 | AgentEvent 接口不变 |
| `agent-adapter/src/index.ts` | 微调 | ClaudeCodeAdapter 优先级提到 claude-api 之前 |
| `agent-adapter/src/adapters/__tests__/claude.test.ts` | 新建 | 单元测试 |
| `agent-adapter/src/adapters/__tests__/mock-claude.sh` | 新建 | 集成测试 mock 脚本 |
