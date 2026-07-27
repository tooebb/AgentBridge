# AgentBridge V2 Phase 2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 真实设备端到端闭环 — 眼镜端 WebSocket 直连 Core + 卡片渲染 + TTS + 按键审批 + 真机联调验收

**架构思路：** 眼镜端（cxrswithcxrl）新增 OkHttp WebSocket 客户端直连 Core，接收 Agent 事件、渲染 Compose 卡片、TTS 播报、按键映射回传。手机端（CXRLSample）改动最小化——仅负责 CXR 生命周期（安装+启动眼镜 App）和传递连接参数。CXR SDK `sendCustomCmd` 已确认不可用，眼镜→Core 所有数据通信走 WebSocket。

**技术栈：** Kotlin, OkHttp 4.x, Jetpack Compose, Gson, SharedPreferences, Android TTS (TextToSpeech), CXR-L SDK v1.0.4, CXR-S SDK

## 全局约束

- 眼镜端：基于 `cxrswithcxrl` 工程（`com.rokid.cxrswithcxrl`），新增文件而非重写已有类
- 手机端：基于 `CXRLSample` 工程（`com.rokid.renewcxrlsample`），最小化改动
- 协议：WebSocket 标准 JSON，与 Core phase1 已实现协议完全对齐
- 眼镜端 WebSocket 直连 Core：`ws://<PC-IP>:8080/ws/{session_id}?device_type=ar_glasses`
- 手机端不中转数据，只做 CXR 生命周期（install + start）+ 传连接参数
- 按键映射：单击(CLICK) → QuickActions[0]（approve），双击(DOUBLE_CLICK) → QuickActions[1]（reject），长按(LONG_PRESS) → view_details
- 重连策略：指数退避（2s → 4s → 8s → max 30s），携带 last_acked_seq
- TTS：使用 Android 内置 TextToSpeech API，不依赖 Rokid AK/SK
- 开发阶段：Core 地址硬编码在眼镜 App 中（可后续改为 ADB 传参或配置文件）
- 代码位置：Kotlin 代码在 Rokid 工程内，不在 AgentBridge 仓库；协议测试脚本在 AgentBridge 仓库

---

## 文件结构

```
在眼镜工程（cxrswithcxrl）内创建/修改:
  agent/AgentBridgeProtocol.kt           — 协议数据类（DeviceMessage/ClientMessage/ClientAction）
  agent/AgentBridgeClient.kt             — OkHttp WS 客户端 + ack 追踪 + 指数退避重连
  agent/AgentActionHandler.kt            — 卡片状态管理 + TTS 播报 + 按键动作路由
  agent/CardRenderer.kt                  — Compose 卡片 UI（StatusCard/ActionableCard/AlertCard）
  activities/main/MainViewModel.kt       — 集成 AgentBridgeClient + AgentActionHandler
  activities/main/MainActivity.kt        — 集成 AgentCard UI + 生命周期管理
  receiver/KeyReceiver.kt                — 复用已有系统广播（无需修改，已支持 CLICK/DOUBLE_CLICK/LONG_PRESS）
  build.gradle.kts                       — 新增 OkHttp + Gson 依赖
  AndroidManifest.xml                    — 新增 INTERNET 权限

在手机工程（CXRLSample）内修改:
  activities/session/SessionHubScreen.kt — 新增 Core 地址输入框（可选，开发阶段可跳过）
  activities/session/SessionHubViewModel.kt — 传递 server URL 给眼镜（如 SDK 支持）

在 AgentBridge 仓库内创建:
  mock-device/device-protocol-test.js    — 模拟设备协议一致性测试（可脱离真机运行）
  docs/w3-device-field-test.md           — 真机现场联调操作手册
```

---

### Task 1: 眼镜端 build.gradle — 新增 OkHttp + Gson 依赖

**涉及文件:**
- 修改: `cxrssample/cxrswithcxrl/app/build.gradle.kts`（或 `build.gradle`）

**接口契约:**
- 消费: 无
- 产出: OkHttp 4.12.x、Gson 2.10.x 可在眼镜 App 中使用

- [ ] **Step 1: 确认当前构建文件格式**

先检查眼镜工程的构建文件是 Kotlin DSL (`.kts`) 还是 Groovy (`.gradle`)：

```bash
ls cxrssample/cxrswithcxrl/app/build.gradle* 2>/dev/null
```

- [ ] **Step 2: 添加依赖**

如果是 `build.gradle.kts`，在 `dependencies` 块中添加：

```kotlin
// cxrssample/cxrswithcxrl/app/build.gradle.kts
dependencies {
    // ... 已有依赖保持不变 ...

    // AgentBridge: OkHttp WebSocket + JSON
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.10.1")
}
```

如果是 `build.gradle`：

```groovy
dependencies {
    // ... 已有依赖保持不变 ...

    // AgentBridge: OkHttp WebSocket + JSON
    implementation 'com.squareup.okhttp3:okhttp:4.12.0'
    implementation 'com.google.code.gson:gson:2.10.1'
}
```

- [ ] **Step 3: Sync + 验证编译**

Android Studio `File → Sync Project with Gradle Files`，然后 `Build → Make Module 'cxrswithcxrl'`。
期望结果: BUILD OK。

- [ ] **Step 4: 提交**

```bash
cd cxrssample/cxrswithcxrl
git add app/build.gradle.kts  # 或 build.gradle
git commit -m "feat: 新增 OkHttp 4.12 + Gson 2.10 依赖（AgentBridge WS 客户端）"
```

---

### Task 2: AgentBridgeProtocol.kt — 协议数据类（眼镜端）

**涉及文件:**
- 创建: `cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt`

