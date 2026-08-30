# 手机中继 mDNS 网络重注册 设计文档

> 状态：待用户审阅（2026-08-30）。本 spec 修复一个稳定性缺陷：手机网络变化（WiFi 切换 / 开关热点 / 网络恢复）后，中继的 mDNS 广播仍绑定旧网络接口，眼镜无法重新发现，只能手动重启中继。

**Goal:** 手机网络变化后，中继自动重新注册 mDNS，眼镜无需重启中继即可重新发现并重连。

**Architecture:** `RelayService` 注册 `ConnectivityManager` 默认网络回调；网络可用/变化时（带 500ms 去抖）stop+start `MdnsBroadcaster` 重新注册。TCP 中继 socket（`ServerSocket` 绑定通配地址）跨网络天然存活，无需重启。

**Tech Stack:** Kotlin（Android）。仅 `RelayService.kt` 一个文件。

## 全局约束

- 不改 Core 协议、不改眼镜端、不改 `MdnsBroadcaster` / `RelayServer` / `RelayConfig` 本身。
- 服务启动/停止生命周期不变（`RelayService.isRunning` 语义不变）。
- 编译用本机 Gradle（JDK 21 + Android SDK，路径见 plan）。

## 现状（设计依据）

- `MdnsBroadcaster.start()` 只在 `RelayService.onStartCommand` 注册一次（`isRunning` 为 false 时）。
- `RelayServer` 用 `ServerSocket(listenPort)`（`RelayServer.kt:24`）绑定通配地址 `0.0.0.0`，跨网络接口仍能 accept，**TCP 中继不受网络切换影响**。
- 出问题的只有 mDNS：`NsdManager.registerService` 注册在注册当时的网络接口上，网络切换后注册不迁移，新网络上 `_agentbridge._tcp` 不可发现。

已真机复现：眼镜与手机一度同时接入第三方热点（172.20.10.0/28），而非「眼镜连手机热点」，中继的一次性 mDNS 注册失效，眼镜持续「connecting retry」；重启中继（重新注册 mDNS）后恢复。

## 改动：`RelayService.kt` 加 NetworkCallback

### 1. 新增字段与去抖

```kotlin
private var networkCallback: ConnectivityManager.NetworkCallback? = null
private val rebroadcastHandler = Handler(Looper.getMainLooper())
private val rebroadcastRunnable = Runnable { rebroadcastMdns() }
```

### 2. `onCreate` 注册网络回调

```kotlin
override fun onCreate() {
    super.onCreate()
    val channel = NotificationChannel(CHANNEL_ID, "Phone relay", NotificationManager.IMPORTANCE_LOW)
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    registerNetworkCallback()
}
```

### 3. 网络回调 + 去抖 + 重注册

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

### 4. `onDestroy` 注销回调

```kotlin
override fun onDestroy() {
    val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    networkCallback?.let { cm?.unregisterNetworkCallback(it) }
    networkCallback = null
    rebroadcastHandler.removeCallbacks(rebroadcastRunnable)
    // ...（其余 relayServer?.stop() / mdnsBroadcaster?.stop() / isRunning=false 不变）
}
```

## 设计取舍

- **只 re-register mDNS，不重启 `RelayServer`**：`ServerSocket` 通配绑定跨网络可用，重启无意义且会短暂中断现有连接。
- **只用 `onAvailable`，不用 `onCapabilitiesChanged`**：mDNS 是局域网组播，不依赖 internet 校验；`onAvailable` 是「默认网络变化/出现」的干净信号，够用且避免无谓 churn。
- **500ms 去抖**：网络切换瞬间可能连发 onLost/onAvailable，去抖合并成一次重注册，避免 NsdManager 快速 stop/start。
- 初次注册时 `onAvailable` 会立刻触发一次 `scheduleRebroadcast`，但彼时 `isRunning` 为 false，`rebroadcastMdns()` 早退，不影响 `onStartCommand` 的首次注册；即便时序上落在首次注册之后，也只是幂等重注册一次，无害。

## 已知限制 / 非目标

- 不处理「眼镜与手机均接入第三方热点」场景下 mDNS 跨网段不可达的问题（mDNS 是链路本地组播，跨网段本就不通；该场景需回落到眼镜直连 PC 或另起组网）。
- 不做 mDNS 周期重注册（避免持续 churn）。
- 不改 `CHANGE_WIFI_MULTICAST_STATE` 权限（已有）。

## 测试策略

- **编译门禁**：`./gradlew assembleDebug`。
- **真机 E2E**（手动）：切换手机网络（热点↔第三方 WiFi↔关开 WiFi）后，观察中继日志出现新的 `mDNS registered`，眼镜自动重连。

## 非目标

- 不改 TCP 透传逻辑、不改眼镜端发现逻辑、不加任何协议字段。
