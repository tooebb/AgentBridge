# mDNS 重注册加固 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉手机中继 mDNS 重注册的四个真实缺口，让眼镜在「手机 WiFi IP 漂移 / 热点链路属性变化 / 注册失败」等场景下不再需要手动重启中继才能重连。

**Architecture:** 上一版 plan（`2026-08-30-relay-mdns-network-rebroadcast-plan.md`）只在 `RelayService` 挂了 `onAvailable` 回调，漏了四个缝。本计划补：① `onLinkPropertiesChanged` / `onCapabilitiesChanged` 监听 IP 漂移（缝 A）② 网络回调从 `onCreate` 移到 `onStartCommand`（缝 B）③ `MdnsBroadcaster` 加 `restart()`（stop+延迟 start，规避 NsdManager 的 ALREADY_ACTIVE）+ ④ 注册失败退避重试（缝 D）。退避计算抽成纯类 `RetryPolicy` 用 JVM 单测覆盖。

**Tech Stack:** Kotlin（Android），仅 `phone-relay/` 模块。纯 JVM 单测（junit），不引入 Robolectric。

## Global Constraints

- 不改 Core 协议、不改眼镜端、不改 `RelayServer` / `RelayConfig` / `MainActivity`。
- 模块无 Robolectric：`MdnsBroadcaster` / `RelayService` 依赖 `NsdManager` / `ConnectivityManager` 等 Android 组件，**无 JVM 单测，正确性靠编译门禁 + 真机 E2E**。唯一可纯 JVM 测的是 `RetryPolicy`（纯函数）。
- 不重启 `RelayServer`：它监听 `0.0.0.0:8088`，上游连的是 PC 固定 Tailscale IP，手机侧 IP 漂移不影响它；只有 mDNS 广播的 IP 会漂移，故只需重注册 mDNS。
- 编译环境：

```bash
export JAVA_HOME="/c/Users/_/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
export ANDROID_HOME="/c/Users/_/AppData/Local/Android/Sdk"
```

模块根目录：

```bash
cd "D:\project\5project\AgentBridge-master\phone-relay"
```

---

## Task 1: `RetryPolicy`（纯退避计算）

**Files:**
- Create: `phone-relay/app/src/main/java/com/agentbridge/relay/RetryPolicy.kt`
- Test: `phone-relay/app/src/test/java/com/agentbridge/relay/RetryPolicyTest.kt`

**Interfaces:**
- Consumes: 无（独立纯类）。
- Produces: `RetryPolicy.delayMs(attempt: Int): Long` —— 指数退避延迟，`baseDelayMs` 起步、每失败一次翻倍、封顶 `maxDelayMs`。Task 2 的 `MdnsBroadcaster` 在注册失败时调用它。

- [ ] **Step 1: 写失败测试**

`phone-relay/app/src/test/java/com/agentbridge/relay/RetryPolicyTest.kt`：

```kotlin
package com.agentbridge.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class RetryPolicyTest {
    @Test fun doublesUntilCap() {
        val p = RetryPolicy(baseDelayMs = 1_000L, maxDelayMs = 30_000L)
        assertEquals(1_000L, p.delayMs(0))
        assertEquals(2_000L, p.delayMs(1))
        assertEquals(4_000L, p.delayMs(2))
        assertEquals(8_000L, p.delayMs(3))
        assertEquals(16_000L, p.delayMs(4))
        assertEquals(30_000L, p.delayMs(5))
        assertEquals(30_000L, p.delayMs(6))
    }

    @Test fun negativeAttemptTreatsAsZero() {
        val p = RetryPolicy()
        assertEquals(1_000L, p.delayMs(-1))
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:\project\5project\AgentBridge-master\phone-relay"
./gradlew testDebugUnitTest --tests "com.agentbridge.relay.RetryPolicyTest"
```

Expected: 编译失败（`RetryPolicy` 未定义）。

- [ ] **Step 3: 实现 `RetryPolicy`**

`phone-relay/app/src/main/java/com/agentbridge/relay/RetryPolicy.kt`：

```kotlin
package com.agentbridge.relay

class RetryPolicy(
    private val baseDelayMs: Long = 1_000L,
    private val maxDelayMs: Long = 30_000L,
) {
    fun delayMs(attempt: Int): Long {
        var delay = baseDelayMs
        repeat(attempt.coerceAtLeast(0)) {
            delay = (delay * 2).coerceAtMost(maxDelayMs)
        }
        return delay
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
./gradlew testDebugUnitTest --tests "com.agentbridge.relay.RetryPolicyTest"
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add phone-relay/app/src/main/java/com/agentbridge/relay/RetryPolicy.kt phone-relay/app/src/test/java/com/agentbridge/relay/RetryPolicyTest.kt
git commit -m "feat: mDNS 注册失败退避 RetryPolicy（纯类 + 单测）"
```

