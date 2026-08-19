# Agent 文字回复摘要回传设计（Stop Hook + Relay Daemon 扩展）

**日期：** 2026-08-19
**阶段：** Phase 3a 补充 — 自动镜像交互模式的文字回复摘要回传
**状态：** 设计阶段
**前置 spec：** `2026-08-15-auto-mirror-hook-design.md`（PreToolUse hook + relay daemon，已交付）

---

## 1. 目标与背景

### 1.1 问题

自动镜像模式已把「工具审批」镜像到眼镜（PreToolUse hook → relay daemon → Core → 眼镜 actionable_card）。但审批通过后，agent 生成的**自然语言文字回复**（例如「已帮你创建 test.txt，内容是 hello glasses」）只显示在用户终端里，戴眼镜时看不到 agent 到底说了什么。

同时，现有审批卡片在 approve/reject 后停在「执行中/处理中」不回显终结态（见 `docs/2026-08-19-auto-mirror-e2e-bugfix.md` Bug 1）。用户需要一个「这一轮 agent 干了什么、说了什么」的摘要回传。

### 1.2 目标

用户终端交互式使用 claude 时，**每轮结束**把 agent 的文字回复用 LLM 压成**一句话摘要**，回传到眼镜 status 卡片（非阻塞、不打断）。

### 1.3 非目标

- 不做流式实时逐句同步（用户已选「每轮结束回传一句话摘要」）
- 不改 Core 协议、不改眼镜端代码、不改 `AgentBridgeClient` 消息协议
- 摘要用 LLM（已定），不引入本地 NLP 摘要

---

## 2. Claude Code Stop hook 机制

### 2.1 为什么是 Stop hook + transcript_path

研究结论（claude-code-guide 查证，2026-08）：

- `PreToolUse` / `PostToolUse` 的 stdin 只有工具名/参数/工具结果，**没有 agent 的文字回复**。
- `Stop` hook 的 stdin 同样**不直接内联** assistant 文本（只有 `stop_hook_active`）。
- **但所有 hook 的 stdin 都带 `transcript_path`** —— 指向当前会话的 JSONL transcript，assistant 文本就写在这个文件里。
- `Stop` 在每轮结束、回复渲染完成后触发，是「这轮文字已经写进 transcript」的可靠时机。

因此可行路径：**Stop hook 脚本读 `transcript_path` → 提取最后一轮 assistant text → 交给 daemon 摘要回传**。不退回 stream-json（headless 专用，会破坏交互式体验）。

### 2.2 配置（`.claude/settings.json`）

```json
{
  "hooks": {
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
  }
}
```

- `Stop` 是会话级事件，**无 `matcher`**（不按工具名过滤，每轮结束都触发一次）。
- `timeout: 30`（秒）：脚本只做「读文件 + 一次 HTTP POST fire-and-forget」，秒级返回，30s 足够宽松。

### 2.3 stdin 载荷（Claude Code → hook 命令）

```json
{
  "session_id": "string",
  "transcript_path": "string",
  "cwd": "string",
  "hook_event_name": "Stop",
  "stop_hook_active": true
}
```

> 实现前用官方 hook 文档核对精确字段名与 JSONL 事件结构（`type:"assistant"` 的 `content`/`stop_reason` 嵌套层级）。以下结构基于 claude-code-guide 查证，落地时以实际 dump 为准。

### 2.4 stdout 响应

Stop hook 不是 permission hook，stdout 无需 `permissionDecision`。脚本 `exit 0`、stdout 输出 `{}` 即可（旁路发送，不影响 Claude Code）。

---

## 3. 组件设计

### 3.1 组件清单

