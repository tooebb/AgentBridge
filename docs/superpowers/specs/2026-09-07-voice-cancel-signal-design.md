# 语音「取消信号」设计文档

> 状态：待用户审阅（2026-09-07）。本 spec 修复一个交互缺口：语音输入进入「识别中」后双击取消，只清除了眼镜端显示，未通知 PC 端，导致已转写/正在转写的语音仍被送入 Claude 执行（用户反馈「表面退回界面，但语音还是加载进进程继续执行」）。

**Goal:** 让双击取消语音能真正作废「尚未送入 Claude」的那句话——把「取消」信号从眼镜经 Core 传到 agent-adapter，由后者作废当前 utterance（既不回显到眼镜、也不送进 Claude）。

**Architecture:** 三层各一处。眼镜端 `cancelVoice()` 增发 `cancel_voice` 动作；Core 新增 `ActionCancelVoice` 动作类型并透传给 adapter（不落盘）；agent-adapter 的 `UtteranceGate` 增加 `cancel()`，收到信号时作废 generation。

**Tech Stack:** Kotlin（眼镜端 Compose）+ Go（middleware-core）+ TypeScript（agent-adapter，Node 22 + ws）。

## 全局约束

- **不改消息结构/字段**：`ClientMessage`/`ClientAction`/`UnifiedMessage` 字段全部不变，只新增一个 action type 值 `"cancel_voice"`。这是本次相对既往 voice spec 的唯一协议差异——既往 spec 约束「不改 Core 协议」，本次必须新增一个动作类型值来承载取消信号。
- **审批链路不变**：`needs_approval` → approve/reject → 工具执行链路不碰。
- **不改 `VoiceCapture.kt`**：录音/VAD 逻辑维持现状（眼镜端只改 `AgentBridgeClient.kt` + `MainViewModel.kt`）。
- **cancel_voice 是瞬态控制信号**：不落 eventStore、不参与 replay、不发给眼镜（仅定向 adapter + 广播 dashboard 调试）。

## 现状（设计依据）

语音链路（已真机验证）：

1. 空闲 → 单击（`approve`）→ `toggleVoice()` → `VoiceCapture.start(ws://PC:8788)` → 录音，PCM 流经音频 WS 发到 PC `audio-server.ts`。
2. PC `audio-server.ts` VAD 检测到 `silenceMs=1000` 静音 → 定格 utterance → 回 `"stop"` → 眼镜 `VoiceCapture.stop()` 关音频 WS，进入「识别中」。
3. PC `session.ts` 的 `onUtterance`：`transcribe()` → `gate.isCurrent(snap)` 校验 → `sendEvent(user_input)` 回显 → `bridge.handleUserAction({ type: 'user_message', text })` 送 Claude。
4. 眼镜双击（`reject`，非审批态）→ `cancelVoice()`（`MainViewModel.kt:467`）：`voiceResultGate.cancel()` 压显示 + `voiceCapture?.stop()` 停录音 + `_voiceStatus=""`。

**缺口根因**：`cancelVoice()` 只做眼镜端本地清理，**没有向 PC 端发任何取消信号**。此时若 utterance 已定格、正在 `transcribe()`，转写完成后 `gate.isCurrent(snap)` 依然为 `true`（`UtteranceGate` 只在「重录」即新音频连接时递增 generation，纯取消不递增），于是照样 `sendEvent` + `handleUserAction` 送进 Claude。眼镜端因 `VoiceResultGate.cancel()` 已把 `pending` 置 false，`shouldDisplayResult()` 返回 false 不显示——「表面退回，实际还在跑」。

这是两个既往 spec 明确标注的已知限制：

- `2026-08-30-voice-reinput-latest-only-design.md:171`：「纯取消（双击后不重录）时，正在转写的旧句仍会送进 Claude……本次不扩协议加『取消』信号」。
- `2026-08-30-voice-recognizing-exit-design.md:108`：同样的竞态说明。

