# Codex 交接：眼镜端 2 个遗留项（#89 双重连 + 条件 WakeLock）（2026-08-26）

本轮范围：**#89 眼镜端重复连接 + 条件 WakeLock**，纯 Kotlin 代码 + JVM 单测，**无需真机**。真机验证由用户后续单独做（重建 APK + 手机 CXR-L SDK 部署 + 肉眼确认）。

工作区当前干净（分支 `agent/recovered`，已与 origin 同步）。开工前 `git status --short --branch` 应无输出。验收只需 `gradlew :app:testDebugUnitTest` 全绿 + `gradlew :app:assembleDebug` 编译过。

---

## 1. #89 眼镜端 onFailure + onClosed 双重连

**文件**：`rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt`

**根因**：okhttp 断连时会依次回调 `onFailure`（131-134 行）和 `onClosed`（136-139 行），两者都调用 `scheduleReconnect()`（170-184 行），导致同一断连调度了两次 `mainHandler.postDelayed({ connect() }, delay)` → 两个 `connect()` → 两条并发 WebSocket 连到 Core（`device_type=ar_glasses` 出现两次）。Core 侧已能防覆盖（#88），但眼镜不应主动制造多余连接。

**修法**：给重连加幂等门。新增纯类 `ReconnectGuard`（放同目录 `agent/ReconnectGuard.kt`）：

```kotlin
package com.rokid.cxrswithcxrl.agent

class ReconnectGuard {
    private var scheduled = false

    @Synchronized
    fun trySchedule(): Boolean {
        if (scheduled) return false
        scheduled = true
        return true
    }

    @Synchronized
    fun clear() {
        scheduled = false
    }
}
```

`AgentBridgeClient` 三处接线：

```kotlin
// 字段区加：
private val reconnectGuard = ReconnectGuard()

// scheduleReconnect() 改为：
private fun scheduleReconnect() {
    if (closedByUser) return
    if (!reconnectGuard.trySchedule()) return   // onFailure+onClosed 双重触发去重
    val now = System.currentTimeMillis()
    reconnectTracker.recordFailure(now)
    if (reconnectTracker.isStale(now)) {
        reconnectGuard.clear()
        mainHandler.post { listener.onStale() }
        return
    }
    val delay = reconnectDelayMs
    listener.onConnectionChanged("WS: retry in ${delay / 1000}s")
    mainHandler.postDelayed({
        reconnectGuard.clear()
        connect()
    }, delay)
    reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
}

// onOpen 开头加（连接成功，重置门）：
reconnectGuard.clear()

// disconnect() 里 closedByUser = true 后加：
reconnectGuard.clear()
```

**测试**：新增 `app/src/test/java/com/rokid/cxrswithcxrl/agent/ReconnectGuardTest.kt`（沿用 `ReconnectTrackerTest` 风格，JUnit4）：

```kotlin
package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectGuardTest {
    @Test
    fun `first schedule allowed`() {
        assertTrue(ReconnectGuard().trySchedule())
    }

    @Test
    fun `second schedule blocked until clear`() {
        val guard = ReconnectGuard()
        assertTrue(guard.trySchedule())
        assertFalse(guard.trySchedule())
        guard.clear()
        assertTrue(guard.trySchedule())
    }
}
```

---

## 2. 条件 WakeLock（仅关键卡片常亮）

现状：`MainActivity.kt` 50-58 行**无条件**常亮（`FLAG_KEEP_SCREEN_ON` + `keepScreenOn=true` + `wakeLock.acquire()`），导致 App 一开屏幕就从开机亮到关机，哪怕卡片是闲态也白耗电。

**目标**：只有需要用户处理的卡片保持常亮，闲态允许熄屏。`renderHint` 取值：`actionable_card`（待审批）/ `executing_card`（执行中）/ `rejected_card`（已拒绝）/ `alert_card`（critical）/ `status_card`（闲态）。

**文件 1**：`agent/CardStateMachine.kt`（object 内加纯函数）：

```kotlin
fun shouldKeepScreenOn(state: AgentCardState): Boolean =
    state.renderHint in setOf("actionable_card", "executing_card", "rejected_card", "alert_card")
```

**文件 2**：`activities/main/MainActivity.kt`：

- 删掉 50-51 行（`addFlags(FLAG_KEEP_SCREEN_ON)` 和 `keepScreenOn = true`）、删掉 58 行 `wakeLock.acquire()`。
- 保留 53-57 行 wakeLock 的创建。
- 加一个切屏方法 + 在 `onCreate` 里 collect `agentCard`：

```kotlin
private fun setKeepScreenOn(keep: Boolean) {
    if (keep) {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.keepScreenOn = true
        if (!wakeLock.isHeld) wakeLock.acquire()
    } else {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.keepScreenOn = false
        if (wakeLock.isHeld) wakeLock.release()
    }
}

// onCreate 里 viewModel 就绪后加：
lifecycleScope.launch {
    viewModel.agentCard.collect { state ->
        setKeepScreenOn(CardStateMachine.shouldKeepScreenOn(state))
    }
}
```

需要的 import：`android.view.WindowManager`、`androidx.lifecycle.lifecycleScope`、`kotlinx.coroutines.launch`、`com.rokid.cxrswithcxrl.agent.CardStateMachine`。（`lifecycle-runtime-ktx` 已是依赖，`lifecycleScope` 直接可用；`onDestroy` 里现有的 `if (wakeLock.isHeld) wakeLock.release()` 保留即可。）

**测试**：`CardStateMachineTest.kt` 追加（复用已有 `approvalMessage()` helper）：

```kotlin
@Test
fun shouldKeepScreenOn_trueForActionable() {
    val state = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    assertTrue(CardStateMachine.shouldKeepScreenOn(state))
}

@Test
fun shouldKeepScreenOn_trueForExecuting() {
    val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    assertTrue(CardStateMachine.shouldKeepScreenOn(CardStateMachine.onDecision(approval, "approve")))
}

@Test
fun shouldKeepScreenOn_trueForRejected() {
    val approval = CardStateMachine.reduce(AgentCardState(), approvalMessage(), false).state
    assertTrue(CardStateMachine.shouldKeepScreenOn(CardStateMachine.onDecision(approval, "reject")))
}

@Test
fun shouldKeepScreenOn_trueForAlert() {
    assertTrue(CardStateMachine.shouldKeepScreenOn(AgentCardState(renderHint = "alert_card")))
}

@Test
fun shouldKeepScreenOn_falseForStatus() {
    assertFalse(CardStateMachine.shouldKeepScreenOn(AgentCardState()))
}
```

---

## 3. 验收与提交

**验收（Codex 侧）**：`gradlew :app:testDebugUnitTest` 全绿 + `gradlew :app:assembleDebug` 编译过。

**真机验收（用户后续单独做，非 Codex 职责）**：
- #89：断 WiFi 再恢复，Core 侧 `ConnectedDevices` 只出现一个 `ar_glasses`；
- WakeLock：闲态卡片允许熄屏；出现待审批卡片时屏幕保持常亮。

**提交顺序（独立提交）**：
1. `fix: 眼镜端重连去重（ReconnectGuard）`
2. `feat: 条件 WakeLock 仅关键卡片常亮`