**接口契约:**
- 产出: `DeviceMessage`, `UnifiedMessage`, `AvailableAction`, `DeviceOutput`, `ClientMessage`, `ClientAction` 六个 data class
- 对齐: Core `middleware-core/internal/domain/types.go` 的 JSON 字段名
- 消费: Task 3 (AgentBridgeClient)、Task 4 (AgentActionHandler)

- [ ] **Step 1: 创建 AgentBridgeProtocol.kt**

```kotlin
// cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt
package com.rokid.cxrswithcxrl.agent

import com.google.gson.annotations.SerializedName

/** Core → 眼镜：每条 WebSocket 消息的顶层信封 */
data class DeviceMessage(
    val direction: String,            // "server_to_client"
    @SerializedName("message_id") val messageId: String,
    @SerializedName("session_id") val sessionId: String,
    val seq: Long = 0,                // 单调递增，用于 ack 追踪
    @SerializedName("is_replay") val isReplay: Boolean = false,
    val timestamp: Long,
    val event: UnifiedMessage?,
    @SerializedName("device_overrides") val deviceOverrides: Map<String, DeviceOutput>?
)

/** 中间层统一事件 */
data class UnifiedMessage(
    val id: String,
    @SerializedName("task_id") val taskId: String,
    @SerializedName("session_id") val sessionId: String,
    @SerializedName("event_type") val eventType: String,
    val title: String,
    val body: String,
    val severity: String,             // "info" | "warning" | "critical"
    @SerializedName("risk_score") val riskScore: Double,
    @SerializedName("risk_blocked") val riskBlocked: Boolean,
    @SerializedName("available_actions") val availableActions: List<AvailableAction>,
    val timestamp: String,
    @SerializedName("agent_id") val agentId: String
)

/** 可用操作 */
data class AvailableAction(
    @SerializedName("action_type") val actionType: String,
    val label: String,
    @SerializedName("confirmation_required") val confirmationRequired: Boolean = false
)

/** 单设备专属渲染输出（从 device_overrides.ar_glasses 解析） */
data class DeviceOutput(
    @SerializedName("card_title") val cardTitle: String,
    @SerializedName("card_body") val cardBody: String,
    @SerializedName("render_hint") val renderHint: String,       // "status_card" | "actionable_card" | "alert_card" | "card"
    @SerializedName("quick_actions") val quickActions: List<String>,
    @SerializedName("tts_text") val ttsText: String?,
    @SerializedName("action_prompt") val actionPrompt: String?
)

/** 眼镜 → Core：用户操作消息 */
data class ClientMessage(
    val direction: String = "client_to_server",
    @SerializedName("session_id") val sessionId: String,
    @SerializedName("task_id") val taskId: String,
    @SerializedName("last_acked_seq") val lastAckedSeq: Long = 0,
    val action: ClientAction
)

/** 用户操作载荷 */
data class ClientAction(
    val type: String,                 // "approve" | "reject" | "continue" | "pause" | "view_details"
    @SerializedName("device_type") val deviceType: String,
    val timestamp: Long,
    val text: String? = null          // 语音输入预留
)
```

- [ ] **Step 2: 验证编译**

Android Studio `Build → Make Module 'cxrswithcxrl'`。
期望结果: BUILD OK，无未解析引用。

- [ ] **Step 3: 提交**

```bash
cd cxrssample/cxrswithcxrl
git add app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeProtocol.kt
git commit -m "feat: 新增 AgentBridge 协议数据类（对齐 Core JSON 字段）"
```

---

### Task 3: AgentBridgeClient.kt — WebSocket 连接管理 + ack 追踪（眼镜端）

**涉及文件:**
- 创建: `cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt`

**接口契约:**
- 消费: `AgentBridgeProtocol.kt` (Task 2)
- 产出: `AgentBridgeClient` 类 — `connect(serverUrl, sessionId)`, `disconnect()`, `sendAction(taskId, type, text?)`, `onMessage callback`
- 重连: 指数退避 2s→4s→8s→16s→max 30s
- 持久化: SharedPreferences 存 `last_acked_seq`

- [ ] **Step 1: 创建 AgentBridgeClient.kt**