---

## Task 2: `MdnsBroadcaster` 加 `restart()` + 失败退避重试（缝 C、缝 D）

**Files:**
- Modify: `phone-relay/app/src/main/java/com/agentbridge/relay/MdnsBroadcaster.kt`（整文件重写）

**Interfaces:**
- Consumes: `RetryPolicy`（Task 1）、`RelayConfig.SERVICE_NAME` / `SERVICE_TYPE` / `LISTEN_PORT` / `TXT_RECORDS`。
- Produces: 三个入口 `start()` / `stop()` / `restart()`。`start()` 幂等（已持有 listener 则 no-op）；`stop()` 清退避队列并注销；`restart()` = 注销 + 延迟 `RESTART_DELAY_MS` 后 `start()`；`onRegistrationFailed` 按 `RetryPolicy` 退避重试。Task 3 的 `RelayService` 改用 `restart()` 替代裸 stop+start。

- [ ] **Step 1: 整文件重写**

用以下内容覆盖 `phone-relay/app/src/main/java/com/agentbridge/relay/MdnsBroadcaster.kt`：

```kotlin
package com.agentbridge.relay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log

class MdnsBroadcaster(private val context: Context, private val listenPort: Int) {
    private val handler = Handler(Looper.getMainLooper())
    private val retryPolicy = RetryPolicy()
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var retryAttempt = 0

    fun start() {
        if (registrationListener != null) return
        register()
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        unregister()
    }

    fun restart() {
        handler.removeCallbacksAndMessages(null)
        unregister()
        handler.postDelayed({ start() }, RESTART_DELAY_MS)
    }

    private fun register() {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        val info = NsdServiceInfo().apply {
            serviceName = RelayConfig.SERVICE_NAME
            serviceType = RelayConfig.SERVICE_TYPE
            setPort(listenPort)
            RelayConfig.TXT_RECORDS.forEach { (key, value) -> setAttribute(key, value) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "mDNS registered: ${serviceInfo.serviceName}")
                retryAttempt = 0
            }

            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS registration failed: $errorCode")
                registrationListener = null
                val delay = retryPolicy.delayMs(retryAttempt)
                retryAttempt++
                handler.postDelayed({ start() }, delay)
            }

            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "mDNS unregistered: ${serviceInfo.serviceName}")
            }

            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS unregistration failed: $errorCode")
            }
        }
        registrationListener = listener
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    private fun unregister() {
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        val listener = registrationListener
        registrationListener = null
        if (listener != null) {
            runCatching { nsd.unregisterService(listener) }
        }
    }

    private companion object {
        const val TAG = "Relay"
        const val RESTART_DELAY_MS = 300L
    }
}
```

> **为什么 `restart()` 要延迟 300ms 再 `start()`**：`unregisterService` 之后立刻 `registerService` 同名服务，部分 ROM 的 NsdManager 会返回 `FAILURE_ALREADY_ACTIVE`（错误码 3，底层 mDNSResponder 尚未释放）。300ms 延迟是常见防御。

- [ ] **Step 2: 编译验证**

```bash
cd "D:\project\5project\AgentBridge-master\phone-relay"
./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`。

- [ ] **Step 3: 提交**

```bash
git add phone-relay/app/src/main/java/com/agentbridge/relay/MdnsBroadcaster.kt
git commit -m "fix: MdnsBroadcaster 加 restart（延迟重注册）与注册失败退避重试"
```

---

## Task 3: `RelayService` 监听 IP 漂移 + 回调移到 `onStartCommand`（缝 A、缝 B）

**Files:**
- Modify: `phone-relay/app/src/main/java/com/agentbridge/relay/RelayService.kt`

**Interfaces:**
- Consumes: `MdnsBroadcaster.restart()`（Task 2）。
- Produces: 网络变化（含 `onLinkPropertiesChanged` / `onCapabilitiesChanged`）触发去抖重注册；网络回调在 `isRunning = true` 之后才注册，消除首次回调被 `if (!isRunning) return` 吞掉的问题。

- [ ] **Step 1: 补 import**

在 `import android.net.Network` 之后加：

```kotlin
import android.net.LinkProperties
import android.net.NetworkCapabilities
```

- [ ] **Step 2: `onCreate` 移除网络回调注册（缝 B）**

删除 `onCreate` 里的 `registerNetworkCallback()` 一行。删除后 `onCreate` 变为：

```kotlin
    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Phone relay",
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
```