本次就是把这个「非目标」补上：新增 `cancel_voice` 信号，打通眼镜 → Core → adapter。

## 改动

### 1. 眼镜端

**1a. `AgentBridgeProtocol.kt` 新增常量**（与 `DEVICE_TYPE_AR_GLASSES` 并列）

```kotlin
const val ACTION_CANCEL_VOICE = "cancel_voice"
```

**1b. `AgentBridgeClient.kt` 新增 `sendVoiceCancel()`**

不能复用 `sendAction`：它要求 `taskId` 非空（否则直接返回 false）且经 `actionDeduper` 去重，取消语音无 taskId、也不应被去重吞掉。故独立一个方法，绕过这两点：

```kotlin
fun sendVoiceCancel(): Boolean {
    val message = ClientMessage(
        sessionId = sessionId,
        taskId = "",
        lastAckedSeq = lastAckedSeq,
        action = ClientAction(type = ACTION_CANCEL_VOICE)
    )
    val sent = webSocket?.send(gson.toJson(message)) == true
    if (!sent) {
        listener.onError("Voice cancel send failed", null)
    }
    return sent
}
```

说明：`lastAckedSeq` 照带（顺带 ack 既有消息，`onDeviceMessage` 的 ack 更新逻辑对 cancel_voice 无害）；`ClientAction.deviceType` 用默认 `DEVICE_TYPE_AR_GLASSES`。

**1c. `MainViewModel.kt:467` 的 `cancelVoice()` 增发信号**

```kotlin
private fun cancelVoice() {
    voiceResultGate.cancel()
    voiceCapture?.stop()
    voiceCapture = null
    _voiceStatus.value = ""
    agentClient?.sendVoiceCancel()
}
```

### 2. Core

**2a. `domain/types.go` 新增动作类型**（`ActionType` 常量组内）

```go
ActionCancelVoice ActionType = "cancel_voice"
```

**2b. `main.go:253` 的 `onDeviceMessage` switch 新增分支**

```go
case domain.ActionCancelVoice:
    s.relayVoiceCancel(sessionID, msg)
```

**2c. `main.go` 新增 `relayVoiceCancel`（不落盘）**

不复用 `relayUserAction`，因为它会 `eventStore.Append`（落盘 → 眼镜重连会 replay 到历史 cancel_voice，产生边缘情况）。cancel_voice 是瞬态信号，只透传 + 广播 dashboard：

```go
func (s *Server) relayVoiceCancel(sessionID string, msg *domain.ClientMessage) {
    action := msg.Action
    relay := &domain.UnifiedMessage{
        ID:        uuid.New().String(),
        SessionID: sessionID,
        EventType: domain.EventUserAction,
        Title:     "Voice cancel",
        Body:      string(action.Type),
        Severity:  domain.SeverityInfo,
        Timestamp: time.Now(),
        AgentID:   "middleware-core",
        Action:    &action,
    }
    deviceMsg := &domain.DeviceMessage{
        Direction: "server_to_client",
        MessageID: uuid.New().String(),
        SessionID: sessionID,
        Timestamp: time.Now().UnixMilli(),
        Event:     relay,
        Overrides: map[domain.DeviceType]*domain.DeviceOutput{
            domain.DeviceAgentAdapter: {
                RenderHint: "agent_action",
                CardTitle:  "Voice cancel",
                CardBody:   string(action.Type),
            },
        },
    }
    // 不 append eventStore：瞬态控制信号，不参与 replay
    if err := s.hub.SendToDevice(sessionID, domain.DeviceAgentAdapter, deviceMsg); err != nil {
        log.Printf("server: voice cancel relay to agent_adapter failed: %v", err)
    }
    s.hub.BroadcastToDashboard(deviceMsg)
}
```

说明：`TaskID` 留空（取消语音无 taskId）；不 append → `Seq` 保持 0（`omitempty` 省略），adapter 识别 `user_action` 靠 `event.action.type`，不依赖 seq。

### 3. agent-adapter