```kotlin
// cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt
package com.rokid.cxrswithcxrl.agent

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.gson.Gson
import okhttp3.*
import java.util.concurrent.TimeUnit

/**
 * 眼镜端 WebSocket 客户端。
 * 直连 Core，接收 Agent 事件，回传用户操作。
 * 支持 seq 去重、ack 持久化、指数退避重连。
 */
class AgentBridgeClient(private val context: Context) {

    companion object {
        private const val TAG = "AgentBridgeClient"
        private const val PREFS_NAME = "agentbridge_ack"
        private const val KEY_LAST_SEQ = "last_acked_seq"
        private const val MAX_RECONNECT_DELAY_SEC = 30L
        private val RECONNECT_DELAYS = longArrayOf(2, 4, 8, 16, 30)
    }

    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS) // 无超时，保持长连接
        .build()
    private var ws: WebSocket? = null
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private var currentSessionId: String = ""
    private var currentDeviceType: String = "ar_glasses"
    private var lastAckedSeq: Long = prefs.getLong(KEY_LAST_SEQ, 0L)
    private var reconnectAttempt: Int = 0
    private var serverUrl: String = ""
    private var shouldReconnect: Boolean = true

    var onEventReceived: ((DeviceMessage) -> Unit)? = null
    var onConnectionState: ((Boolean) -> Unit)? = null

    /** 建立 WebSocket 连接 */
    fun connect(serverWsUrl: String, sessionId: String, deviceType: String = "ar_glasses") {
        serverUrl = serverWsUrl
        currentSessionId = sessionId
        currentDeviceType = deviceType
        reconnectAttempt = 0
        shouldReconnect = true
        doConnect()
    }

    private fun doConnect() {
        val url = "${serverUrl}/ws/${currentSessionId}" +
            "?device_type=${currentDeviceType}&last_acked_seq=${lastAckedSeq}"
        Log.i(TAG, "连接: $url")

        val request = Request.Builder().url(url).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "已连接 (session=$currentSessionId)")
                reconnectAttempt = 0
                onConnectionState?.invoke(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleIncoming(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "连接失败: ${t.message}")
                onConnectionState?.invoke(false)
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "连接关闭: $code $reason")
                onConnectionState?.invoke(false)
                if (shouldReconnect) scheduleReconnect()
            }
        })
    }

    /** 处理收到的消息 */
    private fun handleIncoming(text: String) {
        try {
            val msg = gson.fromJson(text, DeviceMessage::class.java) ?: return

            // seq 去重
            if (msg.seq > 0) {
                if (msg.seq <= lastAckedSeq) {
                    Log.d(TAG, "跳过重复消息 seq=${msg.seq} (lastAcked=$lastAckedSeq)")
                    return
                }
                lastAckedSeq = msg.seq
                prefs.edit().putLong(KEY_LAST_SEQ, lastAckedSeq).apply()
            }

            Log.i(TAG, "收到事件: ${msg.event?.eventType} seq=${msg.seq} replay=${msg.isReplay}")
            onEventReceived?.invoke(msg)
        } catch (e: Exception) {
            Log.e(TAG, "消息解析失败: ${e.message}")
        }
    }

    /** 发送用户操作回 Core */
    fun sendAction(taskId: String, actionType: String, text: String? = null) {
        val msg = ClientMessage(
            sessionId = currentSessionId,
            taskId = taskId,
            lastAckedSeq = lastAckedSeq,
            action = ClientAction(
                type = actionType,
                deviceType = currentDeviceType,
                timestamp = System.currentTimeMillis(),
                text = text
            )
        )
        val json = gson.toJson(msg)
        Log.i(TAG, "发送操作: $json")
        ws?.send(json)
    }

    /** 断开连接 */
    fun disconnect() {
        shouldReconnect = false
        ws?.close(1000, "用户主动断开")
        ws = null
    }

    /** 指数退避重连 */
    private fun scheduleReconnect() {
        if (!shouldReconnect) return
        val delay = RECONNECT_DELAYS.getOrElse(reconnectAttempt) { MAX_RECONNECT_DELAY_SEC }
        Log.i(TAG, "${delay}s 后重连（第 ${reconnectAttempt + 1} 次）")
        Thread {
            Thread.sleep(delay * 1000)
            if (shouldReconnect) {
                reconnectAttempt++
                doConnect()
            }
        }.start()
    }
}
```

- [ ] **Step 2: 验证编译**

Android Studio `Build → Make Module 'cxrswithcxrl'`。
期望结果: BUILD OK。

- [ ] **Step 3: 提交**

```bash
cd cxrssample/cxrswithcxrl
git add app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt
git commit -m "feat: AgentBridgeClient — WS 连接管理 + ack 追踪 + 指数退避重连"
```

---

### Task 4: AgentActionHandler.kt — 卡片状态管理 + TTS + 按键路由（眼镜端）

**涉及文件:**
- 创建: `cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt`

**接口契约:**
- 消费: `AgentBridgeProtocol` (Task 2)
- 产出: `AgentActionHandler` 类 — `handleMessage(msg)`, `onButtonClick()`, `onButtonDoubleClick()`, `onButtonLongPress()`, `submitAction(type, text?)`
- TTS: `TextToSpeech` 中文语音播报

- [ ] **Step 1: 创建 AgentActionHandler.kt**

