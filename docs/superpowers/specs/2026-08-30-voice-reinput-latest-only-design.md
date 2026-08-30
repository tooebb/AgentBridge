# 语音「重录取最新」设计文档

> 状态：待用户审阅（2026-08-30）。本 spec 修复一个交互缺陷：语音输入「聆听中/识别中」时想重新输入，单击行为有竞态（时停时录），且旧句与新句都被送进 Agent，导致结果卡片混乱。

**Goal:** 让「聆听中/识别中」单击可靠地**重新录音**（丢弃当前录音重新开始），并保证**只有最新一句语音被处理**（旧句被丢弃，既不回显到眼镜、也不送进 Agent）。

**Architecture:** 两层各一处改。眼镜端把 `MainViewModel.toggleVoice()` 从「RECORDING 停 / IDLE 录」的分支改成「单击 = 永远重录」（先停旧再开新），消除竞态；PC 端 `agent-adapter` 给音频 WebSocket 连接加 generation 计数，转写完成时校验 generation，过期整句丢弃。

**Tech Stack:** Kotlin（Compose）+ TypeScript（agent-adapter，Node 22 + ws）。生产改动 5 个文件：眼镜 `MainViewModel.kt`；PC `audio-server.ts` + `session.ts` + 新增 `utterance-gate.ts` + 新增单测。

## 全局约束

- **不改 Core 协议**：middleware-core 零改动。
- **不改 AgentBridgeClient 消息协议**：`DeviceMessage`/`UnifiedMessage` 字段不变，只新增消费/门控逻辑。
- **不改 `VoiceCapture.kt`**：录音/VAD 逻辑维持现状（眼镜端只改 `MainViewModel.kt`）。
- **审批链路不变**：`needs_approval` → approve/reject → 工具执行链路不碰。
- 眼镜单测用**纯 JUnit**（模块已有）；agent-adapter 单测用 **node:test**（已有 `node --test` 脚本）。

## 现状（设计依据）

语音链路（已真机验证）：

1. 空闲 → 单击 → `toggleVoice()` → `VoiceCapture.start()` → RECORDING →「聆听中…」。
2. 聆听中 → 服务器 VAD 检测到静音 → 音频 WS 回 `"stop"` → `VoiceCapture.onMessage` → `stop()` → IDLE →「识别中…」。
3. 识别中 → STT 转写完成 → daemon 回 `user_input` 事件经 Core 透传到眼镜 → 显示「已识别: …」。
4. PC 端 `session.ts` 的 `onUtterance`：每定格一句话 → `transcribe()` → ① `sendEvent(user_input)` 回显眼镜 ② `bridge.handleUserAction(user_message)` 送进 Claude。

### 问题 1：单击行为竞态（眼镜端）

`MainViewModel.toggleVoice()` 用「RECORDING 还是 IDLE」决定停还是录：

```kotlin
fun toggleVoice() {
    val current = voiceCapture
    if (current != null && current.state == VoiceCaptureState.RECORDING) {
        current.stop()          // → 识别中
        return
    }
    // 否则开新录音 → 聆听中
}
```

但录音是 VAD 自动结束的：服务器回 `"stop"` 后 `VoiceCapture` 已变 IDLE，而 `voiceCapture` 对象仍非空。于是单击那一刻：

- VAD 尚未结束（state=RECORDING）→ 走 `stop()` → 变「识别中」；
- VAD 已结束（state=IDLE）→ 落进开新录音 → 变「聆听中」。

**同一个单击，结果取决于 VAD 是否先触发**，这就是「有时候识别中、有时候聆听中」。

### 问题 2：旧句 + 新句都被处理（PC 端）

`session.ts` 的 `onUtterance` 每定格一句话就异步转写 + 送出，没有「作废上一句」的机制。重录时上一句若已定格、正在转写，照样会转写完送进 Claude 并回显眼镜。

## 改动

### 行为矩阵（目标）

| 状态 | 单击（approve） | 双击（reject） |
|---|---|---|
| 空闲 | 开始录音 → 聆听中 | 重置卡片（现状不变） |
| 聆听中 | **重新录音**（停旧 + 开新 → 聆听中） | 取消录音 → 回空闲 |
| 识别中 | 重新录音 → 聆听中 | 退出 → 回空闲，丢弃结果 |

单击语义收敛为一条：**单击 = 开始 / 重新录音**；双击 = 取消。

### 1. `MainViewModel.toggleVoice()` 简化（眼镜端）

把「RECORDING 停」分支删掉，统一成「先停旧、再开新」：

