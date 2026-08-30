# 语音「识别中」可退出 设计文档

> 状态：待用户审阅（2026-08-30）。本 spec 覆盖一个交互缺口：语音输入进入「识别中」后，用户无法主动退出；若当时是触控板误触导致的录音，只能干等结果。

**Goal:** 让「识别中」状态可被双击退出（丢弃即将到达的 STT 结果回到空闲），并可随时单击重新开始录音。不改 Core 协议、不改 AgentBridgeClient 消息协议、审批链路不变。

**Architecture:** 全部改动集中在眼镜端 `MainViewModel.kt`。新增一个布尔标志 `voicePending`，把「识别中」从隐式 UI 态变成可判定的显式态，双击清除该标志并忽略后续 `user_input` 结果。

**Tech Stack:** Kotlin（Compose），仅 `MainViewModel.kt`。

## 全局约束

- **不改 Core 协议**：middleware-core 零改动。
- **不改 AgentBridgeClient 消息协议**：`DeviceMessage`/`UnifiedMessage` 字段不变，只新增消费逻辑。
- **审批链路不变**：`needs_approval` → approve/reject → 工具执行的既有链路不被触碰。
- **不改 VoiceCapture.kt**：录音/停止/VAD 逻辑维持现状。

## 现状（设计依据）

语音链路（来自既有实现，已真机验证）：

1. **空闲** → 单击（`approve`）→ `MainViewModel.toggleVoice()` → `VoiceCapture.start()` → `VoiceCaptureState.RECORDING`，UI 显示「聆听中…」。
2. **聆听中** → server 端 VAD 检测到语音停止，通过音频 WS 回 `"stop"` → `VoiceCapture.onMessage` → `stop()` → `VoiceCaptureState.IDLE`，`onState(IDLE)` 显示「识别中…」。**录音是 VAD 自动结束的，不是再单击结束**（用户已纠正此点）。
3. **识别中** → STT 转写完成，daemon 回显 `user_input` 事件经 Core 透传到眼镜 → `AgentBridgeClient.Listener.onMessage` 把 `_voiceStatus` 设为「已识别: …（处理中…）」。
4. 终端事件（`task_completed`/`task_failed`/`needs_approval`）把 `_voiceStatus` 清空。

关键点：`VoiceCaptureState` 只有 `IDLE`/`RECORDING` 两态，「识别中」是 `IDLE` 之后、结果未到之前的**隐式**窗口，代码里没有标志可判定「是否正在等结果」。因此：

- `onMessage("user_input")` 无条件显示结果（`MainViewModel.kt:343`）——即使已经双击退出，结果仍会弹出来。
- 双击（`reject`）在非审批态下只执行 `CardStateMachine.resetToIdle(card)`，完全不碰语音（`MainViewModel.kt:426-428`）。

## 改动：`MainViewModel.kt` 引入 `voicePending` 标志

### 行为矩阵（目标）

| 状态 | 单击（approve） | 双击（reject） |
|---|---|---|
| 空闲 | 开始录音 → 聆听中 | 重置卡片（现状不变） |
| 聆听中 | 手动停止 → 识别中（现状不变） | 取消录音 → 回空闲（新增） |
| 识别中 | 重新开始录音（现状已支持，`toggleVoice` 在 IDLE 态会新建 capture） | 退出 → 回空闲，丢弃结果（新增） |

### 具体修改

**1. 新增字段**（`MainViewModel.kt`，`voiceCapture` 字段附近）

```kotlin
private var voicePending = false
```

语义：`true` = 一次录音已（或正在）产生，正在等待 STT 结果；`false` = 空闲/已取消/结果已消费。

**2. `onGesture` 非审批分支**（`MainViewModel.kt:423-429`）——双击改为「取消语音 + 重置卡片」

```kotlin
} else {
    if (actionType == "approve") {
        toggleVoice()
    } else if (actionType == "reject") {
        cancelVoice()
        _agentCard.value = CardStateMachine.resetToIdle(card)
    }
}
```

**3. 新增 `cancelVoice()`**

```kotlin
private fun cancelVoice() {
    voicePending = false
    voiceCapture?.stop()   // 若仍在聆听中则停止录音；若已 IDLE 则 no-op
    voiceCapture = null
    _voiceStatus.value = ""
}
```

注意顺序：先 `stop()`（会触发 `onState(IDLE)` 把 `_voiceStatus` 设成「识别中…」），再置空覆盖回空闲，保证最终显示为空。

**4. `toggleVoice()` 开始录音时置 `voicePending = true`**

在 `discoveredHost` 空检查之后、创建 `VoiceCapture` 之前：

```kotlin
voicePending = true
```

**5. `onMessage` 的 `user_input` 分支改为受 `voicePending` 门控**（`MainViewModel.kt:343`）

```kotlin
"user_input" -> {
    if (voicePending) {
        _voiceStatus.value = "已识别: ${message.event?.body.orEmpty()}（处理中…）"
        voicePending = false
    }
}
```

**6. 终端事件分支同时清 `voicePending`**（`MainViewModel.kt:344`）

```kotlin
"task_completed", "task_failed", "needs_approval" -> {
    _voiceStatus.value = ""
    voicePending = false
}
```

## 已知限制

- **取消后立即重录的竞态**：双击取消旧录音 → 单击开始新录音后，旧录音的 STT 结果若在新录音结果之前返回，会被当成新结果显示（`voicePending` 已被新录音重新置 `true`）。`user_input` 事件不携带录音会话标识，且「不改协议」约束下无法在眼镜端区分来源。实际影响极小：单用户顺序操作下，旧录音转写一般在重录完成前已返回。如需彻底消除，须在协议层为语音结果加会话/序号关联，列为后续非目标。

## 测试策略

- **Kotlin JVM 单测**（`MainViewModel` 现有测试风格，若可抽离）：`voicePending` 门控逻辑——`voicePending=true` 时 `user_input` 显示并复位；`voicePending=false` 时忽略；`cancelVoice` 后 `_voiceStatus` 为空、`voicePending=false`。
- **真机 E2E**（手动）：
  1. 单击 → 说一句 → 观察「聆听中 → 识别中」→ 识别中**双击** → 卡片回空闲，且不再弹出「已识别」。
  2. 识别中单击 → 重新进入聆听中，可再次录音。
  3. 聆听中双击 → 立即回空闲，录音停止。

## 非目标

- 不在协议层为语音结果加会话关联（见「已知限制」）。
- 不动 VAD 参数、STT 常驻模型、TTS（后两者已搁置）。
- 不做「已取消」提示文案（取消后直接回空闲空态）。
