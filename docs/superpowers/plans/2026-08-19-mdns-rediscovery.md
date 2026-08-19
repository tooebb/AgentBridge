# mDNS 重发现（IP 漂移恢复）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 眼镜运行中 PC IP 漂移或 Core 换址重启后，自动重新 mDNS 发现并恢复连接，替代「永远重连旧 IP 直到手动重启」。

**Architecture:** `AgentBridgeClient` 用 `ReconnectTracker` 跟踪连续重连失败时长，超过 60s 通过 Listener 新增的 `onStale()` 回调通知；`MainViewModel` 收到后拆旧 client、重置 `connectionStarted`、重跑 `startDiscovery`，复用现有 resolve 降级链选出新地址重建 client。

**Tech Stack:** Kotlin（Android `NsdManager` / okhttp 4.12.0 / JUnit 4 纯函数测试）。

## Global Constraints

- 不改 Core 协议、不改 `AgentBridgeClient` 消息协议、审批链路不变。
- 眼镜端：minSdk 31 / targetSdk 36 / Kotlin Compose / okhttp 4.12.0 / gson 2.10.1。
- 构建命令（在 `rokid-sdk/cxrssample/cxrswithcxrl` 目录）：`JAVA_HOME="/d/Software/Android/jbr" ./gradlew assembleDebug`。
- 单测命令：`JAVA_HOME="/d/Software/Android/jbr" ./gradlew :app:testDebugUnitTest --tests "<FQCN>"`。
- 设备：眼镜 `1901092534002787`（app `com.rokid.cxrswithcxrl`）、手机 `4EU0221B11003871`。
- ADB 路径 `C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe`；ADB 操作用 PowerShell。
- 眼镜 ROM 禁止 `adb install` 与 `run-as`；装 APK 只能走手机 CXR-L SDK。

---

### Task 1: ReconnectTracker 纯逻辑（TDD）

**Files:**
- Create: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/ReconnectTracker.kt`
- Test: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/ReconnectTrackerTest.kt`

**Interfaces:**
- Consumes: 无（纯 Kotlin，无 Android 依赖）。
- Produces:
  - `class ReconnectTracker(staleMs: Long = 60_000L)`，方法：
    - `fun recordFailure(now: Long)` — 首次失败记时间戳，后续失败不重置。
    - `fun markConnected()` — 连接成功清零时间戳。
    - `fun isStale(now: Long): Boolean` — 有失败记录且 `now - firstFailureAt > staleMs`。
  - 被 Task 2（`AgentBridgeClient`）消费。

- [ ] **Step 1: 写失败测试**

创建 `app/src/test/java/com/rokid/cxrswithcxrl/agent/ReconnectTrackerTest.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectTrackerTest {

    @Test
    fun `not stale before threshold`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        assertFalse(tracker.isStale(60_000L))
    }

    @Test
    fun `stale after threshold`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        assertTrue(tracker.isStale(61_001L))
    }

    @Test
    fun `keeps original first failure across repeated failures`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        tracker.recordFailure(30_000L)
        tracker.recordFailure(50_000L)
        assertTrue(tracker.isStale(61_001L))
    }

    @Test
    fun `not stale when never failed`() {
        val tracker = ReconnectTracker()
        assertFalse(tracker.isStale(Long.MAX_VALUE))
    }

    @Test
    fun `reset after connected`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        tracker.markConnected()
        assertFalse(tracker.isStale(99_999L))
    }

    @Test
    fun `boundary exactly threshold is not stale`() {
        val tracker = ReconnectTracker(staleMs = 60_000L)
        tracker.recordFailure(1_000L)
        assertFalse(tracker.isStale(61_000L))
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd "D:/project/5project/AgentBridge-master/rokid-sdk/cxrssample/cxrswithcxrl"
JAVA_HOME="/d/Software/Android/jbr" ./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.ReconnectTrackerTest"
```

Expected: FAIL，`Unresolved reference: ReconnectTracker`（编译错误）。

- [ ] **Step 3: 写最小实现**

