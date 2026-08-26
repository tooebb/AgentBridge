# 眼镜卡片常亮 + 手势重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 眼镜回复/状态卡片不再快速熄屏，双击清空、向镜片滑动熄屏、单击唤回，审批链路保持不变。

**Architecture:** `AgentCardState` 新增 `screenOff` 字段作为唯一熄屏信号；`shouldKeepScreenOn` 从「renderHint 白名单」改为 `!screenOff`；手势路由在 `MainViewModel.onGesture` 分流；移除 `AgentActionHandler` 的 15s 自动清空。

**Tech Stack:** Kotlin、Jetpack Compose、JUnit4（JVM 单测）。

## Global Constraints

- 审批链路不变：`actionable_card` 下单击=批准、双击=拒绝、向镜腿滑=展开全文。
- 不改 Core 协议、不改 `AgentBridgeClient` 消息协议。
- 纯 Kotlin + JVM 单测，无需真机；真机验收由用户后续单独做。
- 验收：`gradlew :app:testDebugUnitTest` 全绿 + `gradlew :app:assembleDebug` 编译过。
- 所有 gradle 命令在 `rokid-sdk/cxrssample/cxrswithcxrl/` 目录下执行。
- 方向映射：向镜腿=`KEYCODE_DPAD_UP`(19)=展开全文，向镜片=`KEYCODE_DPAD_DOWN`(20)=熄屏（真机若反向则对调两个 keyCode，见 Task 2 备注）。

---

### Task 1: CardStateMachine 熄屏状态机（TDD）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt`（`AgentCardState` 加字段）
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardStateMachine.kt`
- Test: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/CardStateMachineTest.kt`

**Interfaces:**
- Produces: `AgentCardState.screenOff: Boolean`（默认 `false`）；`CardStateMachine.setScreenOff(state, off): AgentCardState`；`CardStateMachine.shouldKeepScreenOn(state): Boolean`（语义改为 `!state.screenOff`）。后续 Task 2/4 依赖这些。

- [ ] **Step 1: `AgentCardState` 加 `screenOff` 字段**

`AgentBridgeProtocol.kt` 的 `AgentCardState`（当前约 65-80 行），在 `statusLine` 之后加一个字段：

```kotlin
data class AgentCardState(
    val connectionLabel: String = "WS: idle",
    val title: String = "AgentBridge",
    val body: String = "Waiting for middleware events",
    val renderHint: String = "status_card",
    val severity: String = "info",
    val taskId: String = "",
    val decision: String = "",
    val details: String = "",
    val detailsVisible: Boolean = false,
    val quickActions: List<String> = emptyList(),
    val lastAckedSeq: Long = 0,
    val isReplay: Boolean = false,
    val duplicateCount: Int = 0,
    val statusLine: String = "session=default",
    val screenOff: Boolean = false
)
```

- [ ] **Step 2: 写失败测试（改 1 条旧测试 + 加 5 条新测试）**

`CardStateMachineTest.kt`：

(a) 把现有 `shouldKeepScreenOn_falseForStatus`（约 144-146 行）整个替换为：

```kotlin
@Test
fun shouldKeepScreenOn_trueForStatus() {
    assertTrue(CardStateMachine.shouldKeepScreenOn(AgentCardState()))
}
```

(b) 在文件末尾（类内）追加：

```kotlin
@Test
fun shouldKeepScreenOn_falseWhenScreenOff() {
    assertFalse(CardStateMachine.shouldKeepScreenOn(AgentCardState(screenOff = true)))
}

@Test
fun setScreenOff_preservesContentAndFlips() {
    val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    val off = CardStateMachine.setScreenOff(approval, true)
    assertTrue(off.screenOff)
    assertEquals(approval.title, off.title)
    assertEquals(approval.body, off.body)
    assertEquals(approval.taskId, off.taskId)
    assertEquals(approval.renderHint, off.renderHint)
    assertFalse(CardStateMachine.setScreenOff(off, false).screenOff)
}

@Test
fun reduce_wakesOnNonHeartbeatEvent() {
    val off = AgentCardState(screenOff = true)
    val result = CardStateMachine.reduce(off, approvalMessage(), duplicate = false)
    assertFalse(result.state.screenOff)
}

@Test
fun reduce_keepsOffOnHeartbeatEvent() {
    val off = AgentCardState(screenOff = true)
    val result = CardStateMachine.reduce(
        off,
        statusMessage(9, "heartbeat", "heartbeat", ""),
        duplicate = false
    )
    assertTrue(result.state.screenOff)
}

@Test
fun resetToIdle_clearsScreenOff() {
    val off = CardStateMachine.setScreenOff(AgentCardState(), true)
    assertFalse(CardStateMachine.resetToIdle(off).screenOff)
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.CardStateMachineTest"`

Expected: FAIL——`setScreenOff` 未定义（编译错误），且 `shouldKeepScreenOn_falseWhenScreenOff`/`reduce_wakesOnNonHeartbeatEvent` 等新行为尚未实现。

