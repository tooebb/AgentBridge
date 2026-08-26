# Codex 交接：完成卡片停留期间单击无法开始下一段录音（2026-08-26）

本轮范围：**眼镜端手势路由判断字段错误**，纯 Kotlin 代码 + JVM 单测，**无需真机**。真机验证由用户后续单独做（重建 APK + 手机 CXR-L SDK 部署 + 肉眼确认）。

工作区当前干净（分支 `agent/recovered`，已与 origin 同步）。开工前 `git status --short --branch` 应无输出。验收只需 `gradlew :app:testDebugUnitTest` 全绿 + `gradlew :app:assembleDebug` 编译过。

---

## 根因

任务完成后，`task_completed` 事件到达，眼镜渲染完成卡片（`renderHint = "status_card"`），但卡片**停留 15 秒**（`AgentActionHandler.AUTO_CLEAR_DELAY_MS`）才 `resetToIdle`。这 15 秒内卡片 `taskId` 仍非空。

`MainViewModel.onGesture()` 用 `taskId.isBlank()` 判断「有无任务」来决定单击语义：

- `taskId` 为空 → 单击 = `toggleVoice()`（开始/停止录音）
- `taskId` 非空 → 单击 = `sendAction(taskId, "approve")`（审批）

完成卡片的 `taskId` 非空，所以单击被误路由到 `sendAction`。Core 对已完成的 task 返回 `approval not found`，`CardStateMachine.onDecision` 又因 `renderHint != "actionable_card"` 直接 no-op → 用户看到「单击没反应」。只有等 15 秒后 `resetToIdle` 清空 taskId，单击才恢复录音。

**修法**：判断依据从「taskId 是否为空」改为「当前是否有待审批卡片（`renderHint == "actionable_card"`）」。这样只要没有待审批卡片，单击一律回到录音。

---

## 1. CardStateMachine 加纯函数

**文件**：`rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardStateMachine.kt`

在 `shouldKeepScreenOn`（约 114 行）附近加：

```kotlin
fun shouldRouteToApproval(state: AgentCardState): Boolean =
    state.renderHint == "actionable_card"
```

---

## 2. MainViewModel.onGesture 改判断

**文件**：`rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`

现有 `onGesture`（约 391-414 行）：

```kotlin
fun onGesture(actionType: String) {
    val handler = actionHandler
    if (handler == null) {
        _capsFromClient.value = "INPUT: handler null"
        return
    }
    val taskId = agentCard.value.taskId
    if (taskId.isBlank()) {
        if (actionType == "approve") {
            toggleVoice()
        } else {
            _capsFromClient.value = "INPUT: no task taskId='$taskId'"
        }
        return
    }
    val client = agentClient
    if (client == null) {
        _capsFromClient.value = "INPUT: agentClient null"
        return
    }
    val sent = client.sendAction(taskId, actionType)
    _capsFromClient.value = "INPUT: sendAction=$sent taskId=$taskId action=$actionType"
    _agentCard.value = handler.onGestureResult(actionType, sent)
}
```

改为：

```kotlin
fun onGesture(actionType: String) {
    val handler = actionHandler
    if (handler == null) {
        _capsFromClient.value = "INPUT: handler null"
        return
    }
    val card = agentCard.value
    if (!CardStateMachine.shouldRouteToApproval(card)) {
        // 没有待审批卡片：单击 = 开始/停止录音，其余手势无操作
        if (actionType == "approve") {
            toggleVoice()
        }
        return
    }
    val client = agentClient
    if (client == null) {
        _capsFromClient.value = "INPUT: agentClient null"
        return
    }
    val sent = client.sendAction(card.taskId, actionType)
    _capsFromClient.value = "INPUT: sendAction=$sent taskId=${card.taskId} action=$actionType"
    _agentCard.value = handler.onGestureResult(actionType, sent)
}
```

**需要新增 import**（`MainViewModel.kt` 顶部 import 区，与其它 `com.rokid.cxrswithcxrl.agent.*` import 并列）：

```kotlin
import com.rokid.cxrswithcxrl.agent.CardStateMachine
```

---

## 3. 测试

**文件**：`rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/CardStateMachineTest.kt`

追加（复用已有 `approvalMessage()` / `statusMessage()` helper）：

```kotlin
@Test
fun shouldRouteToApproval_trueForActionable() {
    val state = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    assertTrue(CardStateMachine.shouldRouteToApproval(state))
}

@Test
fun shouldRouteToApproval_falseForIdle() {
    assertFalse(CardStateMachine.shouldRouteToApproval(AgentCardState()))
}

@Test
fun shouldRouteToApproval_falseForCompleted() {
    val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    val completed = CardStateMachine.reduce(
        approval,
        statusMessage(4, "task_completed", "✓ Task completed", "done"),
        false
    ).state
    // 关键：完成卡片 taskId 非空，但 renderHint 已回到 status_card
    assertEquals("status_card", completed.renderHint)
    assertFalse(CardStateMachine.shouldRouteToApproval(completed))
}

@Test
fun shouldRouteToApproval_falseForExecuting() {
    val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    assertFalse(CardStateMachine.shouldRouteToApproval(CardStateMachine.onDecision(approval, "approve")))
}

@Test
fun shouldRouteToApproval_falseForRejected() {
    val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    assertFalse(CardStateMachine.shouldRouteToApproval(CardStateMachine.onDecision(approval, "reject")))
}
```

`falseForCompleted` 这条正是复现本次 bug 的场景：完成卡片 `taskId` 非空但 `renderHint = "status_card"`，`shouldRouteToApproval` 必须返回 false，让单击走录音。

---

## 4. 验收与提交

**验收（Codex 侧）**：`gradlew :app:testDebugUnitTest` 全绿 + `gradlew :app:assembleDebug` 编译过。

**真机验收（用户后续单独做，非 Codex 职责）**：
- 任务完成后，完成卡片停留的 15 秒内，单击应立即进入「聆听中…」（开始下一段语音输入），无需等卡片消失；
- 待审批卡片（`actionable_card`）出现时，单击仍 = approve、双击仍 = reject、滑动仍 = view_details（回归验证）。

**提交（独立提交）**：
`fix: 眼镜端手势路由改按 renderHint 判断（完成卡片单击恢复录音）`