创建 `app/src/main/java/com/rokid/cxrswithcxrl/agent/ReconnectTracker.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

class ReconnectTracker(private val staleMs: Long = 60_000L) {
    private var firstFailureAt = 0L

    fun recordFailure(now: Long) {
        if (firstFailureAt == 0L) firstFailureAt = now
    }

    fun markConnected() {
        firstFailureAt = 0L
    }

    fun isStale(now: Long): Boolean =
        firstFailureAt != 0L && now - firstFailureAt > staleMs
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2 命令。

Expected: PASS（6 个测试全绿）。

- [ ] **Step 5: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/ReconnectTracker.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/ReconnectTrackerTest.kt
git commit -m "feat: add ReconnectTracker for stale reconnect detection"
```

---

### Task 2: AgentBridgeClient 接线（tracker + onStale 信号）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt`（`Listener` 接口、字段、`onOpen`、`scheduleReconnect`）

**Interfaces:**
- Consumes: `ReconnectTracker`（Task 1）。
- Produces: `Listener.onStale()`（带默认空实现，保证 Task 2 独立编译）；`AgentBridgeClient` 连续失败超 60s 时在主线程回调 `listener.onStale()`。被 Task 3（`MainViewModel`）消费。

- [ ] **Step 1: 加 `onStale()` 到 Listener 接口（默认空实现）**

把 `AgentBridgeClient.kt` 第 26-30 行的接口改为：

```kotlin
    interface Listener {
        fun onConnectionChanged(label: String)
        fun onMessage(message: DeviceMessage, duplicate: Boolean)
        fun onError(label: String, throwable: Throwable?)
        fun onStale() {}
    }
```

- [ ] **Step 2: 加 tracker 字段**

在 `private var reconnectDelayMs = 2_000L` 之后加：

```kotlin
    private val reconnectTracker = ReconnectTracker()
```

- [ ] **Step 3: `onOpen` 成功后清零 tracker**

把 `onOpen`（原第 107-111 行）改为：

```kotlin
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectDelayMs = 2_000L
            reconnectTracker.markConnected()
            listener.onConnectionChanged("WS: connected")
            Log.d(TAG, "connected ${wsUrl()}")
        }
```

- [ ] **Step 4: `scheduleReconnect` 记录失败 + 超时触发 `onStale`**

把 `scheduleReconnect`（原第 163-171 行）改为：

```kotlin
    private fun scheduleReconnect() {
        if (closedByUser) {
            return
        }
        val now = System.currentTimeMillis()
        reconnectTracker.recordFailure(now)
        if (reconnectTracker.isStale(now)) {
            mainHandler.post { listener.onStale() }
            return
        }
        val delay = reconnectDelayMs
        listener.onConnectionChanged("WS: retry in ${delay / 1000}s")
        mainHandler.postDelayed({ connect() }, delay)
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
    }
```

> 说明：`onStale` 经 `mainHandler.post` 派发到主线程，保证 Task 3 里 `startDiscovery`（NsdManager）在主线程调用。超时后不再 `postDelayed` 重连，避免旧 client 继续连旧地址。

- [ ] **Step 5: 编译验证**

Run:
```bash
cd "D:/project/5project/AgentBridge-master/rokid-sdk/cxrssample/cxrswithcxrl"
JAVA_HOME="/d/Software/Android/jbr" ./gradlew :app:assembleDebug
```

Expected: BUILD SUCCESSFUL（`onStale` 有默认实现，`MainViewModel` 未实现也能编译）。

- [ ] **Step 6: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt
git commit -m "feat: emit onStale after 60s of failed reconnect"
```

---

### Task 3: MainViewModel 处理 onStale（重发现）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`（`createClient` 内匿名 Listener）

**Interfaces:**
- Consumes: `Listener.onStale()`（Task 2）、`readConfig`/`startDiscovery`（已有）。
- Produces: 收到 `onStale` 后拆旧 client、重置状态、重跑发现重建连接。对审批链路无新接口。

- [ ] **Step 1: 在匿名 Listener 中实现 `onStale`**

在 `createClient` 的匿名 `Listener`（原第 320-345 行）里，`onError` 之后加：

