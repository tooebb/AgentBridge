# 手机中继 mDNS 网络重注册 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机网络变化后，中继自动重新注册 mDNS，眼镜无需重启中继即可重连。

**Architecture:** `RelayService` 注册默认网络回调，`onAvailable` 去抖后 stop+start `MdnsBroadcaster`。

**Tech Stack:** Kotlin（Android）。仅改 `phone-relay/app/src/main/java/com/agentbridge/relay/RelayService.kt`。

## Global Constraints

- 不改 Core 协议、不改眼镜端、不改 `MdnsBroadcaster` / `RelayServer` / `RelayConfig`。
- 无 JVM 单测（`NetworkCallback` 为 Android 组件，模块无 Robolectric）；正确性靠编译门禁 + 真机 E2E。
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

## Task 1: `RelayService` 加网络回调 + mDNS 重注册

**Files:**
- Modify: `phone-relay/app/src/main/java/com/agentbridge/relay/RelayService.kt`

**Interfaces:**
- Consumes: 现有 `MdnsBroadcaster`、`RelayConfig.LISTEN_PORT`。
- Produces: 网络变化后 `MdnsBroadcaster` 自动 stop+start 重新注册。

- [ ] **Step 1: 加 import**

在 import 区加：

```kotlin
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
```

- [ ] **Step 2: 加字段**

在 `private var mdnsBroadcaster: MdnsBroadcaster? = null` 之后加：

```kotlin
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val rebroadcastHandler = Handler(Looper.getMainLooper())
    private val rebroadcastRunnable = Runnable { rebroadcastMdns() }
```

- [ ] **Step 3: `onCreate` 注册网络回调**

在 `onCreate` 的 `createNotificationChannel(channel)` 之后加：

```kotlin
        registerNetworkCallback()
```

- [ ] **Step 4: 新增网络回调 + 去抖 + 重注册方法**

在 `onBind` 之前新增三个方法：

```kotlin
    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                scheduleRebroadcast()
            }
        }
        networkCallback = callback
        cm.registerDefaultNetworkCallback(callback)
    }

    private fun scheduleRebroadcast() {
        rebroadcastHandler.removeCallbacks(rebroadcastRunnable)
        rebroadcastHandler.postDelayed(rebroadcastRunnable, REBROADCAST_DEBOUNCE_MS)
    }

    private fun rebroadcastMdns() {
        if (!isRunning) return
        mdnsBroadcaster?.stop()
        mdnsBroadcaster = MdnsBroadcaster(this, RelayConfig.LISTEN_PORT).also { it.start() }
    }
```

- [ ] **Step 5: `onDestroy` 注销回调**

在 `onDestroy` 开头（`relayServer?.stop()` 之前）加：

```kotlin
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkCallback?.let { cm?.unregisterNetworkCallback(it) }
        networkCallback = null
        rebroadcastHandler.removeCallbacks(rebroadcastRunnable)
```

- [ ] **Step 6: `companion object` 加去抖常量**

在 `companion object` 内加：

```kotlin
        private const val REBROADCAST_DEBOUNCE_MS = 500L
```

- [ ] **Step 7: 编译验证**

```bash
cd "D:\project\5project\AgentBridge-master\phone-relay"
./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`。APK 输出 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 8: 提交**

```bash
git add phone-relay/app/src/main/java/com/agentbridge/relay/RelayService.kt
git commit -m "feat: 手机中继网络变化时自动重新注册 mDNS"
```

---

## Task 2: 真机 E2E 验证（手动，需手机）

**Files:** 无（验证 Task 1 的行为）。

**前置**：把 Task 1 编译出的 `app-debug.apk` 安装到手机（`adb install`，手机非眼镜、无 ROM 限制），启动中继。

- [ ] **Step 1: 场景 A —— 切换 WiFi 自动重注册**

启动中继 → 手机切换 WiFi（或连接第三方热点）→ 观察中继日志出现新的 `mDNS registered`，且无需手动重启中继。

- [ ] **Step 2: 场景 B —— 眼镜自动重连**

眼镜侧若因网络切换进入「connecting retry」，中继重注册后眼镜 mDNS 重新发现并恢复连接（Core 日志再次出现 `ar_glasses` 注册）。

- [ ] **Step 3: 回归 —— 正常启动/停止不变**

手动「启动中继」→「停止」→ 再启动，mDNS 正常注册/注销，无崩溃。

> 手机侧 `adb install` 可用（非眼镜）；日志观察靠中继 app 的 Logcat（`adb -s <手机> logcat -s Relay`）。

---

## 测试策略小结

- **编译门禁**（Task 1）：`./gradlew assembleDebug`。
- **真机 E2E**（Task 2）：网络切换自动重注册 + 眼镜自动重连 + 启停回归。

## 非目标

- 不重启 `RelayServer`、不做 mDNS 周期重注册、不改眼镜端。