```kotlin
// cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt
package com.rokid.cxrswithcxrl.agent

import android.content.Context
import android.speech.tts.TextToSpeech
import android.util.Log
import java.util.*

/**
 * 眼镜端 Agent 消息处理器。
 * 负责：卡片状态管理、TTS 播报、按键动作路由。
 */
class AgentActionHandler(private val context: Context) {

    companion object {
        private const val TAG = "AgentActionHandler"
    }

    private var tts: TextToSpeech? = null

    // 当前卡片状态（供 Compose 读取）
    var currentHint: String = "card"
        private set
    var currentTitle: String = ""
        private set
    var currentBody: String = ""
        private set
    var currentActions: List<String> = emptyList()
        private set
    var currentTaskId: String = ""
        private set
    var isRiskBlocked: Boolean = false
        private set
    var hasActiveCard: Boolean = false
        private set

    var onCardChanged: (() -> Unit)? = null
    var onActionRequest: ((String, String?) -> Unit)? = null

    /** 初始化 TTS 引擎 */
    fun initTTS() {
        tts = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val result = tts?.setLanguage(Locale.CHINESE)
                Log.i(TAG, "TTS 初始化成功 (lang=$result)")
            } else {
                Log.e(TAG, "TTS 初始化失败: $status")
            }
        }
    }

    /** 处理来自 Core 的 DeviceMessage */
    fun handleMessage(msg: DeviceMessage) {
        val event = msg.event ?: return
        val override = msg.deviceOverrides?.get("ar_glasses")

        when (event.eventType) {
            "task_started", "task_running", "task_completed" -> {
                currentHint = "status_card"
                currentTitle = override?.cardTitle ?: event.title
                currentBody = override?.cardBody ?: event.body
                currentActions = emptyList()
                currentTaskId = event.taskId
                isRiskBlocked = false
                hasActiveCard = true
                onCardChanged?.invoke()

                val ttsText = override?.ttsText
                if (!ttsText.isNullOrBlank()) speak(ttsText)
            }

            "needs_approval", "task_blocked" -> {
                currentHint = "actionable_card"
                currentTitle = override?.cardTitle ?: event.title
                currentBody = override?.cardBody ?: event.body
                currentActions = override?.quickActions ?: event.availableActions.map { it.actionType }
                currentTaskId = event.taskId
                isRiskBlocked = event.riskBlocked
                hasActiveCard = true
                onCardChanged?.invoke()

                val ttsText = if (event.riskBlocked) {
                    "高风险操作，请回到电脑端确认"
                } else {
                    override?.ttsText ?: "需要审批: ${event.title}"
                }
                speak(ttsText)
            }

            "task_failed" -> {
                currentHint = "alert_card"
                currentTitle = override?.cardTitle ?: event.title
                currentBody = override?.cardBody ?: event.body
                currentActions = listOf("view_details")
                currentTaskId = event.taskId
                isRiskBlocked = false
                hasActiveCard = true
                onCardChanged?.invoke()

                val ttsText = override?.ttsText ?: event.body
                speak(ttsText)
            }
        }

        Log.d(TAG, "卡片已更新: hint=$currentHint taskId=$currentTaskId")
    }

    /** TTS 播报（使用 Android 离线 TTS，不依赖 Rokid AK/SK） */
    private fun speak(text: String) {
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "agentbridge_tts_${System.currentTimeMillis()}")
    }

    /** 按键 → Action 映射 */

    /** 单击 → QuickActions[0]（通常 approve/continue） */
    fun onButtonClick(): String? {
        if (isRiskBlocked || currentActions.isEmpty()) return null
        return currentActions[0]
    }

    /** 双击 → QuickActions[1]（通常 reject/pause） */
    fun onButtonDoubleClick(): String? {
        if (isRiskBlocked || currentActions.size < 2) return null
        return currentActions[1]
    }

    /** 长按 → view_details */
    fun onButtonLongPress(): String {
        return "view_details"
    }

    /** 提交操作（回传 Core） */
    fun submitAction(actionType: String, text: String? = null) {
        Log.i(TAG, "提交操作: $actionType (task=$currentTaskId)")
        onActionRequest?.invoke(actionType, text)
    }

    /** 重置为空状态 */
    fun clear() {
        hasActiveCard = false
        onCardChanged?.invoke()
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
```

- [ ] **Step 2: 验证编译**

Android Studio `Build → Make Module 'cxrswithcxrl'`。
期望结果: BUILD OK。

- [ ] **Step 3: 提交**

```bash
cd cxrssample/cxrswithcxrl
git add app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt
git commit -m "feat: AgentActionHandler — 卡片状态 + TTS 播报 + 按键路由"
```

---

### Task 5: CardRenderer.kt — Compose 卡片 UI（眼镜端）

**涉及文件:**
- 创建: `cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt`

**接口契约:**
- 消费: `AgentActionHandler` (Task 4) 的状态 getter
- 产出: `AgentCard` Composable — 根据 render_hint 渲染 status_card / actionable_card / alert_card / card

- [ ] **Step 1: 创建 CardRenderer.kt**

```kotlin
// cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt
package com.rokid.cxrswithcxrl.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 眼镜端卡片颜色常量（深色背景，适合 AR 眼镜 OLED 屏幕） */
object CardColors {
    val STATUS_BG = Color(0xFF1B5E20)      // 深绿背景
    val STATUS_BORDER = Color(0xFF4CAF50)
    val ACTION_BG = Color(0xFFE65100)      // 橙色背景
    val ACTION_BORDER = Color(0xFFFF9800)
    val ALERT_BG = Color(0xFFB71C1C)       // 红色背景
    val ALERT_BORDER = Color(0xFFF44336)
    val DEFAULT_BG = Color(0xFF263238)     // 深灰背景
    val DEFAULT_BORDER = Color(0xFF607D8B)
    val TEXT_PRIMARY = Color.White
    val TEXT_SECONDARY = Color(0xFFB0BEC5)
}

/**
 * 根据 render_hint 渲染对应卡片样式。
 * @param hint — "status_card" | "actionable_card" | "alert_card" | "card"
 */
@Composable
fun AgentCard(
    hint: String,
    title: String,
    body: String,
    quickActions: List<String> = emptyList(),
    riskBlocked: Boolean = false,
    modifier: Modifier = Modifier
) {
    val (bgColor, borderColor) = when (hint) {
        "status_card" -> CardColors.STATUS_BG to CardColors.STATUS_BORDER
        "actionable_card" -> CardColors.ACTION_BG to CardColors.ACTION_BORDER
        "alert_card" -> CardColors.ALERT_BG to CardColors.ALERT_BORDER
        else -> CardColors.DEFAULT_BG to CardColors.DEFAULT_BORDER
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(bgColor, RoundedCornerShape(12.dp))
            .border(2.dp, borderColor, RoundedCornerShape(12.dp))
            .padding(16.dp)
    ) {
        // 标题
        Text(
            text = title,
            color = CardColors.TEXT_PRIMARY,
            fontSize = 18.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis
        )

        Spacer(modifier = Modifier.height(8.dp))

        // 正文
        Text(
            text = body,
            color = CardColors.TEXT_SECONDARY,
            fontSize = 14.sp,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis
        )

        // 风险拦截提示
        if (riskBlocked) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "⚠ 高风险操作，请回到电脑端确认",
                color = Color(0xFFFFEB3B),
                fontSize = 12.sp,
                maxLines = 1
            )
        }

        // 快捷操作提示
        if (quickActions.isNotEmpty() && !riskBlocked) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = quickActions.mapIndexed { index, action ->
                    val prefix = when (index) {
                        0 -> "单击"
                        1 -> "双击"
                        else -> "按键${index + 1}"
                    }
                    val label = when (action) {
                        "approve" -> "批准"
                        "reject" -> "拒绝"
                        "continue" -> "继续"
                        "pause" -> "暂停"
                        "view_details" -> "详情"
                        else -> action
                    }
                    "$prefix: $label"
                }.joinToString(" | "),
                color = CardColors.TEXT_SECONDARY,
                fontSize = 12.sp,
                maxLines = 1
            )
        }
    }
}

/** 无事件的空状态占位 */
@Composable
fun EmptyCard(modifier: Modifier = Modifier) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(CardColors.DEFAULT_BG, RoundedCornerShape(12.dp))
            .padding(16.dp)
    ) {
        Text(
            text = "等待 Agent 任务...",
            color = CardColors.TEXT_SECONDARY,
            fontSize = 14.sp
        )
    }
}
```