```kotlin
                override fun onStale() {
                    Log.d("WIFI", "onStale: re-discovering")
                    val old = agentClient
                    agentClient = null
                    connectionStarted = false
                    old?.disconnect()
                    val config = readConfig(context)
                    startDiscovery(context, handler, config)
                }
```

> 说明：`context` 与 `handler` 是 `createClient` 参数（闭包捕获）。先置空 `agentClient` + 重置 `connectionStarted`，再 `old?.disconnect()` 停止旧 client 重连循环（`disconnect` 置 `closedByUser=true`，后续 `onClosed` 不再重连）；随后 `startDiscovery` 复用现有降级链选出新地址。**保留** `connectResolved`/`createClient` 的防重入 guard——它们防止启动时多个 mDNS 服务重复建连，此处靠重置状态放行重建。

- [ ] **Step 2: 编译验证**

Run:
```bash
cd "D:/project/5project/AgentBridge-master/rokid-sdk/cxrssample/cxrswithcxrl"
JAVA_HOME="/d/Software/Android/jbr" ./gradlew :app:assembleDebug
```

Expected: BUILD SUCCESSFUL。

- [ ] **Step 3: Commit**

```bash
cd "D:/project/5project/AgentBridge-master"
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt
git commit -m "feat: re-discover Core when reconnect goes stale"
```

---

### Task 4: 真机 E2E（改址后自动重发现）

**Files:** 无代码改动（验证任务）。

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 验证记录（写进 CLAUDE.md 或连接模式表）。

**前置：** 眼镜已装新 APK（手机 CXR-L SDK 安装）；Core 可启动；眼镜 WiFi 同网段。

- [ ] **Step 1: 部署新 APK 到眼镜**

构建 → 推到手机 `files/cxrL.apk` → 手机 Demo 应用 customApp 会话安装 → 启动眼镜 app。命令参考 `scripts/deploy-apk.ps1`（注意眼镜 ROM 禁 `adb install`/`run-as`，安装只能走手机）。

- [ ] **Step 2: 场景 A — 首次 mDNS 直连**

启动 Core（`AGENTBRIDGE_ADDR=":8088"`，mDNS 广播开启），启动眼镜 app。观察 Core 日志 `from 192.168.31.x` 直连（非 `127.0.0.1`）。

- [ ] **Step 3: 场景 B — 改址后自动重发现（核心验证）**

停掉 Core，改用不同端口重启（如 `AGENTBRIDGE_ADDR=":8089"`，mDNS 广播新端口）。旧 URL `ws://<PC>:8088` 变死地址。

Expected: 约 60s 内眼镜 `onStale` 触发 → 重新 mDNS 发现 → 连到 `ws://<PC>:8089`。观察 Core 日志出现 `GET http://<PC>:8089/ws/default?device_type=ar_glasses`。

- [ ] **Step 4: 场景 C — 同址重启不触发重发现**

Core 在相同端口（8088）短暂停掉再起（< 60s）。Expected: 眼镜走 `AgentBridgeClient` 快重连（2s→30s 退避）恢复，不触发 `onStale` 重发现（无「re-discovering」日志）。

- [ ] **Step 5: 记录结果**

把验证结果写进 CLAUDE.md 的「眼镜连接模式」或 mDNS 段落：标注「运行中 IP 漂移自动重发现 ✅」。

---

## Self-Review 记录

**Spec coverage：**
- §方案（Option A 阈值重发现）→ Task 1（阈值逻辑）、Task 2（client 信号）、Task 3（ViewModel 重发现）✅
- §边界情况（同址重连/空发现/seq）→ Task 2/3 说明 + Task 4 场景 C ✅
- §测试（单测 + E2E）→ Task 1（单测）+ Task 4（E2E）✅

**Placeholder scan：** 无 TBD/TODO。

**Type consistency：** `ReconnectTracker(staleMs=60_000)` 的 `recordFailure(now)`/`markConnected()`/`isStale(now)`（Task 1）↔ `AgentBridgeClient`（Task 2）调用一致；`Listener.onStale()`（Task 2 定义）↔ `MainViewModel`（Task 3 实现）一致。