| 组件 | 文件 | 生命周期 | 职责 |
|------|------|---------|------|
| Stop hook 脚本 | `agent-adapter/src/hooks/summary-relay.ts` → `dist/hooks/summary-relay.js` | 短命（每轮结束 spawn 一次） | 读 stdin 取 `transcript_path` → 读 JSONL 提取最后一条 assistant text → `POST /summary` → exit 0 |
| 摘要函数 | `agent-adapter/src/summarize.ts` | 纯函数（daemon 内调用） | LLM 压缩成一句话；失败降级截断 |
| Relay Daemon | `agent-adapter/src/relay.ts`（修改） | 长驻 | 新增 `POST /summary` 端点 → 调摘要 → 发 `task_completed` 卡片 → Core → 眼镜；hash 去重 |
| Hook 配置 | 项目根 `.claude/settings.json`（修改） | 静态 | 新增 `Stop` hook 段（与现有 `PreToolUse` 并存） |

复用不改：`normalizer.ts`（`done` 变体 → `task_completed`）、`ws-client.ts`（`AgentBridgeClient`）、`types.ts`、Core 全部、眼镜端全部。

### 3.2 数据流

```
用户终端 claude 每轮结束
  │
  ▼
Claude Code Stop hook → spawn summary-relay.js
  │  stdin: transcript_path
  ▼
summary-relay.js 读 JSONL
  │  提取最后一条 type:"assistant" stop_reason:"end_turn" 的 text 拼接
  │  （无 text 的纯工具轮 → 直接 exit 0，不发请求）
  ▼
POST http://localhost:8787/summary  { text }
  │  （fire-and-forget，脚本立即 exit 0）
  ▼
relay daemon（长驻）
  │  hash 去重（与上次摘要相同则跳过）
  │  summarize(text) → 一句话摘要（LLM，失败降级截断）
  │  normalizer.fromAgentEvent({ type:"done", text: 摘要 })
  │  → UnifiedMessage task_completed
  ▼
AgentBridgeClient.sendEvent → Core → 眼镜 status 卡片
```

**异步性**：`/summary` 收到即回 `200 {}`，LLM 摘要 + 发卡片在 daemon 后台完成，绝不阻塞 Stop hook（否则拖慢每轮收尾）。

---

## 4. 提取逻辑（JSONL 解析）

summary-relay.js 读 `transcript_path`（逐行 JSON），从**末尾向前**找最后一条满足以下条件的 assistant 事件：

1. `type === "assistant"`
2. 该 message 的 `stop_reason === "end_turn"`
3. `content` 数组里存在 `type === "text"` 的 block

取该事件里所有 `type:"text"` 的 `text` 字段拼接，作为 `text` 提交。

边界：

- **纯工具轮**（最后一轮 assistant 只有 `tool_use` 无 `text`）→ 不发请求，exit 0。
- **多条 text**（agent 分段回复）→ 全部拼接（daemon 侧统一摘要）。
- **transcript 未 flush 完整**（Stop 触发时文件可能还在写）→ 可能拿到截断文本；靠 daemon hash 去重 + 下一轮重捞兜底（§6）。

---

## 5. 摘要（LLM + 降级）

`summarize(text: string): Promise<string>` 在 daemon 内实现（复用长驻进程，避免短命 hook 脚本冷启动 LLM 客户端）。

