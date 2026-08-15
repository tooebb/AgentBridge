# 自动镜像交互模式设计（PreToolUse Hook + Relay Daemon）

**日期：** 2026-08-15
**阶段：** Phase 3a 补充 — 真实交互式 Claude Code 会话的眼镜审批镜像
**状态：** 设计阶段
**前置 spec：** `2026-08-11-claude-code-adapter-v2-design.md`（Phase 3a headless MVP，已交付）

---

## 1. 目标与背景

### 1.1 问题

Phase 3a 交付的 `ClaudeCodeAdapter` 走的是 **headless 一次性** 路线：`AGENTBRIDGE_PROMPT` 塞一段 prompt，Agent SDK `query()` 驱动 `claude -p` 跑完一次就结束。

用户真正要的是：**在自己终端里正常、交互式地使用 Claude Code，眼镜自动镜像每一次工具审批**——而不是另起一个一次性进程。

### 1.2 目标

用户在终端里正常敲 `claude`（交互模式，带完整项目上下文、CLAUDE.md、git、文件树），每当 Claude Code 要执行一个高风险工具（Bash / Edit / Write 等）时：

1. 工具调用被拦截
2. 审批请求自动镜像到眼镜（actionable_card）
3. 用户单击 approve / 双击 reject
4. 决定回传，Claude Code 继续执行或换方案

数据流（核心）：

```
用户在终端交互式用 claude
  │  高风险工具调用
  ▼
Claude Code PreToolUse hook（同步阻塞）
  │  stdin: tool_name / tool_input / tool_use_id / cwd
  ▼
approval-relay.js（短命 hook 脚本）
  │  HTTP POST /approve → localhost:8787
  ▼
relay.ts（长驻 daemon，持唯一 agent_adapter WS 连接）
  │  needs_approval（task_id = tool_use_id）→ Core → 眼镜
  │  user_action（approve/reject）← Core ← 眼镜
  ▼
approval-relay.js 收到决定 → stdout permissionDecision → claude 继续/拒绝
```

### 1.3 为什么用 PreToolUse hook 而不是 Agent SDK

| 维度 | Agent SDK（Phase 3a） | PreToolUse hook（本设计） |
|------|----------------------|--------------------------|
| 会话形态 | headless（`claude -p`，SDK 代管） | 交互式（用户自己终端里的 `claude`） |
| 谁发起 | adapter 进程塞 prompt | 用户本人 |
| 项目上下文 | 有（SDK 传 cwd） | 完整（用户终端环境） |
| 拦截点 | `canUseTool` 回调 | 原生 PreToolUse hook |

Agent SDK 无法接管一个**用户已经在交互式运行**的 claude 会话——它是自己 spawn 一个 `-p` 进程。要让「用户正在用的终端会话」接入眼镜，唯一的原生挂载点是 Claude Code 的 **hook 机制**（`PreToolUse` 事件），它在工具执行前同步阻塞，正好是审批拦截点。

### 1.4 非目标

- 不改 Core 协议、不改眼镜端代码（审批链路完全复用现有 `needs_approval` / `available_actions` / `approve` / `reject` 语义）
- 不做通用插件生态
- 不封堵 `--bare` / `disableAllHooks` 逃逸口（见 §9 安全，决策已定）
- 不替代 Phase 3a 的 headless adapter——两者并存（headless 用于自动化脚本，hook 镜像用于日常交互）

---

## 2. Claude Code PreToolUse hook 机制

### 2.1 配置方式（`.claude/settings.json`）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/agent-adapter/dist/hooks/approval-relay.js",
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

- `matcher` 是工具名正则，只有匹配的工具才触发 hook。只读工具（Read/Grep/Glob 等）不匹配 → 零开销，自然静默。
- `permissions.allow` **必须**包含这些工具：hook 返回 `allow` **不会**绕过 Claude Code 的权限系统——若工具不在 allow 列表里，hook 放行后终端仍会弹交互式权限提示，破坏「自动镜像」体验。加入 allow 后，权限决定权完全交给 hook。
- `timeout`：单个 hook 命令的等待上限（秒）。默认 600s，这里显式设 180s（> daemon 的 120s 审批超时，见 §8）。

### 2.2 stdin 载荷（Claude Code → hook 命令）

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/x" },
  "tool_use_id": "string"
}
```

> 实现前用官方 hook 文档核对精确字段名。上述字段在 2026-08 已通过 claude-code-guide 查证，但 hook schema 属实现临界细节，落地时以官方文档为准。

### 2.3 stdout 响应（hook 命令 → Claude Code）

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "approved from glasses"
  }
}
```