- [ ] **Step 4: 实现**

`CardStateMachine.kt`：

(a) 把 `shouldKeepScreenOn`（约 114-115 行）替换为：

```kotlin
fun shouldKeepScreenOn(state: AgentCardState): Boolean = !state.screenOff
```

(b) 在 `shouldKeepScreenOn` 附近加 `setScreenOff`：

```kotlin
fun setScreenOff(current: AgentCardState, off: Boolean): AgentCardState =
    current.copy(screenOff = off)
```

(c) `reduce()` 里 `newState` 构造（约 59-74 行），在 `duplicateCount = current.duplicateCount,` 之后加一行：

```kotlin
        screenOff = if (event?.eventType == "heartbeat") current.screenOff else false,
```

（`duplicate` 分支和「卡片保护」分支都用 `current.copy(...)`，天然保留 `screenOff`，无需改。）

- [ ] **Step 5: 运行测试确认通过**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:testDebugUnitTest`

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardStateMachine.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/CardStateMachineTest.kt
git commit -m "feat: CardStateMachine 加 screenOff 状态（长亮/熄屏/唤醒）"
```

---

### Task 2: 手势路由（GestureHandler + MainViewModel）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/GestureHandler.kt`
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`

**Interfaces:**
- Consumes: Task 1 的 `CardStateMachine.setScreenOff` / `onViewDetails` / `resetToIdle` / `shouldRouteToApproval`，`AgentCardState.screenOff`。
- Produces: 新 actionType `"screen_off"`（GestureHandler 发出，MainViewModel 消费）。

> 备注：本任务 Android 框架类无法 JVM 单测，验证靠 `assembleDebug` 编译过 + 真机（用户后续做）。方向若反，交换 `KEYCODE_DPAD_UP`/`KEYCODE_DPAD_DOWN` 两个分支体即可。

- [ ] **Step 1: GestureHandler 拆分滑动方向**

`GestureHandler.kt` 现有 `when(keyCode)` 里（约 35-43 行）：

```kotlin
KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
    if (now >= gestureLockUntil) {
        pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
        pendingSecondClick = null
        gestureLockUntil = now + SWIPE_LOCK_MS
        onGesture(ACTION_VIEW_DETAILS)
    }
    true
}
```

替换为两个分支：

```kotlin
KeyEvent.KEYCODE_DPAD_UP -> {
    if (now >= gestureLockUntil) {
        pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
        pendingSecondClick = null
        gestureLockUntil = now + SWIPE_LOCK_MS
        onGesture(ACTION_VIEW_DETAILS)
    }
    true
}

KeyEvent.KEYCODE_DPAD_DOWN -> {
    if (now >= gestureLockUntil) {
        pendingSecondClick?.let { clickHandler.removeCallbacks(it) }
        pendingSecondClick = null
        gestureLockUntil = now + SWIPE_LOCK_MS
        onGesture(ACTION_SCREEN_OFF)
    }
    true
}
```

`companion object`（约 68-74 行）加常量：

```kotlin
private const val ACTION_SCREEN_OFF = "screen_off"
```

- [ ] **Step 2: MainViewModel.onGesture 重写路由**

`MainViewModel.kt` 现有 `onGesture`（约 392-414 行）整体替换为：

```kotlin
fun onGesture(actionType: String) {
    val handler = actionHandler
    if (handler == null) {
        _capsFromClient.value = "INPUT: handler null"
        return
    }
    val card = agentCard.value

    if (actionType == "screen_off") {
        _agentCard.value = CardStateMachine.setScreenOff(card, true)
        return
    }
    if (actionType == "view_details") {
        _agentCard.value = CardStateMachine.onViewDetails(card)
        return
    }
    if (card.screenOff) {
        if (actionType == "approve") {
            _agentCard.value = CardStateMachine.setScreenOff(card, false)
        }
        return
    }
    if (CardStateMachine.shouldRouteToApproval(card)) {
        val client = agentClient
        if (client == null) {
            _capsFromClient.value = "INPUT: agentClient null"
            return
        }
        val sent = client.sendAction(card.taskId, actionType)
        _capsFromClient.value = "INPUT: sendAction=$sent taskId=${card.taskId} action=$actionType"
        _agentCard.value = handler.onGestureResult(actionType, sent)
    } else {
        if (actionType == "approve") {
            toggleVoice()
        } else if (actionType == "reject") {
            _agentCard.value = CardStateMachine.resetToIdle(card)
        }
    }
}
```

`CardStateMachine` 已在 `MainViewModel.kt` import 区（`import com.rokid.cxrswithcxrl.agent.CardStateMachine`）存在，无需新增。

- [ ] **Step 3: 编译验证**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:assembleDebug`

Expected: 编译过。

- [ ] **Step 4: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/GestureHandler.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt
git commit -m "feat: 向镜片滑=熄屏、双击清空卡、熄屏单击唤回（onGesture 路由）"
```

---

### Task 3: 移除 15s 自动清空

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt`

