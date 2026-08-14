# 审批卡片交互 UX 设计 — 执行反馈 + view_details

日期: 2026-08-14
状态: 设计稿待确认

## 1. 背景与问题

Phase 3a 真机 E2E 已跑通审批闭环（`claude 工具调用 → 风控 → 审批卡 → 手势 → 执行/拒绝`），但交互体验有两个缺口：

1. **审批后卡片冻结**：用户单击 approve / 双击 reject 后，眼镜卡片停留在「⛔ 审批: Approval required: Write」，既不显示执行反馈，任务完成后也不消失。
2. **view_details 无内容**：审批卡只显示一行简略文字（`风险: 40% | Risk score: 0.4`），用户看不到 agent 到底要改哪些文件、执行什么命令。已有的 `view_details` 手势（滑动）无任何响应。

## 2. 根因

### 2.1 卡片冻结根因

`AgentActionHandler.reduce()`（`agent/AgentActionHandler.kt:51-58`）的「卡片保护」：当当前卡片是 `actionable_card` 时，后续 `status_card`（含 `task_completed`）与 `task_started`/`task_running`/`heartbeat` 事件一律被吞掉，卡片不更新。

同时 Core 的 `relayUserAction`（`middleware-core/cmd/server/main.go:268-305`）只把 approve/reject 回推给 `DeviceAgentAdapter`，**不回推眼镜**。眼镜无从得知「决策已被受理」。

二者叠加 → 卡片永久冻结在审批态。

### 2.2 view_details 无内容根因

`dispatcher.glassNeedsApproval`（`middleware-core/internal/device/dispatcher.go:110-133`）用 `glassSummary(msg.Body, 140)` 只取 body 的**第一行**。normalizer 生成的 body 是三行：

```
Risk score: 0.4
Command: <cmd>
Tool input: {...}
```

第一行之后全被截断丢弃，眼镜实际只看到 `风险: 40% | Risk score: 0.4`。同时 Core 的 `ActionViewDetails` 分支是 TODO（`main.go:261-264`），没有任何回推。

## 3. 设计概览

整体策略：**眼镜本地状态机为主，协议只做「携带详情」的最小扩展**，不改 Core 的审批/分发逻辑。

- **Feature 1（执行反馈）**：纯眼镜端改动。眼镜在收到 approve/reject 手势后本地切到「执行中 / 已拒绝」，放松卡片保护，让后续 `task_running`（agent 真实输出）渲染，`task_completed` 到达后短暂显示「完成」再自动清除。**Core 零改动。**
- **Feature 2（view_details）**：adapter 捕获 reasoning + 完整 input 随 `needs_approval` 下发；协议新增 `details` 字段；眼镜本地 toggle 详情/摘要。Core 只改 dispatcher 一个字段映射，不做 view_details 回推。

## 4. Feature 1: 执行反馈卡片（眼镜本地状态机）

### 4.1 状态与转换

```
[审批中]  actionable_card (needs_approval)
   │ 单击 approve ───────────────┐
   │ 双击 reject ──────────┐     │
   │                       ▼     ▼
   │              [已拒绝] rejected_card   [执行中] executing_card
   │                       │              │
   │                       │              │  ← task_running 到达（agent 真实输出）
   │                       │              ▼
   │                       │         [运行中] status_card (◉ Agent output)
   │                       │              │
   └──── task_completed 到达（无手势兜底） │
                          ▼              ▼
                    [完成] status_card (✓ 完成)
                          │  ← 延迟 3s 自动清除
                          ▼
                    [空闲] status_card (等待下一个任务…)
```

### 4.2 改动点

**`AgentCardState`（`agent/AgentBridgeProtocol.kt:63-75`）新增字段：**

```kotlin
val decision: String = "",        // "" = 未决策, "approve", "reject"
val details: String = "",         // 详情全文（见 Feature 2）
val detailsVisible: Boolean = false
```

**`AgentActionHandler`：**

1. 新增 `onDecision(actionType: String)` 私有方法，在 `onKey`（`:93-117`）和 `onGestureResult`（`:119-128`）发送 approve/reject **成功**后调用：
   - `approve` → `renderHint = "executing_card"`, `title = "⏳ 执行中"`, `body = "已批准，等待 agent 输出…"`, `quickActions = []`。
   - `reject` → `renderHint = "rejected_card"`, `title = "⛔ 已拒绝"`, `body = "已拒绝该操作，等待 agent 回复…"`, `quickActions = []`。