- `permissionDecision` ∈ `allow` | `deny` | `ask`。本设计只用 `allow` / `deny`。
- **exit 0** + 上述 JSON = 采纳该决定。
- **exit 2** = 硬阻止（本设计不使用，仅作 hook 脚本崩溃时的兜底语义）。
- 超时（`timeout` 字段）→ hook **FAILS OPEN**（视同 `allow`）。

### 2.4 关键约束（设计前提）

1. hook 是**同步阻塞**的：Claude Code 会等待 hook 命令 stdout 输出 + exit 才继续。这正是「挂起等眼镜审批」的挂载点。
2. hook 命令是**短命**的：每次工具调用 spawn 一次。因此审批的「等待」不能放在 hook 脚本里长轮询 WS——必须交给一个长驻进程（relay daemon），hook 脚本只做一次 HTTP 请求。
3. `permissions.allow` 与 hook 必须**成对配置**，缺一不可。

---

## 3. 组件设计

### 3.1 组件清单

| 组件 | 文件 | 生命周期 | 职责 |
|------|------|---------|------|
| Relay Daemon | `agent-adapter/src/relay.ts` → `dist/relay.js` | 长驻（用户手动启动，或由启动脚本拉起） | 持唯一 `agent_adapter` WS 连接；HTTP 服务接收 hook 请求；审批等待与决定回传 |
| Hook 脚本 | `agent-adapter/src/hooks/approval-relay.ts` → `dist/hooks/approval-relay.js` | 短命（每次工具调用 spawn 一次） | 读 stdin、算风险、HTTP 请求 daemon、stdout 输出决定 |
| Hook 配置 | 项目根 `.claude/settings.json` | 静态 | PreToolUse matcher + permissions.allow |
| 风控 | `agent-adapter/src/risk.ts` | 复用，不改 | `assessRisk()` 分级 |

复用不改：`normalizer.ts`（AgentEvent → UnifiedMessage）、`ws-client.ts`（`AgentBridgeClient`）、Core 全部、眼镜端全部。

### 3.2 Relay Daemon 内部结构

```
┌─────────────────────────────────────────────────┐
│ relay.ts (长驻进程)                              │
│                                                 │
│  HTTP server (localhost:8787)                   │
│    POST /approve  ← hook 脚本                    │
│      → 生成 task_id = tool_use_id               │
│      → 发 needs_approval 到 Core                │
│      → 挂起该 HTTP response（等 user_action）    │
│                                                 │
│  AgentBridgeClient (device_type=agent_adapter)   │
│    sendEvent(needs_approval) → Core → 眼镜      │
│    on('user_action') ← Core                     │
│      → 按 task_id 匹配挂起的审批请求             │
│      → resolve 对应 HTTP response               │
│                                                 │
│  超时定时器：120s 未收到决定 → auto-allow        │
└─────────────────────────────────────────────────┘
```

**为什么必须有 daemon**：Core 的 `hub.go` 对每个 `device_type` 只保留**一条** WS channel（`s.Devices[deviceType] = ch`，后连覆盖先连）。若每个 hook 脚本各自连 Core（同为 `agent_adapter`），会互相覆盖、丢消息。因此需要一个唯一的长驻 daemon 持有这条连接，所有 hook 脚本通过本地 HTTP 复用。

### 3.3 Hook 脚本逻辑

```
读 stdin JSON → { tool_name, tool_input, tool_use_id, cwd }
  │
  risk = assessRisk(tool_name, tool_input)
  │
  ├─ risk < threshold → stdout allow（直接放行，不打扰眼镜）
  │
  └─ risk >= threshold
       │  POST http://localhost:8787/approve
       │  body: { tool_use_id, tool_name, tool_input, risk, cwd }
       │  await 响应（daemon 挂起，等眼镜决定）
       ▼
     stdout { permissionDecision: "allow" | "deny" }
```

> 当前 `RISK_RULES` 下 matcher 命中的 `Bash|Edit|Write` 风险都 ≥ 0.3，实际都会走审批。`assessRisk` 在 hook 脚本里再做一次分级是为了：未来若要把「只读 bash 命令」（`ls`/`git status`）从 matcher 里放进来静默，无需改 daemon，只改规则表。

### 3.4 关联键：`tool_use_id` 复用为 `task_id`

- hook 载荷自带 `tool_use_id`（每次工具调用全局唯一）。
- daemon 用 `tool_use_id` 作为 `needs_approval` 的 `task_id` 发给 Core。
- Core 的 `approvalMgr` 以 `taskID` 为 key 做审批去重与关联（`byTask` map）。
- 眼镜 approve/reject 后，Core 将 `user_action`（带 `task_id`）relay 回 `agent_adapter` channel。
- daemon 按 `task_id` 匹配挂起的 HTTP 请求并 resolve。

**零 Core / 眼镜协议改动**——`task_id` 本来就是透传字符串，Core 只做「同 key 关联 + 去重」。