```kotlin
fun toggleVoice() {
    val host = discoveredHost
    if (host.isNullOrBlank()) {
        _capsFromClient.value = "VOICE: no discovered PC host"
        return
    }

    voiceCapture?.stop()          // 旧的若在录则关闭（服务端丢弃未定格的旧句）
    voiceResultGate.markPending()
    val capture = VoiceCapture(
        onState = { state ->
            _capsFromClient.value = "VOICE: ${state.name.lowercase()}"
            _voiceStatus.value = when (state) {
                VoiceCaptureState.RECORDING -> "聆听中…"
                VoiceCaptureState.IDLE -> "识别中…"
            }
        },
        onError = { error ->
            _capsFromClient.value = "VOICE: $error"
        },
    )
    voiceCapture = capture
    capture.start("ws://$host:$audioPort")
}
```

说明：`voiceCapture?.stop()` 是幂等的（`VoiceCapture.stop()` 内部 `running.getAndSet(false)` 为 false 时直接返回）；旧 capture 一旦 stop 后不会再异步重发 `onState(IDLE)` 覆盖新态。`VoiceCaptureState` import 仍被 `onState` 回调使用，保留。

### 2. 新增纯类 `UtteranceGate`（agent-adapter）

放 `agent-adapter/src/utterance-gate.ts`，与眼镜端 `VoiceResultGate` 同款「纯类可单测」风格：

```ts
export class UtteranceGate {
  private generation = 0;

  /** 每次新音频 WS 连接（= 新一次录音）调用。 */
  markNewRecording(): void {
    this.generation++;
  }

  /** 转写前快照当前 generation。 */
  snapshot(): number {
    return this.generation;
  }

  /** 快照对应的录音是否仍是当前（没有被更新的录音取代）。 */
  isCurrent(snapshot: number): boolean {
    return snapshot === this.generation;
  }
}
```

### 3. `audio-server.ts` 加 `onConnection` 回调

`AudioServerOptions` 增加可选 `onConnection?: () => void`；`handleConnection` 在新连接建立时调用它：

```ts
private handleConnection(ws: WebSocket): void {
  this.opts.onConnection?.();
  const vad = new VadSegmenter(this.opts.vad);
  // ...（其余不变）
}
```

### 4. `session.ts` 接线 generation 门控

`main()` 内创建 `gate`，`onConnection` 递增 generation，`onUtterance` 转写前快照、转写后校验，过期整句丢弃：

```ts
const gate = new UtteranceGate();
audioServer = new AudioServer({
  port: audioPort,
  vad: { sampleRate: 16000, speechThreshold: 60, silenceMs: 1000, preRollMs: 400 },
  onConnection: () => gate.markNewRecording(),
  onUtterance: async (pcm, sampleRate) => {
    const snap = gate.snapshot();
    try {
      const text = await transcribe(pcm, sampleRate);
      if (!gate.isCurrent(snap)) {
        console.log('[session] dropping stale utterance (re-recorded)');
        return;
      }
      console.log(`[session] STT: ${text}`);
      await wsClient.sendEvent(userInputEvent(sessionId, text || '（未识别到语音）'));
      if (text) {
        await bridge.handleUserAction({ type: 'user_message', text });
      }
    } catch (err) {
      console.error('[session] STT failed:', err instanceof Error ? err.message : err);
      await wsClient.sendEvent(userInputEvent(sessionId, '（语音识别失败）'));
    }
  },
});
```

效果：重录时新连接 → `markNewRecording()` → generation 递增 → 旧句转写完成后 `isCurrent` 为 false → 整句丢弃（既不回显 `user_input` 到眼镜，也不 `handleUserAction` 送 Claude）。眼镜端 `VoiceResultGate` 因此只会收到最新一句，显示不再乱。

## 已知限制

- **纯取消（双击后不重录）时**，正在转写的旧句仍会送进 Claude：服务端只在**新录音出现**（新连接）时作废旧句；纯取消不产生新连接、不递增 generation。这是 voice-exit 已知限制的延续，本次不扩协议加「取消」信号。显示层面仍由眼镜 `VoiceResultGate.cancel()` 压住，只是 Agent 侧仍会处理。
- **取消后立即重录**：重录开新连接 → generation 递增 → 旧句作废，已覆盖。

## 测试策略

- **单测**（agent-adapter）：`UtteranceGate` 3 用例覆盖「未重录时快照有效 / 重录后旧快照失效 / 重录后新快照有效」。
- **编译门禁**：agent-adapter `npm test`（含 `tsc` 构建）；眼镜 `./gradlew assembleDebug`。
- **真机 E2E**：三个场景（识别中单击重录 / 聆听中单击重录 / 重录后只有最新句被处理）+ 审批回归。

## 非目标

- 不在协议层为语音结果加会话/序号关联。
- 不动 VAD 参数、STT 常驻模型、TTS。
- 不加「取消」信号（纯取消仍受已知限制约束）。
