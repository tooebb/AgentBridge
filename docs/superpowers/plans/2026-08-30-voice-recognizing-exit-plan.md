# 语音「识别中」可退出 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让眼镜语音输入在「识别中」状态可被双击退出（丢弃即将到达的 STT 结果回到空闲），并可随时单击重新录音。

**Architecture:** 把「是否正在等 STT 结果」从 MainViewModel 的隐式布尔抽成一个纯 JVM 类 `VoiceResultGate`（放在 `agent` 包，与 `CardStateMachine`/`ReconnectGuard` 同款可单测风格），MainViewModel 薄薄一层接线。

**Tech Stack:** Kotlin（Compose）。生产改动仅 2 个文件：新增 `VoiceResultGate.kt`，改 `MainViewModel.kt`。

## Global Constraints

- **不改 Core 协议**：middleware-core 零改动。
- **不改 AgentBridgeClient 消息协议**：`DeviceMessage`/`UnifiedMessage` 字段不变。
- **审批链路不变**：`needs_approval` → approve/reject → 工具执行链路不碰。
- **不改 `VoiceCapture.kt`**：录音/VAD 逻辑维持现状。
- 所有单元测试用**纯 JUnit**（`testImplementation(libs.junit)`，模块已有），不引入 Robolectric / AndroidX test。
- 编译用本机 Gradle 自动 provision 的 JDK 21 + Android SDK（路径见下）。

### 构建环境（每次跑 gradle 前先 export）

```bash
export JAVA_HOME="/c/Users/_/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
export ANDROID_HOME="/c/Users/_/AppData/Local/Android/Sdk"
```

模块根目录（后续所有 `./gradlew` 命令在此目录执行）：

```bash
cd "D:\project\5project\AgentBridge-master\rokid-sdk\cxrssample\cxrswithcxrl"
```

---

## 行为矩阵（本次要达成的终态）

| 状态 | 单击（approve） | 双击（reject） |
|---|---|---|
| 空闲 | 开始录音 → 聆听中 | 重置卡片（现状不变） |
| 聆听中 | 手动停止 → 识别中（现状不变） | 取消录音 → 回空闲（新增） |
| 识别中 | 重新开始录音（现状已支持） | 退出 → 回空闲，丢弃结果（新增） |

---

## Task 1: 新增纯类 `VoiceResultGate`（TDD）

**Files:**
- Create: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/VoiceResultGate.kt`
- Test: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/VoiceResultGateTest.kt`

**Interfaces:**
- Consumes: 无（独立纯类）。
- Produces: `class VoiceResultGate`，方法：
  - `fun markPending()` — 一次录音开始，标记「正在等结果」。
  - `fun cancel()` — 取消当前等待。
  - `fun shouldDisplayResult(): Boolean` — 消费式查询：当且仅当 pending 时返回 `true` 并复位；否则返回 `false`（用于门控 `user_input` 结果显示）。

- [ ] **Step 1: 写失败测试**

`VoiceResultGateTest.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceResultGateTest {
    @Test
    fun resultNotDisplayedWhenNeverStarted() {
        val gate = VoiceResultGate()
        assertFalse(gate.shouldDisplayResult())
    }

    @Test
    fun resultDisplayedOnceAfterStart() {
        val gate = VoiceResultGate()
        gate.markPending()
        assertTrue(gate.shouldDisplayResult())
        assertFalse(gate.shouldDisplayResult())
    }

    @Test
    fun cancelSuppressesPendingResult() {
        val gate = VoiceResultGate()
        gate.markPending()
        gate.cancel()
        assertFalse(gate.shouldDisplayResult())
    }

    @Test
    fun restartAfterCancelDisplaysNewResult() {
        val gate = VoiceResultGate()
        gate.markPending()
        gate.cancel()
        gate.markPending()
        assertTrue(gate.shouldDisplayResult())
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "D:\project\5project\AgentBridge-master\rokid-sdk\cxrssample\cxrswithcxrl"
./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.VoiceResultGateTest"
```

Expected: 编译失败 `Unresolved reference: VoiceResultGate`（类还不存在）。

- [ ] **Step 3: 写最小实现**

`VoiceResultGate.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

class VoiceResultGate {
    private var pending = false

    fun markPending() {
        pending = true
    }

    fun cancel() {
        pending = false
    }

    fun shouldDisplayResult(): Boolean {
        if (!pending) return false
        pending = false
        return true
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
./gradlew :app:testDebugUnitTest --tests "com.rokid.cxrswithcxrl.agent.VoiceResultGateTest"
```

Expected: `BUILD SUCCESSFUL`，4 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/VoiceResultGate.kt \
        rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/VoiceResultGateTest.kt
git commit -m "feat: 新增 VoiceResultGate 门控语音结果显示（TDD）"
```

---

## Task 2: 接线到 `MainViewModel.kt`

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`

**Interfaces:**
- Consumes: `VoiceResultGate`（Task 1）。
- Produces: `MainViewModel` 行为变更——双击在非审批态会取消语音；`user_input` 结果受 `voiceResultGate` 门控。