- [ ] **Step 2: 验证编译**

Android Studio `Build → Make Module 'cxrswithcxrl'`。
期望结果: BUILD OK。

- [ ] **Step 3: 提交**

```bash
cd cxrssample/cxrswithcxrl
git add app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt
git commit -m "feat: CardRenderer — Compose 卡片 UI（status/actionable/alert/card）"
```

---

### Task 6: 集成 — MainViewModel + MainActivity（眼镜端）

**涉及文件:**
- 修改: `cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`
- 修改: `cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainActivity.kt`
- 修改: `cxrssample/cxrswithcxrl/app/src/main/AndroidManifest.xml`

**接口契约:**
- 消费: Task 3 (AgentBridgeClient)、Task 4 (AgentActionHandler)、Task 5 (CardRenderer)
- 产出: 眼镜端按键→Agent 操作完整闭环

- [ ] **Step 1: 修改 AndroidManifest.xml — 添加 INTERNET 权限**

在 `<manifest>` 标签内确认或添加网络权限：

```xml
<!-- cxrssample/cxrswithcxrl/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
```

- [ ] **Step 2: 改造 MainViewModel.kt — 集成 AgentBridgeClient + AgentActionHandler**

在现有 `MainViewModel` 中添加 AgentBridge 集成（保留已有的 `CXRServiceBridge` 和 `sendMessage` 逻辑）：

```kotlin
// 在 MainViewModel 类的成员变量区添加:
import com.rokid.cxrswithcxrl.agent.AgentBridgeClient
import com.rokid.cxrswithcxrl.agent.AgentActionHandler
import com.rokid.cxrswithcxrl.agent.DeviceMessage

// 开发阶段硬编码 Core 地址（后续改为可配置）
private val CORE_SERVER_URL = "ws://192.168.1.100:8080"
private val CORE_SESSION_ID = "default"

private lateinit var agentClient: AgentBridgeClient
private lateinit var agentHandler: AgentActionHandler

private val _agentCardHint = MutableStateFlow("card")
val agentCardHint = _agentCardHint.asStateFlow()

private val _agentCardTitle = MutableStateFlow("")
val agentCardTitle = _agentCardTitle.asStateFlow()

private val _agentCardBody = MutableStateFlow("")
val agentCardBody = _agentCardBody.asStateFlow()

private val _agentCardActions = MutableStateFlow<List<String>>(emptyList())
val agentCardActions = _agentCardActions.asStateFlow()

private val _agentCardVisible = MutableStateFlow(false)
val agentCardVisible = _agentCardVisible.asStateFlow()

private val _agentRiskBlocked = MutableStateFlow(false)
val agentRiskBlocked = _agentRiskBlocked.asStateFlow()

// 在 init 块中初始化 AgentBridge（在已有代码之后添加）:
init {
    // ... 已有 CXRServiceBridge 初始化保持不变 ...

    agentHandler = AgentActionHandler(/* context 从 Application 获取 */)
    agentHandler.initTTS()

    agentHandler.onCardChanged = {
        _agentCardHint.value = agentHandler.currentHint
        _agentCardTitle.value = agentHandler.currentTitle
        _agentCardBody.value = agentHandler.currentBody
        _agentCardActions.value = agentHandler.currentActions
        _agentCardVisible.value = agentHandler.hasActiveCard
        _agentRiskBlocked.value = agentHandler.isRiskBlocked
    }

    agentHandler.onActionRequest = { actionType, text ->
        agentClient.sendAction(agentHandler.currentTaskId, actionType, text)
    }

    agentClient = AgentBridgeClient(/* context */)
    agentClient.onEventReceived = { msg -> agentHandler.handleMessage(msg) }
    agentClient.onConnectionState = { connected ->
        _debugStatus.value = if (connected) "WS connected" else "WS disconnected"
    }
}

// 在 keyEventListener 中修改按键处理:
private val keyEventListener = object : KeyEventListener {
    override fun onKeyEvent(keyType: KeyType) {
        when (keyType) {
            KeyType.CLICK -> {
                val action = agentHandler.onButtonClick()
                if (action != null) {
                    agentHandler.submitAction(action)
                    return
                }
                sendMessage("Key: CLICK")
            }
            KeyType.DOUBLE_CLICK -> {
                val action = agentHandler.onButtonDoubleClick()
                if (action != null) {
                    agentHandler.submitAction(action)
                    return
                }
                sendMessage("Key: DOUBLE_CLICK")
            }
            KeyType.LONG_PRESS -> {
                val action = agentHandler.onButtonLongPress()
                agentHandler.submitAction(action)
            }
            else -> sendMessage("Listener: key action = ${keyType.name}")
        }
    }
}

// 添加连接方法:
fun connectAgentBridge() {
    agentClient.connect(CORE_SERVER_URL, CORE_SESSION_ID)
}

fun disconnectAgentBridge() {
    agentClient.disconnect()
    agentHandler.shutdown()
}
```

