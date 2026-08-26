# 眼镜卡片常亮 + 手势重设计 设计文档

**日期**：2026-08-26
**状态**：待评审（真机风险见末尾，需用户确认）

## 目标

回复/状态卡片不再快速熄屏，卡片长亮直到用户主动操作。新增两条手势：

- **双击**（非审批卡）= 清空卡片回到待语音，之后单击即可开始下一段语音输入
- **向镜片滑动** = 熄屏省电（卡片内容保留），**单击**唤回同一张卡

审批链路（单击=批准 / 双击=拒绝 / 滑动=展开全文）**保持不变**。

## 现状问题

1. `CardStateMachine.shouldKeepScreenOn` 只对 `actionable_card / executing_card / rejected_card / alert_card` 锁屏；`status_card`（回复卡、进行中卡）不锁屏 → 眼镜按系统超时快速熄屏，用户来不及看。
2. `AgentActionHandler.AUTO_CLEAR_DELAY_MS = 15s` 自动清空卡片，且存在 desync bug：`scheduleAutoClear()` 只更新 `handler.currentState`，不更新 `_agentCard`，UI 状态与状态机状态不一致。
3. 手势层面，向镜腿(19)与向镜片(20)目前都映射为 `view_details`，没有熄屏手势。

## 设计

### 1. 状态模型：`screenOff` 字段

`AgentCardState`（`agent/AgentBridgeProtocol.kt`）新增：

```kotlin
val screenOff: Boolean = false
```

语义：
- `false`（默认）：正常显示卡片 + 锁屏
- `true`：渲染黑屏 + 释放 WakeLock；`title/body/renderHint/taskId` 等**全部保留**，唤回时原样恢复

### 2. 手势映射（最终）

| 物理手势 | keycode | actionType | 审批卡 | 非审批卡 |
|---------|---------|-----------|--------|---------|
| 单击 | KEYCODE_NOTIFICATION | approve | 批准 | 开始/停止语音 |
| 双击 | KEYCODE_NOTIFICATION×2 | reject | 拒绝 | 清空卡 → 待语音 |
| 向镜腿滑 | KEYCODE_DPAD_UP (19) | view_details | 展开全文 | 展开全文 |
| 向镜片滑 | KEYCODE_DPAD_DOWN (20) | screen_off | 熄屏 | 熄屏 |
| 返回键 | KEYCODE_BACK | reject | 拒绝 | 同双击（清空卡） |

> ⚠️ **方向映射需真机确认**：`向镜腿=19 / 向镜片=20` 来自 CLAUDE.md 记录。若实际方向相反，则「展开全文」与「熄屏」两手势对调，一行常量互换即可，不影响其余逻辑。

### 3. onGesture 路由（`MainViewModel.onGesture`）

```
onGesture(actionType):
  card = agentCard.value

  if actionType == "screen_off":                 // 全局：任何卡（含审批）都可熄屏
      _agentCard.value = CardStateMachine.setScreenOff(card, true); return
  if actionType == "view_details":               // 全局：向镜腿 = 展开全文
      _agentCard.value = CardStateMachine.onViewDetails(card); return

  if card.screenOff:                             // 熄屏态
      if actionType == "approve":                //   单击 = 唤回同一张卡
          _agentCard.value = CardStateMachine.setScreenOff(card, false)
      return                                     //   其余手势无操作

  if CardStateMachine.shouldRouteToApproval(card):   // actionable_card
      client = agentClient
      if client == null: return
      sent = client.sendAction(card.taskId, actionType)   // approve / reject
      _agentCard.value = handler.onGestureResult(actionType, sent)
  else:                                          // 非审批卡
      when (actionType):
          "approve" -> toggleVoice()                       // 单击 = 语音
          "reject"  -> _agentCard.value = CardStateMachine.resetToIdle(card)  // 双击 = 清空卡
```

### 4. 锁屏策略

`CardStateMachine.shouldKeepScreenOn` 改为：

```kotlin
fun shouldKeepScreenOn(state: AgentCardState): Boolean = !state.screenOff
```

`MainActivity` 已有 `agentCard.collect { setKeepScreenOn(...) }`，无需改动；`screenOff=true` 时自动 `setKeepScreenOn(false)` 释放 WakeLock。

### 5. 移除自动清空

删除 `AgentActionHandler` 的 `scheduleAutoClear()` / `cancelAutoClear()` / `AUTO_CLEAR_DELAY_MS` / `clearHandler` / `clearRunnable`，以及 `reduce()` 中对两者的调用。卡片只由显式手势（双击清空 / 向镜片熄屏）或新事件驱动。附带消除 desync bug。