---

## 4. 审批流（端到端）

```
1. 用户在终端交互式 claude 里让 agent 执行 `Bash: rm -rf foo`
2. Claude Code 触发 PreToolUse hook（matcher 命中 Bash）
   → spawn node approval-relay.js，stdin 传 tool_name/tool_input/tool_use_id
3. hook 脚本 assessRisk("Bash", {command:"rm -rf foo"}) → 0.9 ≥ 0.3
   → HTTP POST /approve 到 daemon（body 含 tool_use_id + 风险 + 输入）
4. daemon 构造 AgentEvent { type:"needs_approval", tool:"Bash", risk:0.9,
     taskId: tool_use_id, input } → normalizer → UnifiedMessage
   → AgentBridgeClient.sendEvent → Core
5. Core 处理 → 眼镜 actionable_card（⛔ 审批：rm -rf foo）
6. daemon 挂起对应 HTTP response，同时启动 120s 超时定时器
7. 用户双击 reject → 眼镜发 action → Core relay user_action(task_id=tool_use_id)
   → daemon on('user_action') 匹配 → resolve HTTP 请求 → hook 脚本 stdout deny
8. Claude Code 收到 deny → 工具不执行 → agent 换方案 / 结束
```

approve 同流程，第 7 步单击 → `permissionDecision: allow`。

---

## 5. 风控分级

完全复用 `agent-adapter/src/risk.ts` 的 `assessRisk()` 与 `RISK_RULES`（Phase 3a 已落地，零改动）：

| 工具/命令 | risk | matcher 命中？ | 结果 |
|-----------|------|---------------|------|
| Read / Grep / Glob / search | 0 | 否（matcher 不含） | 不触发 hook，静默放行 |
| Bash（普通命令） | 0.3 | 是 | 弹卡 |
| Write / Edit | 0.4 | 是 | 弹卡 |
| Bash git push / npm publish | 0.6 | 是 | 弹卡 |
| Bash git push -f | 0.85 | 是 | 弹卡 |
| Bash rm -rf / sudo / chmod | 0.9 | 是 | 弹卡 |

阈值 `AGENTBRIDGE_RISK_THRESHOLD`（默认 0.3）可覆盖。

---

## 6. 超时与异常处理

| 场景 | 行为 |
|------|------|
| 用户长时间不操作眼镜 | daemon 120s 超时 → auto-allow（**决策 2 = A**），响应 hook allow，Claude Code 继续 |
| hook 命令超时 | Claude Code 侧 `timeout: 180`（> daemon 120s）→ 正常不会触发；若真超时 FAILS OPEN = allow，与 auto-allow 语义一致 |
| Core 不可达 | daemon 的 `AgentBridgeClient` 自动重连（指数退避 2-30s）；审批请求挂起，120s 超时兜底 auto-allow |
| 眼镜断连 | 同上，靠超时兜底 |
| daemon 进程崩溃 | 所有挂起的 hook 请求随 HTTP 连接断开；hook 脚本收到连接错误 → 应输出 `allow`（FAILS OPEN，避免卡死用户终端会话） |
| hook 脚本崩溃（非 exit 0） | Claude Code 视为 hook 失败；exit 2 = 硬阻止，其它非零 exit 行为以官方文档为准 |

**超时参数层级**：

```
daemon 审批超时 (120s)  <  hook timeout (180s)  <  Claude Code 默认上限 (600s)
```

确保「daemon 先超时响应，hook 再超时」的因果顺序。

---

## 7. 配置

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `RELAY_PORT` | relay.ts env | `8787` | daemon HTTP 监听端口 |
| `AGENTBRIDGE_URL` | relay.ts env | `http://localhost:8088` | Core 地址 |
| `AGENTBRIDGE_SESSION` | relay.ts env | `default` | 会话 ID（须与眼镜同 session） |
| `AGENTBRIDGE_RISK_THRESHOLD` | hook 脚本 env | `0.3` | 审批触发阈值 |
| `AGENTBRIDGE_CORE_TIMEOUT` | relay.ts env | `120000` | daemon 审批超时 auto-allow（ms）；`0` = 无限等待 |
| hook `matcher` | `.claude/settings.json` | `Bash\|Edit\|Write` | 触发 hook 的工具 |
| hook `timeout` | `.claude/settings.json` | `180` | hook 命令超时（秒） |
| `permissions.allow` | `.claude/settings.json` | `["Bash","Edit","Write"]` | hook 决定权限，抑制终端提示 |

---

## 8. 安全（决策 1 = A：文档记录 + 不封堵）

### 8.1 逃逸口

Claude Code 有两个 CLI 参数可绕过所有 hook：