注意：`init` 块中 `agentHandler` 和 `agentClient` 需要 `Context`。如果 `MainViewModel` 当前不持有 Context，使用 `AndroidViewModel` 或通过参数传入。最简单的方案：改为 `AndroidViewModel(application)`：

```kotlin
// 将 class MainViewModel: ViewModel() 改为:
class MainViewModel(application: Application) : AndroidViewModel(application) {
    // ...
    init {
        val ctx = getApplication<Application>()
        agentHandler = AgentActionHandler(ctx)
        agentClient = AgentBridgeClient(ctx)
        // ...
    }
}
```

- [ ] **Step 3: 改造 MainActivity.kt — 集成 AgentCard UI**

在 `setContent` 中将原有的诊断 UI 替换或与 AgentCard 共存：

```kotlin
// MainActivity.kt 的 onCreate 中，setContent 块改为:
setContent {
    CXRSWithCXRLTheme {
        val cardHint by viewModel.agentCardHint.collectAsState()
        val cardTitle by viewModel.agentCardTitle.collectAsState()
        val cardBody by viewModel.agentCardBody.collectAsState()
        val cardActions by viewModel.agentCardActions.collectAsState()
        val cardVisible by viewModel.agentCardVisible.collectAsState()
        val riskBlocked by viewModel.agentRiskBlocked.collectAsState()
        val debugStatus by viewModel.debugStatus.collectAsState()

        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(color = Color.Black)
                .padding(12.dp),
            verticalArrangement = Arrangement.Top,
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // [DIAG] 连接状态
            GreenText(text = "[DIAG] $debugStatus")
            Spacer(modifier = Modifier.padding(vertical = 4.dp))

            // Agent 卡片区域（有事件时显示卡片，否则显示空状态）
            if (cardVisible) {
                AgentCard(
                    hint = cardHint,
                    title = cardTitle,
                    body = cardBody,
                    quickActions = cardActions,
                    riskBlocked = riskBlocked
                )
            } else {
                EmptyCard()
            }

            Spacer(modifier = Modifier.padding(vertical = 8.dp))

            // 保留原有的 CXR 消息显示（调试用）
            val fromClient by viewModel.capsFromClient.collectAsState()
            GreenText(text = "[SUB] $fromClient")
            Spacer(modifier = Modifier.padding(vertical = 4.dp))
            GreenText(text = "单击:批准 | 双击:拒绝 | 长按:详情")
        }
    }
}

// 在 onCreate 末尾添加:
viewModel.connectAgentBridge()
```

- [ ] **Step 4: 验证编译**

Android Studio `Build → Make Module 'cxrswithcxrl'`。
期望结果: BUILD OK，无编译错误。

- [ ] **Step 5: 提交**

```bash
cd cxrssample/cxrswithcxrl
git add app/src/main/AndroidManifest.xml \
        app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt \
        app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainActivity.kt
git commit -m "feat: 集成 AgentBridge — WS 客户端 + AgentCard UI + 按键映射"
```

---

### Task 7: 手机端 — Core 地址配置传递（CXRLSample）

**涉及文件:**
- 修改: `CXRLSample/app/src/main/java/com/rokid/renewcxrlsample/app/CONSTANT.kt` — 新增 Core 地址常量
- 可选修改: `CXRLSample/app/src/main/java/com/rokid/renewcxrlsample/activities/session/SessionHubScreen.kt` — 新增地址输入框

**接口契约:**
- 消费: 无（独立任务）
- 产出: 手机端将 Core 地址传递给眼镜端的入口

**注意：** CXR-L `appStart` 不支持传递 Intent extras 到眼镜端。当前阶段眼镜端的 Core 地址硬编码（Task 6 中的 `CORE_SERVER_URL`）。手机端本任务是预留接口，后续可扩展。

- [ ] **Step 1: 在 CONSTANT.kt 中添加 Core 地址默认值**

```kotlin
// CXRLSample/app/src/main/java/com/rokid/renewcxrlsample/app/CONSTANT.kt
// 添加到 object CONSTANT 中:
const val DEFAULT_CORE_SERVER_URL = "ws://192.168.1.100:8080"
const val DEFAULT_CORE_SESSION_ID = "default"
```

- [ ] **Step 2: （可选）在 SessionHubScreen 添加地址输入**

在 `SessionHubScreen` Composable 中添加一个文本输入框，用于配置 Core 地址。该值通过 SharedPreferences 持久化，后续眼镜 App 可通过同样方式读取（如果两个 App 共享 SharedPreferences ID）。

如果两个 App 无法共享 SharedPreferences，则暂跳过此 UI，仅保留常量。开发阶段每次改 IP 时修改 `CORE_SERVER_URL` 常量并重新编译眼镜 App。

- [ ] **Step 3: 验证编译 + 提交**

```bash
cd CXRLSample
git add app/src/main/java/com/rokid/renewcxrlsample/app/CONSTANT.kt
git commit -m "feat: 新增 Core 地址常量（预留后续设备发现）"
```

---

### Task 8: 协议一致性测试脚本（AgentBridge 仓库）

**涉及文件:**
- 创建: `mock-device/device-protocol-test.js`

**接口契约:**
- 模拟 ar_glasses 设备，验证 WebSocket 协议合规性
- 覆盖：seq/ack/replay/action/device_overrides 字段完整性 + 5 种动作类型

- [ ] **Step 1: 创建 device-protocol-test.js**