**Interfaces:**
- Consumes: 无新依赖。移除后 `reduce()` 返回的卡片不再被定时器复位，改由 Task 2 的显式手势（双击 `resetToIdle`）驱动。

- [ ] **Step 1: 删除自动清空相关代码**

`AgentActionHandler.kt`：

(a) 删除字段（约 19-20 行）：

```kotlin
private val clearHandler = Handler(Looper.getMainLooper())
private var clearRunnable: Runnable? = null
```

(b) 删除 `reduce()` 里的调度块（约 33-38 行）：

```kotlin
val eventType = message.event?.eventType
if (eventType == "task_completed" && !duplicate) {
    scheduleAutoClear()
} else if (eventType == "task_started" || eventType == "needs_approval") {
    cancelAutoClear()
}
```

(c) 删除 `scheduleAutoClear()` 和 `cancelAutoClear()` 两个方法（约 105-117 行）。

(d) 删除 `close()` 里的 `cancelAutoClear()` 调用（约 97 行）。

(e) 删除 `companion object` 里的 `private const val AUTO_CLEAR_DELAY_MS = 15000L`（约 129 行）。

(f) 删除顶部 `import android.os.Handler` 和 `import android.os.Looper`（约 4-5 行，删后无其它引用）。

- [ ] **Step 2: 编译验证**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:assembleDebug`

Expected: 编译过。

- [ ] **Step 3: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt
git commit -m "refactor: 移除 AgentActionHandler 15s 自动清空（卡片改由显式手势清空）"
```

---

### Task 4: 熄屏黑屏渲染 + 手势提示

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt`

**Interfaces:**
- Consumes: `AgentCardState.screenOff`（Task 1）。

- [ ] **Step 1: `AgentBridgeScreen` 熄屏时渲染黑屏**

`CardRenderer.kt` 的 `AgentBridgeScreen`（约 26-80 行），在函数体最前面加早退：

```kotlin
@Composable
fun AgentBridgeScreen(
    card: AgentCardState,
    capsFromClient: String,
    debugStatus: String = "",
    voiceStatus: String = "",
    showDebug: Boolean = false
) {
    if (card.screenOff) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.Black),
            color = Color.Black
        ) {}
        return
    }
    Surface(
        // ... 原实现不变
    )
}
```

（即：仅插入 `if (card.screenOff) { ... return }` 块，其余原代码不动。）

- [ ] **Step 2: 更新 `actionHint` 文案**

`CardRenderer.kt` 的 `actionHint`（约 163-173 行），把 `else` 分支的 SWIPE 文案从 `view_details` 改为：

```kotlin
private fun actionHint(card: AgentCardState): String {
    return when (card.renderHint) {
        "executing_card" -> "处理中…"
        "rejected_card" -> "已拒绝"
        else -> {
            val click = card.quickActions.getOrNull(0) ?: "continue"
            val doubleClick = card.quickActions.getOrNull(1) ?: "pause"
            "CLICK: $click  DOUBLE: $doubleClick  SWIPE: 全文/熄屏"
        }
    }
}
```

- [ ] **Step 3: 编译验证**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:assembleDebug`

Expected: 编译过。

- [ ] **Step 4: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt
git commit -m "feat: 熄屏渲染黑屏 + 手势提示更新（全文/熄屏）"
```

---

### Task 5: 全量验证

- [ ] **Step 1: 全量单测**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:testDebugUnitTest`

Expected: 全绿（含 Task 1 新增/修改的 6 条）。

- [ ] **Step 2: 全量编译**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && ./gradlew :app:assembleDebug`

Expected: 编译过，产出 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 3: 确认工作区干净**

```bash
git status --short --branch
```

Expected: 只有 Task 1-4 的提交，无未提交改动（`Demo/` 目录如仍是 untracked 且与本次无关，勿动）。

---

## 真机验收（用户后续单独做，非本次执行职责）

1. 回复卡出现后不再自动熄屏，长亮可读。
2. 回复卡停留期**单击** → 立即「聆听中…」（回归上一轮修复）。
3. 回复卡停留期**双击** → 卡片清空回到待语音，再单击开始语音。
4. **向镜片滑动** → 熄屏（黑屏）。
5. 熄屏态**单击** → 唤回同一张卡（内容不丢）。
6. 审批卡：单击=批准、双击=拒绝、向镜腿滑=展开全文（回归，全不变）。
7. 新任务/审批到来自动亮屏。
8. 若第 4/5 步方向反了：交换 `GestureHandler` 里 `KEYCODE_DPAD_UP`/`KEYCODE_DPAD_DOWN` 两个分支体，重编译部署。
9. 若熄屏后单击唤不醒（ROM 深度睡眠）：降级为 `SCREEN_DIM_WAKE_LOCK` 暗屏方案（见设计文档「真机风险 2」）。