- [ ] **Step 3: `onStartCommand` 在 `isRunning = true` 之后注册回调（缝 B）**

把 `registerNetworkCallback()` 加在 `isRunning = true` 之后、`return START_STICKY` 之前：

```kotlin
        relayServer = RelayServer(RelayConfig(host, port)).also { it.start() }
        mdnsBroadcaster = MdnsBroadcaster(this, RelayConfig.LISTEN_PORT).also { it.start() }
        isRunning = true
        registerNetworkCallback()
        return START_STICKY
```

- [ ] **Step 4: `registerNetworkCallback` 补两个回调（缝 A）**

把 `callback` 的 `onAvailable` 保留，并在其后新增两个 override：

```kotlin
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scheduleRebroadcast()
            }

            override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
                scheduleRebroadcast()
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                scheduleRebroadcast()
            }
        }
```

> `onLinkPropertiesChanged` 覆盖「同一网络内 DHCP IP 漂移」场景（`Network` 对象不变、`onAvailable` 不触发，但 `LinkProperties` 里 IP 变了）。`onCapabilitiesChanged` 覆盖「热点开关 / 网络能力变化」场景。两者都走已有的 500ms 去抖，避免连续回调风暴。

- [ ] **Step 5: `rebroadcastMdns` 改用 `restart()`（缝 C）**

把 `rebroadcastMdns` 的 stop+start 裸调改成 `restart()`：

```kotlin
    private fun rebroadcastMdns() {
        if (!isRunning) return
        mdnsBroadcaster?.restart()
    }
```

- [ ] **Step 6: 编译验证**

```bash
./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`。

- [ ] **Step 7: 提交**

```bash
git add phone-relay/app/src/main/java/com/agentbridge/relay/RelayService.kt
git commit -m "fix: 中继监听 IP 漂移重注册（补 onLinkPropertiesChanged）并修首次回调空转"
```

---

## Task 4: 真机 E2E 验证（手动，需手机 + 眼镜）

**Files:** 无（验证 Task 2/3 的行为）。

**前置**：编译出 `app/build/outputs/apk/debug/app-debug.apk`，`adb install` 到手机（非眼镜、无 ROM 限制），启动中继；眼镜连手机热点。

- [ ] **Step 1: 场景 A —— 同一热点内 IP 漂移自动重注册（缝 A 核心验证）**

中继运行中，强制手机重取 IP（关 WiFi 再开，或 `adb shell cmd wifi forget-network` 后重连同一热点）→ 观察中继 Logcat（`adb -s <手机> logcat -s Relay`）出现新的 `mDNS registered`，且**无需手动重启中继**。眼镜恢复连接。

- [ ] **Step 2: 场景 B —— 注册失败退避重试（缝 D 验证）**

启动中继时故意让 NsdManager 失败一次（如快速开关 WiFi 触发 ALREADY_ACTIVE）→ 观察 Logcat 出现 `mDNS registration failed` 后，约 1s/2s/4s 递增重试，最终 `mDNS registered`。

- [ ] **Step 3: 回归 —— 正常启动/停止不变**

「启动中继」→「停止」→ 再启动，mDNS 正常注册/注销，无崩溃、无 `FAILURE_ALREADY_ACTIVE` 卡死。

- [ ] **Step 4: 回归 —— 眼镜端到端重连**

眼镜进入「connecting retry」后，中继重注册 → 眼镜 mDNS 重新发现并恢复，Core 日志再次出现 `ar_glasses` 注册。

---

## 测试策略小结

| 层 | 验证方式 |
|----|---------|
| `RetryPolicy`（纯退避） | JVM 单测（Task 1） |
| `MdnsBroadcaster` 壳（restart/retry 调度） | 编译门禁（Task 2）+ 真机 E2E（Task 4 场景 A/B/回归） |
| `RelayService` 壳（网络回调/IP 漂移） | 编译门禁（Task 3）+ 真机 E2E（Task 4 场景 A/回归） |

> `MdnsBroadcaster` / `RelayService` 无法纯 JVM 测：`NsdManager` / `ConnectivityManager` / `NsdServiceInfo` 是 Android 组件，模块未引入 Robolectric（与项目现有约定一致）。正确性靠编译 + 真机，这是本模块一贯的验证方式。

## 非目标

- 不重启 `RelayServer`、不做 mDNS 周期重注册、不改眼镜端、不引入 Robolectric。
- 不修「Service 被系统 kill 但进程存活时 static `isRunning` 与 instance 字段不一致」的既有边界问题（超出本次 mDNS 四缝范围）。
- `registerDefaultNetworkCallback` 注册后会立即回调当前网络，导致冷启动多一次 `restart()`（无害，最终状态正确），本次不做优化。