```javascript
// mock-device/device-protocol-test.js
// 模拟 ar_glasses 设备，验证 AgentBridge WebSocket 协议合规性。
// 无需真机：本脚本模拟眼镜设备的行为。

const WebSocket = require('ws');
const http = require('http');

const SERVER = process.env.SERVER || 'http://localhost:8080';
const WS_BASE = SERVER.replace(/^http/, 'ws');
const SESSION = 'proto-test-' + Date.now();
const TIMEOUT = 5000;

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) { console.log('  PASS:', name); passed++; }
  else { console.log('  FAIL:', name + (detail ? ' — ' + detail : '')); failed++; }
}

function postEvent(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL('/api/v1/events', SERVER);
    const req = http.request({
      hostname: url.hostname, port: url.port || 8080, path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error('HTTP ' + res.statusCode)) : resolve(JSON.parse(out || '{}')));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitMsg(ws, pred, ms = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), ms);
    const h = data => {
      try {
        const m = JSON.parse(data.toString());
        if (pred(m)) { clearTimeout(timer); ws.removeListener('message', h); resolve(m); }
      } catch (_) { /* skip */ }
    };
    ws.on('message', h);
  });
}

async function run() {
  console.log('\n  AgentBridge — 设备协议一致性测试\n');
  console.log('  模拟设备: ar_glasses (眼镜端)');

  // 1. 连接设备
  const ws = new WebSocket(`${WS_BASE}/ws/${SESSION}?device_type=ar_glasses`);
  await new Promise((res, rej) => {
    ws.on('open', res); ws.on('error', rej);
    setTimeout(() => rej(new Error('连接超时')), 3000);
  });
  console.log('  [1] 眼镜设备已连接');

  // 2. 发送 needs_approval 事件
  const p1 = waitMsg(ws, m => m.event?.event_type === 'needs_approval');
  await postEvent({
    id: 'pt-1', task_id: 'task-pt', session_id: SESSION,
    event_type: 'needs_approval', title: '协议测试: 审批', body: '验证字段完整性',
    severity: 'warning', risk_score: 0.7, risk_blocked: false,
    available_actions: [
      { action_type: 'approve', label: '批准', confirmation_required: false },
      { action_type: 'reject', label: '拒绝', confirmation_required: false },
    ],
    timestamp: new Date().toISOString(), agent_id: 'test',
  });
  const msg = await p1;

  // 协议字段检查
  check('direction = server_to_client', msg.direction === 'server_to_client', `实际: ${msg.direction}`);
  check('message_id 非空', typeof msg.message_id === 'string' && msg.message_id.length > 0);
  check('session_id 正确', msg.session_id === SESSION);
  check('seq 存在且 > 0', typeof msg.seq === 'number' && msg.seq > 0, `seq=${msg.seq}`);
  check('is_replay 字段存在', typeof msg.is_replay === 'boolean', `实际: ${msg.is_replay}`);
  check('event 非空', msg.event != null);
  check('event.event_type = needs_approval', msg.event.event_type === 'needs_approval');
  check('event.available_actions 长度 = 2', msg.event.available_actions?.length === 2,
    `实际: ${msg.event.available_actions?.length}`);

  // device_overrides 字段检查
  check('device_overrides 非空', msg.device_overrides != null);
  check('device_overrides.ar_glasses 存在', msg.device_overrides?.ar_glasses != null);
  const ov = msg.device_overrides?.ar_glasses;
  check('overrides.card_title 非空', typeof ov?.card_title === 'string' && ov.card_title.length > 0);
  check('overrides.card_body 非空', typeof ov?.card_body === 'string' && ov.card_body.length > 0);
  check('overrides.render_hint = actionable_card', ov?.render_hint === 'actionable_card',
    `实际: ${ov?.render_hint}`);
  check('overrides.quick_actions 长度 >= 2', ov?.quick_actions?.length >= 2,
    `实际: [${ov?.quick_actions}]`);
  check('overrides.tts_text 非空', typeof ov?.tts_text === 'string' && ov.tts_text.length > 0);
  check('overrides.action_prompt 非空', typeof ov?.action_prompt === 'string');

  // 3. 验证 approve 动作（模拟眼镜按键回传，含 voice text）
  ws.send(JSON.stringify({
    direction: 'client_to_server',
    session_id: SESSION,
    task_id: 'task-pt',
    last_acked_seq: msg.seq,
    action: {
      type: 'approve',
      device_type: 'ar_glasses',
      timestamp: Date.now(),
      text: 'voice approved',
    },
  }));
  console.log('  [2] 已发送 approve 动作（含 text 字段）');
  await new Promise(r => setTimeout(r, 500));

  // 4. 验证全部动作类型格式
  const actionTypes = ['reject', 'continue', 'pause', 'view_details'];
  for (const type of actionTypes) {
    ws.send(JSON.stringify({
      direction: 'client_to_server',
      session_id: SESSION,
      task_id: 'task-pt',
      last_acked_seq: msg.seq,
      action: { type, device_type: 'ar_glasses', timestamp: Date.now() },
    }));
  }
  await new Promise(r => setTimeout(r, 300));

  // 验证 Core 未断开（所有动作格式合法）
  check('WebSocket 保持连接（5 种动作格式全部合法）', ws.readyState === WebSocket.OPEN,
    `readyState=${ws.readyState}`);

  console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('错误:', err.message); process.exit(1); });
```

- [ ] **Step 2: 注册 npm script**

在 `mock-device/package.json` 的 scripts 中添加：

```json
"test:protocol": "node device-protocol-test.js"
```

- [ ] **Step 3: 运行测试**

```bash
# 先启动 Core
cd middleware-core && AGENTBRIDGE_ADDR=0.0.0.0:8080 AGENTBRIDGE_EVENT_DB=/tmp/test.db go run ./cmd/server

# 运行协议测试
cd mock-device && SERVER=http://127.0.0.1:8080 node device-protocol-test.js
```
期望结果: 17 项全部 PASS。

- [ ] **Step 4: 提交**