**3a. `utterance-gate.ts` 新增 `cancel()`**

```ts
cancel(): void {
  this.generation++;
}
```

语义：作废当前所有已发出的 snapshot（generation++ 后，旧的 `isCurrent` 全部为 false）。

**3b. `session.ts` 的 `user_action` 回调拦截 `cancel_voice`**

```ts
wsClient.on('user_action', (action) => {
  if ((action as UserActionInput).type === 'cancel_voice') {
    gate.cancel();
    return;
  }
  void bridge.handleUserAction(action as UserActionInput).catch((err) => {
    console.error('[session] failed to handle user action:', err instanceof Error ? err.message : err);
  });
});
```

说明：`cancel_voice` 不走 `bridge` 队列，直接 `gate.cancel()` 作废正在转写的 utterance；转写完成后 `gate.isCurrent(snap)` 返回 false → 整句丢弃（既不回显、也不送 Claude）。

**3c. 声明顺序（消除 TDZ 隐患）**

当前 `const gate = new UtteranceGate()` 声明在 `session.ts:137`，晚于 `wsClient.on('user_action', ...)`（`session.ts:117`）。虽然回调是异步触发（事件到达时 gate 已初始化、无 TDZ 问题），但建议把 `const gate` 上移到 `wsClient.on('user_action')` 之前，让依赖顺序显式化。

## 已知限制

- **只覆盖「尚未送入 Claude」的窗口**（约停口后 1.5~3 秒：VAD `silenceMs=1000` + STT 转写耗时）。若双击时 text 已经送进 Claude 正在处理，`cancel_voice` 无法撤回——需要额外「中断 Claude turn」机制（`ClaudeCodeAdapter.activeQuery.close()` 的底子已存在但未暴露），列为非目标、后续可扩展。
- **取消后立即重录的竞态**（承接 voice-reinput-latest-only 已知限制）：双击取消 → 单击重录 → 新音频连接 → `onConnection` 触发 `gate.markNewRecording()` 再次递增 generation，逻辑自洽；旧句无论处于转写中还是已作废，都会因 generation 不符被丢弃。
- **cancel_voice 到达时可能无 utterance 在转写**：`gate.cancel()` 递增 generation 是幂等无害的（之后若有新录音，`onConnection` 会再递增）。

## 测试策略

- **agent-adapter 单测**（`utterance-gate.test.ts`，沿用 node:test 风格）：`cancel()` 使旧 snapshot 失效。
  ```ts
  test('cancel invalidates a prior snapshot', () => {
    const gate = new UtteranceGate();
    const snap = gate.snapshot();
    gate.cancel();
    assert.equal(gate.isCurrent(snap), false);
  });
  ```
- **Core 编译 + 既有测试**：`go test ./...` 全绿（新增 `ActionCancelVoice` 常量与 `relayVoiceCancel` 不破坏既有 action 路由测试；若 `main_test.go` 已有 action 路由用例，补一个 `ActionCancelVoice` → relay 的断言）。
- **眼镜端编译门禁**：`./gradlew assembleDebug`（`sendVoiceCancel` 为纯逻辑，无需真机）。
- **真机 E2E**（手动，出眼镜 App 后验证）：
  1. 说话中双击取消 → 录音停止、回空闲，无「已识别」回显，Claude 不处理该句。
  2. 说完话（识别中）双击取消 → 转写中的旧句被作废，Claude 不处理。
  3. 回归：正常语音输入 → Claude 正常处理；审批链路（approve/reject）不变。

## 非目标

- 不做「中断 Claude 正在跑的 turn」：已送入 Claude 的 text 无法撤回（见已知限制）。后续若实测漏网率高，复用 `cancel_voice` 通路在 adapter 端加 `adapter.interrupt()` 即可，信号通路不用动。
- 不在协议层为语音结果加会话/序号关联（承接既往非目标）。
- 不动 VAD 参数、STT 常驻模型、TTS。
- 不做「已取消」提示文案（取消后直接回空闲空态）。