> 本任务无独立 JVM 单测（MainViewModel 依赖 CXRServiceBridge/Context 等 Android 组件，且模块无 Robolectric）。正确性由 Task 1 的 `VoiceResultGate` 单测覆盖决策逻辑 + 本任务末尾 `assembleDebug` 编译通过 + Task 3 真机 E2E 覆盖接线。以下每步是对 `MainViewModel.kt` 的一处精确编辑。

- [ ] **Step 1: 加 import**

在 import 区（第 18–31 行的 `com.rokid.cxrswithcxrl.agent.*` 块内，按字母序排在 `VoiceCaptureState` 之后）新增：

```kotlin
import com.rokid.cxrswithcxrl.agent.VoiceResultGate
```

- [ ] **Step 2: 加字段**

在 `private var voiceCapture: VoiceCapture? = null`（约第 57 行）之后新增：

```kotlin
    private val voiceResultGate = VoiceResultGate()
```

- [ ] **Step 3: 改 `onMessage` 的 `user_input` 与终端事件分支（第 343–344 行）**

把：

```kotlin
                    when (message.event?.eventType) {
                        "user_input" -> _voiceStatus.value = "已识别: ${message.event?.body.orEmpty()}（处理中…）"
                        "task_completed", "task_failed", "needs_approval" -> _voiceStatus.value = ""
                    }
```

改成：

```kotlin
                    when (message.event?.eventType) {
                        "user_input" -> {
                            if (voiceResultGate.shouldDisplayResult()) {
                                _voiceStatus.value = "已识别: ${message.event?.body.orEmpty()}（处理中…）"
                            }
                        }
                        "task_completed", "task_failed", "needs_approval" -> {
                            _voiceStatus.value = ""
                            voiceResultGate.cancel()
                        }
                    }
```

- [ ] **Step 4: 改 `onGesture` 非审批分支（第 426–428 行）**

把：

```kotlin
            } else if (actionType == "reject") {
                _agentCard.value = CardStateMachine.resetToIdle(card)
            }
```

改成：

```kotlin
            } else if (actionType == "reject") {
                cancelVoice()
                _agentCard.value = CardStateMachine.resetToIdle(card)
            }
```

- [ ] **Step 5: 改 `toggleVoice()` 开始录音时标记 pending**

在 `toggleVoice()` 内、`host.isNullOrBlank()` 守卫之后、`val capture = VoiceCapture(` 之前（约第 446 行）新增一行：

```kotlin
        voiceResultGate.markPending()
```

- [ ] **Step 6: 新增 `cancelVoice()` 方法**

在 `toggleVoice()` 方法结束（约第 460 行的 `}`）之后新增：

```kotlin
    private fun cancelVoice() {
        voiceResultGate.cancel()
        voiceCapture?.stop()
        voiceCapture = null
        _voiceStatus.value = ""
    }
```

> 顺序说明：`stop()` 会同步触发 `onState(IDLE)` 把 `_voiceStatus` 设成「识别中…」，所以 `_voiceStatus.value = ""` 必须放在 `stop()` 之后才能覆盖回空闲空态。

- [ ] **Step 7: 编译验证**

```bash
cd "D:\project\5project\AgentBridge-master\rokid-sdk\cxrssample\cxrswithcxrl"
./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`，无编译错误。APK 输出 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 8: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt
git commit -m "feat: 双击退出「识别中」语音状态并丢弃结果"
```

---

## Task 3: 真机 E2E 验证（手动，需眼镜 + 手机）

**Files:** 无（验证 Task 2 的行为）。

**前置**：把 Task 2 编译出的 `app-debug.apk` 按 `adb_build_workflow` 走手机 CXR-L SDK 安装到眼镜（眼镜 ROM 禁 `adb install`，唯一路径 `cxrLink.appUploadAndInstall`；若已装旧版需先 `uninstallApp` 再装）。Core 与 STT 服务保持运行。

- [ ] **Step 1: 场景 A —— 识别中双击退出**

单击 → 说一句 → 观察「聆听中 → 识别中」→ 识别中**双击** → 卡片回空闲、语音状态区清空，且之后不再弹出「已识别: …」。

- [ ] **Step 2: 场景 B —— 识别中单击重录**

识别中**单击** → 重新进入「聆听中」，可再次说话，新结果正常显示。

- [ ] **Step 3: 场景 C —— 聆听中双击取消**

聆听中**双击** → 立即回空闲，录音停止。

- [ ] **Step 4: 回归 —— 审批链路不受影响**

触发一次高风险工具 → 眼镜出现审批卡片 → 单击 approve / 双击 reject 行为与之前一致。

> 若真机不在手边，本任务可延后；Task 1 + Task 2 的代码已可安全提交，不影响现有语音/审批功能。

---

## 测试策略小结

- **单元测试**（Task 1）：`VoiceResultGate` 4 用例覆盖空闲/正常/取消/重录四条路径。
- **编译门禁**（Task 2）：`./gradlew assembleDebug` 保证接线无类型/符号错误。
- **真机 E2E**（Task 3）：三个新交互场景 + 审批回归。

## 非目标

- 不在协议层为语音结果加会话关联（已知限制：取消后立即重录，旧结果可能抢先返回被误显示；单用户顺序操作下几乎不触发）。
- 不动 VAD 参数、STT 常驻模型、TTS。
- 不做「已取消」提示文案。