- **调用**：复用项目已有的 `@anthropic-ai/sdk`（同 `ClaudeAPIAdapter`），环境变量沿用 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`；model 默认 `deepseek-v4-pro`（可 `AGENTBRIDGE_SUMMARY_MODEL` 覆盖）。
- **prompt**：`把下面这段内容压缩成一句话摘要，保留关键信息，不超过 60 字，用原文语言回答：\n\n<text>`
- **超时**：LLM 调用设 `AGENTBRIDGE_SUMMARY_TIMEOUT`（默认 10s）。
- **降级**：LLM 调用失败 / 超时 → 截断 `text` 前 `AGENTBRIDGE_SUMMARY_MAX_LEN`（默认 80）字符回传，保证卡片不丢。

---

## 6. 去重

daemon 维护 `lastSummaryHash`（上次回传的原始 `text` 的 hash）。

- 收到新 `text`，算 hash，与 `lastSummaryHash` 相同 → 跳过（不摘要、不发卡片）。
- 不同 → 更新 `lastSummaryHash`，走摘要 + 发卡片。

用途：防御 transcript flush 延迟导致 Stop 触发时读到**不完整或重复**的文本（下一轮会捞到完整版并正常回传）。

---

## 7. 配置

| 配置 | 位置 | 默认值 | 说明 |
|------|------|--------|------|
| `AGENTBRIDGE_SUMMARY_MODEL` | relay daemon env | `deepseek-v4-pro` | 摘要用 LLM 模型 |
| `AGENTBRIDGE_SUMMARY_TIMEOUT` | relay daemon env | `10000` | LLM 调用超时（ms） |
| `AGENTBRIDGE_SUMMARY_MAX_LEN` | relay daemon env | `80` | 降级截断长度（字符） |
| Stop hook `timeout` | `.claude/settings.json` | `30` | hook 命令超时（秒） |

其余（`RELAY_PORT` / `AGENTBRIDGE_URL` / `AGENTBRIDGE_SESSION`）复用现有 relay daemon 配置。

---

## 8. 测试策略

### 8.1 单元测试（node:test，无需真机）

| 测试 | 验证点 |
|------|--------|
| JSONL 提取（`summary-relay.ts` 纯函数） | 给定多行 JSONL → 正确取最后一条 `end_turn` 的 text 拼接 |
| 纯工具轮 | 最后一条 assistant 无 `text` → 返回空、不发请求 |
| 多 content block | 只取 `type:"text"` 的块，跳过 `tool_use` |
| `summarize` 降级 | mock LLM 抛错 → 返回截断前 N 字 |
| `summarize` 成功 | mock LLM 返回 → 透传一句话摘要 |
| hash 去重 | 相同 `text` 第二次 → 跳过；不同 `text` → 处理 |

### 8.2 集成测试（mock）

- daemon 注入 mock `AgentBridgeClient`：`POST /summary` → 断言 `sendEvent` 收到一条 `task_completed`（body 为摘要）。
- 相同 text 两次 POST → 只发一次卡片。

### 8.3 E2E（真机，复用自动镜像环境）

```bash
# 1. 起 Core
cd middleware-core && AGENTBRIDGE_ADDR=:8088 go run cmd/server/main.go &

# 2. 起 relay daemon（带摘要 env）
cd agent-adapter && AGENTBRIDGE_URL=http://localhost:8088 AGENTBRIDGE_SESSION=default \
  AGENTBRIDGE_CORE_TIMEOUT=120000 node dist/relay.js &

# 3. 用户终端交互式 claude（settings.json 已配 Stop hook）
claude
```

| # | 场景 | 预期 |
|---|------|------|
| 1 | 让 claude 写文件并说明结果 | 眼镜收到 `task_completed` status 卡片，body 为一句话摘要 |
| 2 | 让 claude 读文件并总结内容 | 眼镜收到摘要卡片（agent 的总结文字） |
| 3 | 连续两轮不同回复 | 各自回传摘要，不串、不丢 |

---

## 9. 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `agent-adapter/src/hooks/summary-relay.ts` | 新建 | Stop hook 脚本：stdin → JSONL 提取 → POST /summary |
| `agent-adapter/src/summarize.ts` | 新建 | LLM 摘要 + 降级截断 |
| `agent-adapter/src/relay.ts` | 修改 | 新增 `POST /summary` 端点 + hash 去重 + 发卡片 |
| `agent-adapter/src/__tests__/summary-relay.test.ts` | 新建 | JSONL 提取纯函数测试 |
| `agent-adapter/src/__tests__/summarize.test.ts` | 新建 | 摘要/降级测试 |
| `agent-adapter/src/__tests__/relay.test.ts` | 修改 | 追加 `/summary` 集成测试 |
| `.claude/settings.json` | 修改 | 新增 `Stop` hook 段 |
| `agent-adapter/package.json` | 修改 | test script 追加新测试 |

复用不改：`normalizer.ts`、`types.ts`、`ws-client.ts`、`risk.ts`、Core、眼镜端。

---

## 10. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-08-19 | 初版：Stop hook + transcript_path 读 JSONL + LLM 摘要一句话 + 所有轮次回传。决策：回传范围=所有轮次（YAGNI，后续可加「仅审批轮次」过滤）；摘要=LLM（降级截断） |