- `claude --bare`：不加载 hooks、权限提示
- `claude --settings '{"disableAllHooks":true}'`：只关 hooks

效果：眼镜审批被完全跳过，工具直接执行。

### 8.2 决策

**不技术封堵**，仅在本文档与 README 明确记录该限制。理由：

1. 技术上封堵需用 wrapper 替换 `claude` 命令拦截 flag——脆弱，且用户仍可直接调原始 `claude` 二进制绕过，根本封不住。
2. hook 是**用户自愿配置的镜像**，绕过 hook 本质是「用户主动选择不走眼镜审批」，不是被攻破的安全边界。
3. 眼镜审批的定位是「辅助确认 + 远程监督」，不是对抗性访问控制（那是认证/安全层的事，Phase 3 后续项）。

### 8.3 记录措辞（写入 README）

> 自动镜像依赖 Claude Code hook。若以 `--bare` 或 `--settings '{"disableAllHooks":true}'` 启动 claude，hook 不加载，眼镜将不会收到审批卡片。这是 Claude Code 的 CLI 设计，非 AgentBridge 可封堵；请勿在需要眼镜监督的场景下使用这些参数。

---

## 9. 测试策略

### 9.1 单元测试（node:test，无需真机）

| 测试 | 验证点 |
|------|--------|
| `assessRisk`（复用现有测试） | 已有覆盖，无需新增 |
| hook 脚本 stdin 解析 | 从假 stdin JSON 提取 `tool_name/tool_input/tool_use_id/cwd` |
| hook 脚本 risk 分支 | risk < threshold → stdout allow；≥ threshold → 发起 HTTP 请求 |
| daemon 审批关联 | 两个并发 `/approve` 请求，各自 tool_use_id，按 task_id 精确 resolve，不串线 |
| daemon 超时 | 挂起请求 120s（测试用短超时注入）未 resolve → auto-allow |
| daemon reject/approve 映射 | user_action approve → resolve allow；reject → resolve deny |

### 9.2 集成测试（mock）

- daemon 注入 mock `AgentBridgeClient`：`sendEvent` 后手动触发 `user_action`，断言 HTTP 请求被正确 resolve。
- hook 脚本 + 本地 daemon 联调：起 daemon，直接 POST `/approve`，模拟 user_action，断言 hook stdout。

### 9.3 E2E（真机，4 场景复用 Phase 3a 语义）

```bash
# 1. 起 Core
cd middleware-core && AGENTBRIDGE_ADDR=:8088 go run cmd/server/main.go &

# 2. 起 relay daemon
cd agent-adapter && AGENTBRIDGE_URL=http://localhost:8088 AGENTBRIDGE_SESSION=default \
  AGENTBRIDGE_CORE_TIMEOUT=120000 node dist/relay.js &

# 3. 用户在终端正常交互式 claude（settings.json 已配 hook）
claude
```

| # | 场景 | 预期 |
|---|------|------|
| 1 | 只读工具（Grep/Read） | 不触发 hook，眼镜无卡片 |
| 2 | 写文件（Write）→ 单击 approve | 眼镜弹卡 → 工具执行 → 文件创建 |
| 3 | 删除（Bash rm）→ 双击 reject | 眼镜弹卡 → 工具不执行 → agent 换方案 |
| 4 | 高风险工具不操作 → 120s | 眼镜弹卡 → 超时 auto-allow → 工具执行 |

---

## 10. 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `agent-adapter/src/relay.ts` | 新建 | relay daemon：HTTP server + 唯一 agent_adapter WS 连接 + 审批等待 |
| `agent-adapter/src/hooks/approval-relay.ts` | 新建 | hook 脚本：stdin 解析 → assessRisk → HTTP → stdout 决定 |
| `.claude/settings.json` | 新建 | PreToolUse hook 配置 + permissions.allow（若已存在则合并 hooks/permissions 段） |
| `agent-adapter/src/risk.ts` | 复用 | 零改动 |
| `agent-adapter/src/normalizer.ts` | 复用 | 零改动 |
| `agent-adapter/src/ws-client.ts` | 复用 | 零改动 |
| `agent-adapter/src/__tests__/relay.test.ts` | 新建 | daemon 单元/集成测试 |
| `agent-adapter/src/__tests__/approval-relay.test.ts` | 新建 | hook 脚本单元测试 |
| `agent-adapter/package.json` | 修改 | `build` 输出需包含 `dist/hooks/`；可能新增 `start:relay` script |
| `README` / CLAUDE.md | 修改 | 记录自动镜像用法 + 安全逃逸口（§8.3） |

---

## 11. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-15 | 初版：PreToolUse hook + relay daemon 自动镜像设计。决策 1 = 文档记录不封堵逃逸口；决策 2 = 超时 auto-allow |