2. 修改卡片保护条件（`:52`），**同时**放开「已决策」与「任务完成」两种情况：
   ```kotlin
   if (currentState.renderHint == "actionable_card"
       && currentState.decision.isEmpty()
       && event?.eventType != "task_completed"
       && (renderHint == "status_card" || event?.eventType in CARD_PRESERVED_EVENTS)) {
       return currentState  // 仍保护
   }
   ```
   即：一旦用户做了决策（`decision` 非空），或 `task_completed` 到达（超时自动放行等无手势场景的兜底），保护立即失效。
3. `reduce()` 里对 `task_completed` 到达时启动一个 3s 的 `Handler.postDelayed` 自动重置为 idle 态（`title="AgentBridge"`, `body="等待下一个任务…"`, `renderHint="status_card"`, `decision=""`）。

**`CardRenderer`：**

- `containerColor`（`:130-137`）新增两档：`executing_card` → 蓝 `0xFF1F3A5F`，`rejected_card` → 暗红 `0xFF5C2A2A`。
- `actionHint`（`:139-143`）：`executing_card`/`rejected_card` 时不显示 CLICK/DOUBLE 提示，改为单行状态（如 `处理中…` / `已拒绝`）。

## 5. Feature 2: view_details

### 5.1 详情内容

详情 = **agent reasoning（工具调用前的 assistant 文本）+ 完整 tool input（command / file_path / 参数）**。

### 5.2 数据流

```
Claude SDK assistant 文本 → adapter 记录 lastAssistantText
        ↓
canUseTool 触发 needs_approval，附 reasoning = lastAssistantText
        ↓
normalizer: details = reasoning + Command + Tool input（完整，不截断）
        ↓
Core dispatcher: DeviceOutput.card_details = msg.Details
        ↓
眼镜: AgentCardState.details 落库 → view_details 手势 toggle 显示
```

### 5.3 改动点

**adapter `types.ts`（`:32`）**：`needs_approval` 事件新增 `reasoning?: string`。

**adapter `claude.ts`**：

- 新增实例字段 `lastAssistantText: string = ""`。
- `mapClaudeSDKMessage` 产出 `text` 事件时同步更新 `lastAssistantText`（在 `send()` 的消息循环里，`text` 事件 push 前记录）。
- `canUseTool`（`:239-245`）emit `needs_approval` 时附 `reasoning: this.lastAssistantText`。

**adapter `normalizer.ts`**：

- `fromAgentEvent`（`:140-163`）返回的 UnifiedMessage 新增 `details` 字段：`needs_approval` 时 = `[reasoning].filter(Boolean) + Command + Tool input` 拼接的多行全文；其他事件类型留空。
- 现有 `body` 保持短摘要不变（risk 行）。

**Core `domain/types.go`**：

- `UnifiedMessage`（`:84-100`）新增 `Details string \`json:"details,omitempty"\``。
- `DeviceOutput`（`:115-122`）新增 `CardDetails string \`json:"card_details,omitempty"\``。

**Core `dispatcher.go`**：

- `glassNeedsApproval`（`:110-133`）：`CardBody` 保持短摘要；`CardDetails = msg.Details`（为空时回退 `msg.Body`）。

**眼镜端**：

- `AgentBridgeProtocol.kt`：`UnifiedMessage`（`:18-31`）新增 `@SerializedName("details") val details: String = ""`；`DeviceOutput`（`:39-46`）新增 `@SerializedName("card_details") val cardDetails: String = ""`。
- `AgentActionHandler.reduce()`：`details` 取 `output?.cardDetails ?: event?.details ?: ""`。
- `onGestureResult` 收到 `view_details` 时：若 `details` 非空，`detailsVisible = !detailsVisible`（本地 toggle）。详情不依赖 Core 回推——Core 的 `ActionViewDetails` 保持 no-op（仅日志），`view_details` 手势照常 send 上去也无副作用。
- `CardRenderer`：`AgentCard` 当 `detailsVisible` 时，body 区域渲染 `card.details`（`maxLines` 提高，如 10 行 + 可滚动），否则渲染短 `card.body`。

## 6. 手势统一

真机验证的权威手势（Phase 2 场景 3/4/5，keyCode 走 `MainActivity.onKeyDown` → `GestureHandler`）：

