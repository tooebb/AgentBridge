# 语音「重录取最新」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「聆听中/识别中」单击可靠重新录音，且只有最新一句语音被处理（旧句丢弃）。

**Architecture:** 眼镜端 `toggleVoice()` 收敛成「单击=重录」；PC 端 `agent-adapter` 加 `UtteranceGate` generation 门控，转写完成时丢弃过期句。

**Tech Stack:** Kotlin（Compose）+ TypeScript（agent-adapter，node:test）。生产改动：`MainViewModel.kt`、`audio-server.ts`、`session.ts`、新增 `utterance-gate.ts` + 单测。

## Global Constraints

- 不改 Core 协议、不改 AgentBridgeClient 消息协议、不改 `VoiceCapture.kt`、审批链路不变。
- agent-adapter 单测用 node:test（`npm test` 已含 `tsc` 构建 + `node --test`）；眼镜单测用纯 JUnit（本计划 Task 3 无独立 JVM 单测，正确性靠 Task 1 单测 + 编译 + Task 4 E2E 覆盖）。
- 编译环境（跑 gradle 前 export）：

```bash
export JAVA_HOME="/c/Users/_/.gradle/jdks/eclipse_adoptium-21-amd64-windows.2"
export ANDROID_HOME="/c/Users/_/AppData/Local/Android/Sdk"
```

---

## Task 1: 新增纯类 `UtteranceGate`（TDD，agent-adapter）

**Files:**
- Create: `agent-adapter/src/utterance-gate.ts`
- Test: `agent-adapter/src/__tests__/utterance-gate.test.ts`
- Modify: `agent-adapter/package.json`（把新测试文件加进 `test` 脚本）

**Interfaces:**
- Consumes: 无（独立纯类）。
- Produces: `class UtteranceGate`，方法 `markNewRecording(): void` / `snapshot(): number` / `isCurrent(snapshot: number): boolean`。

- [ ] **Step 1: 写失败测试**

`agent-adapter/src/__tests__/utterance-gate.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceGate } from '../utterance-gate.js';

test('snapshot is current before any new recording', () => {
  const gate = new UtteranceGate();
  const snap = gate.snapshot();
  assert.equal(gate.isCurrent(snap), true);
});

test('markNewRecording invalidates a prior snapshot', () => {
  const gate = new UtteranceGate();
  const snap = gate.snapshot();
  gate.markNewRecording();
  assert.equal(gate.isCurrent(snap), false);
});

test('a snapshot after markNewRecording is current', () => {
  const gate = new UtteranceGate();
  gate.markNewRecording();
  const snap = gate.snapshot();
  assert.equal(gate.isCurrent(snap), true);
});
```

- [ ] **Step 2: 把新测试加入 `test` 脚本**

`agent-adapter/package.json` 的 `test` 脚本末尾追加 `dist/__tests__/utterance-gate.test.js`。改后：

```json
"test": "npm run build && node --test dist/__tests__/risk.test.js dist/__tests__/claude.test.js dist/__tests__/hub.test.js dist/__tests__/normalizer.test.js dist/__tests__/relay.test.js dist/__tests__/approval-relay.test.js dist/__tests__/summary-relay.test.js dist/__tests__/summarize.test.js dist/__tests__/session.test.js dist/__tests__/audio-server.test.js dist/__tests__/stt.test.js dist/__tests__/session-resolver.test.js dist/__tests__/utterance-gate.test.js",
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd "D:\project\5project\AgentBridge-master\agent-adapter"
npm test
```

Expected: `tsc` 编译报错 `Cannot find module '../utterance-gate.js'`（或运行时报 module not found）。

- [ ] **Step 4: 写最小实现**

`agent-adapter/src/utterance-gate.ts`：

```ts
export class UtteranceGate {
  private generation = 0;

  markNewRecording(): void {
    this.generation++;
  }

  snapshot(): number {
    return this.generation;
  }

  isCurrent(snapshot: number): boolean {
    return snapshot === this.generation;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npm test
```

Expected: 全部测试通过（含新 3 个用例）。

- [ ] **Step 6: 提交**

```bash
git add agent-adapter/src/utterance-gate.ts \
        agent-adapter/src/__tests__/utterance-gate.test.ts \
        agent-adapter/package.json
git commit -m "feat: 新增 UtteranceGate 作废过期语音转写（TDD）"
```

---

## Task 2: 接线到 `audio-server.ts` + `session.ts`

**Files:**
- Modify: `agent-adapter/src/audio-server.ts`
- Modify: `agent-adapter/src/session.ts`

**Interfaces:**
- Consumes: `UtteranceGate`（Task 1）。
- Produces: 新音频连接触发 generation 递增；`onUtterance` 转写后校验 generation，过期丢弃。

- [ ] **Step 1: `audio-server.ts` 加 `onConnection` 回调**

`AudioServerOptions`（约第 85–89 行）加字段：

```ts
export interface AudioServerOptions {
  port: number;
  vad: VadOptions;
  onUtterance: (pcm: Buffer, sampleRate: number) => void | Promise<void>;
  onConnection?: () => void;
}
```