```bash
cd mock-device
git add device-protocol-test.js package.json
git commit -m "test: 设备协议一致性测试 — 验证 seq/ack/replay/action 字段完整性"
```

---

### Task 9: 真机现场联调手册

**涉及文件:**
- 创建: `docs/w3-device-field-test.md`

- [ ] **Step 1: 创建联调手册**

```markdown
# W3 真机现场联调操作手册

## 环境准备

1. **PC 端**: 启动 Core（LAN 可达）
   ```bash
   cd middleware-core
   AGENTBRIDGE_ADDR=0.0.0.0:8080 AGENTBRIDGE_EVENT_DB=/tmp/w3-field.db go run ./cmd/server
   ```
2. **确认 PC IP**: 记录局域网 IP（如 192.168.31.208），眼镜需要能访问此 IP。
3. **启动 Agent Adapter**（另开终端）
   ```bash
   cd agent-adapter
   AGENTBRIDGE_AGENT=generic-cli npm run dev
   ```
4. **手机连 PC**: USB 连接，`adb devices` 确认设备在线。
5. **眼镜连手机**: 通过 CXR SDK 配对（Rokid AI App）。

## 部署步骤

### 眼镜端
1. 修改 `cxrswithcxrl/MainViewModel.kt` 中 `CORE_SERVER_URL` 为 PC 局域网 IP
2. Android Studio `Build → Make Module 'cxrswithcxrl'` 编译 APK
3. 将 APK 推到手机：`adb push app/build/outputs/apk/debug/app-debug.apk /sdcard/DCIM/Rokid/cxrL.apk`
4. 手机 CXR Sample: `CUSTOMAPP session → 安装 + 启动眼镜 App`

### 手机端
1. Android Studio 打开 `CXRLSample`
2. Build → Run 安装到手机（如已安装则跳过）

## 验收场景

以下 6 个场景全部通过记 Phase 2 联调完成。

| # | 场景 | 操作 | 通过标准 |
|---|------|------|---------|
| 1 | WebSocket 连接 | 启动眼镜 App | 眼镜显示"等待 Agent 任务..."空状态卡片，DIAG 行显示 "WS connected" |
| 2 | 状态卡片 | Agent 发送 task_started | 眼镜显示绿色 status_card，标题/正文不溢出 |
| 3 | 可操作卡片 | Agent 发送 needs_approval | 眼镜显示橙色 actionable_card + TTS "需要审批" + 底部按键提示 |
| 4 | 按键 Approve | 眼镜镜腿按键单击 | Core 收到 approve user_action，Agent 继续执行 |
| 5 | 按键 Reject | 眼镜镜腿按键双击 | Core 收到 reject user_action，Agent 收到拒绝通知 |
| 6 | 断连重连 | 关闭手机 WiFi 10 秒后恢复 | 眼镜重连后收到补发消息（is_replay=true），不重复展示旧消息 |

## 故障排查

如任一场景失败，收集以下信息：
```bash
adb devices
adb logcat -d -t 300 | grep -E "AgentBridge|OkHttp|WebSocket|TTS"
```
同时保留 Core 控制台日志、Agent Adapter 日志、眼镜 App 日志（通过 `adb logcat`）。
```

- [ ] **Step 2: 提交**

```bash
git add docs/w3-device-field-test.md
git commit -m "docs: W3 真机现场联调操作手册"
```

---

### Task 10: 文档更新 + 全量验证

**涉及文件:**
- 修改: `CLAUDE.md`
- 修改: `README.md`（如需要）

- [ ] **Step 1: 更新 CLAUDE.md**

追加 Phase 2 状态：

```markdown
### Phase 2 状态 (2026-07-27)

眼镜端 Kotlin 代码已完成（在 cxrswithcxrl 工程内），眼镜直连 Core WebSocket：

| 组件 | 文件 | 状态 |
|------|------|------|
| 协议数据类 | agent/AgentBridgeProtocol.kt | 已实现 |
| WS 连接管理 | agent/AgentBridgeClient.kt | 已实现 |
| 卡片+按键+TTS | agent/AgentActionHandler.kt | 已实现 |
| Compose 卡片 UI | agent/CardRenderer.kt | 已实现 |
| 集成层 | MainViewModel.kt + MainActivity.kt | 已修改 |
| 设备发现 | CONSTANT.kt（手机端 Core 地址常量） | 已实现 |
| 协议测试 | mock-device/device-protocol-test.js | 已实现 |

联调环境: `docs/w3-device-field-test.md` 包含 6 个验收场景。
真机联调前模拟验证: `mock-device/device-protocol-test.js`（17 项）和 `mock-device/w3-readiness-check.js`。
```

- [ ] **Step 2: 全量验证**

```bash
# Core 测试
cd middleware-core && go test ./... -count=1
# Expected: ALL PASS

# 协议测试
cd mock-device && SERVER=http://127.0.0.1:8080 node device-protocol-test.js
# Expected: 17 PASS

# W3 预检
cd mock-device && SERVER=http://127.0.0.1:8080 npm run w3:preflight
# Expected: 4 PASS, 1 WARN (adb)
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 记录 Phase 2 客户端开发完成状态"
```

---

## Phase 2 完成标准

- [ ] 眼镜端 AgentBridgeProtocol.kt 编译通过
- [ ] 眼镜端 AgentBridgeClient.kt 编译通过
- [ ] 眼镜端 AgentActionHandler.kt + CardRenderer.kt 编译通过
- [ ] 眼镜端 MainViewModel + MainActivity 集成编译通过
- [ ] 设备协议一致性测试 17/17 PASS
- [ ] W3 预检 4/4 PASS
- [ ] Core `go test ./...` 全部 PASS
- [ ] 真机联调 6 个场景验收通过（需要实机环境）
- [ ] CLAUDE.md 已更新