| 手势 | keyCode | 动作 |
|------|---------|------|
| 单击 | `KEYCODE_NOTIFICATION`(83) | approve |
| 双击 | 83 × 2 | reject |
| 滑动 | `DPAD_UP`(19) / `DPAD_DOWN`(20) | view_details |
| 返回 | `KEYCODE_BACK` | reject |

**修复不一致**：`AgentActionHandler.onKey`（`:97`）把 `LONG_PRESS -> "view_details"`，`CardRenderer.actionHint`（`:142`）硬编码 `LONG: view_details` —— 均与真机验证的「滑动」不符。统一为：view_details 权威手势 = **滑动（DPAD）**，走 `GestureHandler.onKeyDown → MainViewModel.onGesture → onGestureResult`；`actionHint` 改显示 `SWIPE: view_details`；`AgentActionHandler.onKey` 的 `LONG_PRESS` 不再映射 view_details（保留为无操作或后续复用）。

## 7. 协议变更汇总

| 层 | 字段 | 类型 | 说明 |
|----|------|------|------|
| adapter AgentEvent | `reasoning` | `string?` | 工具调用前的 assistant 文本 |
| UnifiedMessage | `details` | `string` | needs_approval 的完整详情全文 |
| DeviceOutput | `card_details` | `string` | 眼镜端详情渲染源 |

无新增事件类型、无新增 action 类型、无新增设备类型。

## 8. 涉及文件

- `rokid-sdk/.../agent/AgentActionHandler.kt` — 决策状态机 + 保护放宽 + 完成清除
- `rokid-sdk/.../agent/CardRenderer.kt` — 新 renderHint 颜色 + 详情渲染 + actionHint 修正
- `rokid-sdk/.../agent/AgentBridgeProtocol.kt` — AgentCardState/UnifiedMessage/DeviceOutput 新字段
- `agent-adapter/src/adapters/types.ts` — needs_approval 加 reasoning
- `agent-adapter/src/adapters/claude.ts` — 记录 lastAssistantText + 附 reasoning
- `agent-adapter/src/normalizer.ts` — 生成 details
- `middleware-core/internal/domain/types.go` — UnifiedMessage.Details + DeviceOutput.CardDetails
- `middleware-core/internal/device/dispatcher.go` — glassNeedsApproval 填 card_details

## 9. 非目标（本次不做）

- 不改 Core 审批/分发逻辑：`approvalMgr`、`relayUserAction` 保持「只回推 adapter」。
- 不做 Core 端 view_details 回推（`ActionViewDetails` TODO 保持 no-op；详情走眼镜本地 toggle）。
- 不启用 `RawEvidence` 既有字段（YAGNI，用 plain `details` 字符串即可）。
- 不改手机端 / 耳机 / dashboard。
- 超时自动放行（无手势）场景：靠「task_completed 兜底清除」解决卡片僵死，但不做「已超时」的主动提示卡。

## 10. 测试与验收

- **眼镜端单测**（`AgentActionHandler` reduce/onKey 逻辑）：
  - approve 后 `renderHint` 变 `executing_card`，`task_running` 不再被吞。
  - reject 后变 `rejected_card`。
  - 无手势场景 `task_completed` 到达时卡片不再冻结。
  - `task_completed` 后 3s 重置 idle（用 fake 时钟）。
  - `view_details` toggle `detailsVisible`。
- **Core 单测**（dispatcher）：`glassNeedsApproval` 对含 `details` 的 msg 生成非空 `CardDetails`，`CardBody` 仍为短摘要。
- **adapter 单测**：`needs_approval` 载荷含 `reasoning`，normalizer 生成 `details` 含 command + input。

### 真机验收矩阵

| # | 场景 | 预期 |
|---|------|------|
| 1 | 写文件 → 单击 approve | 卡片 审批→「⏳ 执行中」→「◉ Agent output」→「✓ 完成」→ 3s 后消失 |
| 2 | 删除 → 双击 reject | 卡片 审批→「⛔ 已拒绝」→ agent 回复 →「✓ 完成」→ 消失 |
| 3 | 审批中滑动 | 卡片展开详情：reasoning + 命令 + 文件路径；再滑动收回；单击/双击仍可审批 |
| 4 | 只读工具自动放行 | 无审批卡，直接「◉ Agent output」→「✓ 完成」→ 消失 |
| 5 | 超时自动放行（无手势） | 审批卡冻结期间，任务完成后经 task_completed 兜底清除 |