`handleConnection`（约第 120–122 行）首行调用它：

```ts
private handleConnection(ws: WebSocket): void {
  this.opts.onConnection?.();
  const vad = new VadSegmenter(this.opts.vad);
  // ...（其余不变）
}
```

- [ ] **Step 2: `session.ts` 接线 generation 门控**

顶部 import 加：

```ts
import { UtteranceGate } from './utterance-gate.js';
```

`main()` 内（约第 130 行 `const audioPort` 之后）加 gate，并把 `AudioServer` 构造改成（原第 132–149 行的 `onUtterance` 整体替换）：

```ts
const gate = new UtteranceGate();
if (audioPort > 0) {
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
  await audioServer.start();
  console.log(`[session] audio server listening on :${audioPort}`);
}
```

> 注意：`onConnection`/`onUtterance` 都闭包引用同一个 `gate`；`snapshot()` 在 `onUtterance` 同步段（首个 `await` 前）执行，早于任何后续重录。

- [ ] **Step 3: 编译 + 测试验证**

```bash
cd "D:\project\5project\AgentBridge-master\agent-adapter"
npm test
```

Expected: `tsc` 构建成功 + 全部测试通过。

- [ ] **Step 4: 提交**

```bash
git add agent-adapter/src/audio-server.ts agent-adapter/src/session.ts
git commit -m "feat: 音频服务按连接作废过期语音转写，只保留最新一句"
```

---

## Task 3: 改 `MainViewModel.toggleVoice()`（眼镜端）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`

**Interfaces:**
- Consumes: 无新增（复用现有 `VoiceCapture`/`VoiceResultGate`）。
- Produces: `toggleVoice()` 单击 = 永远重录（停旧 + 开新）。

> 本任务无独立 JVM 单测（MainViewModel 依赖 Android 组件，模块无 Robolectric）。正确性由 Task 1 单测 + 本任务编译 + Task 4 E2E 覆盖。

- [ ] **Step 1: 替换 `toggleVoice()` 方法体**

把当前 `toggleVoice()`（约第 442–471 行）：

```kotlin
    fun toggleVoice() {
        val current = voiceCapture
        if (current != null && current.state == VoiceCaptureState.RECORDING) {
            current.stop()
            _capsFromClient.value = "VOICE: stopped"
            return
        }

        val host = discoveredHost
        if (host.isNullOrBlank()) {
            _capsFromClient.value = "VOICE: no discovered PC host"
            return
        }

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

改成：

```kotlin
    fun toggleVoice() {
        val host = discoveredHost
        if (host.isNullOrBlank()) {
            _capsFromClient.value = "VOICE: no discovered PC host"
            return
        }

        voiceCapture?.stop()
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

（`VoiceCaptureState` import 仍被 `onState` 回调使用，保留不动。）

- [ ] **Step 2: 编译验证**

```bash
cd "D:\project\5project\AgentBridge-master\rokid-sdk\cxrssample\cxrswithcxrl"
./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`。APK 输出 `app/build/outputs/apk/debug/app-debug.apk`。

- [ ] **Step 3: 提交**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt
git commit -m "feat: 聆听中/识别中单击改为重新录音"
```

---

## Task 4: 真机 E2E 验证（手动，需眼镜 + 手机 + PC）

**Files:** 无（验证 Task 2 + 3 的行为）。

**前置**：把 Task 3 编译出的 `app-debug.apk` 按 `adb_build_workflow` 走手机 CXR-L SDK 安装到眼镜；PC 端重启 `agent-adapter` 的 session daemon（`start:session`）加载新 `session.js`。Core 与 STT 服务保持运行。

- [ ] **Step 1: 场景 A —— 识别中单击重录**

单击 → 说一句 → 观察「聆听中 → 识别中」→ 识别中**单击** → 立即回到「聆听中」，可再次说话，且只显示最新一句结果。

- [ ] **Step 2: 场景 B —— 聆听中单击重录**

单击 → 正在说话时**单击** → 可靠回到「聆听中」（不再时停时录），旧句作废，新句正常显示。

- [ ] **Step 3: 场景 C —— 只有最新一句被处理**

说第一句后立刻重录第二句 → Agent 只按第二句响应，第一句不再出现（无旧卡片、无重复回答）。

- [ ] **Step 4: 回归 —— 审批链路不受影响**

触发一次高风险工具 → 眼镜出现审批卡片 → 单击 approve / 双击 reject 行为与之前一致。

> 若真机不在手边，本任务可延后；Task 1–3 代码已可安全提交。

---

## 测试策略小结

- **单元测试**（Task 1）：`UtteranceGate` 3 用例覆盖快照有效/重录作废/重录后有效。
- **编译门禁**（Task 2、3）：agent-adapter `npm test`（含 tsc）；眼镜 `assembleDebug`。
- **真机 E2E**（Task 4）：三个重录场景 + 审批回归。

## 非目标

- 不加协议层会话关联、不加「取消」信号、不动 VAD/STT/TTS。