### 6. 新事件自动唤醒

`CardStateMachine.reduce()` 构建新 state 时：非 `heartbeat` 事件 → `screenOff=false`（新任务/审批到来自动亮屏），`heartbeat` 保持熄屏，避免心跳反复唤醒。`duplicate` 与「卡片保护」两条 `current.copy(...)` 路径天然保留 `screenOff`。

## 数据流

```
眼镜手势 → GestureHandler(actionType) → MainViewModel.onGesture
   ├─ screen_off        → CardStateMachine.setScreenOff(true)  → screenOff=true → 黑屏 + 释放WakeLock
   ├─ view_details      → CardStateMachine.onViewDetails       → 切换 detailsVisible
   ├─ 熄屏态 approve     → setScreenOff(false)                  → 亮屏 + 同一张卡
   ├─ 审批卡 approve/reject → sendAction(taskId, action) → Core 审批
   └─ 非审批 approve     → toggleVoice()  (语音输入链)
       非审批 reject      → resetToIdle()   (清空卡，待语音)

Core 新事件 → MainViewModel.onMessage → handler.reduce
   └─ 非 heartbeat → screenOff=false（自动亮屏）
```

## 文件改动

| 文件 | 改动 |
|------|------|
| `agent/AgentBridgeProtocol.kt` | `AgentCardState` 加 `screenOff: Boolean = false` |
| `agent/CardStateMachine.kt` | `shouldKeepScreenOn` 改 `!screenOff`；新增 `setScreenOff()`；`reduce()` 非 heartbeat 置 `screenOff=false` |
| `agent/GestureHandler.kt` | `KEYCODE_DPAD_DOWN` 从 `view_details` 改为 `screen_off`（新增 `ACTION_SCREEN_OFF`） |
| `activities/main/MainViewModel.kt` | `onGesture` 加 screen_off / view_details / 熄屏唤醒 / 非审批双击清空 路由 |
| `agent/AgentActionHandler.kt` | 移除自动清空（scheduleAutoClear/cancelAutoClear/AUTO_CLEAR_DELAY_MS） |
| `agent/CardRenderer.kt` | `screenOff=true` 渲染黑屏；`actionHint` 更新为新手势文案 |
| `app/src/test/.../CardStateMachineTest.kt` | 单测（见下） |

## 测试（JVM 单测，无需真机）

在 `CardStateMachineTest.kt` 追加：

1. `shouldKeepScreenOn` 对 `status_card` 返回 true（原 bug 场景：回复卡也要长亮）
2. `shouldKeepScreenOn` 对 `screenOff=true` 返回 false
3. `setScreenOff` 保留卡片内容（title/body/taskId 不变，仅翻转 screenOff）
4. `reduce` 收到 `needs_approval` 时 `screenOff=false`（新审批自动亮屏）
5. `reduce` 收到 `heartbeat` 时保留 `screenOff=true`
6. `resetToIdle` 后 `screenOff=false`（双击清空 → 待语音 + 亮屏）

## 真机风险（需用户验证）

1. **方向映射**：`向镜腿=19(DPAD_UP)/向镜片=20(DPAD_DOWN)` 若反了，两滑动手势对调。装完先滑一下确认方向。
2. **熄屏后单击能否唤回**：释放 WakeLock 后若眼镜 ROM 让系统真正休眠并暂停 Activity，`onKeyDown` 可能收不到单击，唤回失效。若如此，降级方案：熄屏时改用 `SCREEN_DIM_WAKE_LOCK` 保留前台 + 渲染黑屏（「暗屏」而非「全熄」），保证单击仍能送达。需真机验证后定。
3. **审批卡熄屏的审批超时**：审批期间熄屏，Core 侧 120s 审批超时仍会触发 auto-allow（既有行为，非本次引入，提示风险）。

## 真机验收场景

1. 任务完成、回复卡出现后，卡片**不再自动熄屏**，长亮可读。
2. 回复卡停留期间**单击** → 立即进入「聆听中…」（回归验证：上一轮单击修复仍生效）。
3. 回复卡停留期间**双击** → 卡片清空回到待语音，再单击 → 开始语音。
4. **向镜片滑动** → 熄屏（黑屏）。
5. 熄屏态**单击** → 唤回同一张卡（内容不丢）。
6. 审批卡：单击=批准、双击=拒绝、向镜腿滑=展开全文（回归，全部不变）。
7. 新任务/审批到来时，若处于熄屏态，自动亮屏显示。
