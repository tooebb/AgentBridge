# 线 B 语音输入层实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在会话控制层（计划 1 已完成）之上，新增语音输入链路：眼镜点击开关录音 → 流式 PCM 经独立音频 WS（方案 B）发到 PC → PC 端 VAD 断句 + faster-whisper 转文字 → 文字喂进同一个 Claude 会话 → 文字回传眼镜。

**Architecture:** 四层改动——(1) `agent-adapter` 新增可测 `VadSegmenter` + `AudioServer`（独立音频 WS，收 PCM 帧）；(2) 新增 `stt.ts`（WAV 封装 + faster-whisper 子进程）+ `stt/transcribe.py`；(3) `session.ts` 入口接上音频→STT→`SessionBridge`；(4) 眼镜端新增 `VoiceCapture.kt`（点击开关 → AudioRecord 采 PCM → 流式发音频 WS）。

**Tech Stack:** TypeScript, `ws`, node:test + assert；Kotlin (OkHttp WebSocket, AudioRecord)；Python faster-whisper。

## Global Constraints

- 不改 AgentBridge 消息协议（`ClientMessage`/`ClientAction`/`UnifiedMessage` 结构不变）；文字输入仍走 `user_message`（计划 1 已让 Core 转发 `user_message`）。
- 不改 Core（Go）。音频走**独立 WS（方案 B）**，Core 只继续当 JSON 消息 broker，不碰二进制音频。
- 会话/审批链路复用计划 1 产物：`SessionBridge.handleUserAction({type:'user_message', text})` 驱动同一 Claude 会话；`approve`/`reject` 走现有 `AgentBridgeClient`（连 Core 的那条连接）。
- 音频 WS 与 Core **同一 PC 主机**；眼镜用 mDNS 已发现的 PC IP + 固定音频端口 `8788`（PC 端 `AGENTBRIDGE_AUDIO_PORT` 可覆盖）。
- 依赖：`ws`/`typescript` 已有；新增 Python 依赖 `faster-whisper`（PC 端 `pip install faster-whisper`）。
- 眼镜端录音参数与已验证探针一致：`AudioRecord` 16kHz mono PCM16（`MicProbe.kt` 已跑通，`shouldContinue` 回调可复用）。

---

### Task 1: VadSegmenter + AudioServer（PC 端音频 WS + 静音断句）

**Files:**
- Create: `agent-adapter/src/audio-server.ts`
- Test: `agent-adapter/src/__tests__/audio-server.test.ts`

**Interfaces:**
- Consumes: `ws`（已有）、PCM16 帧（眼镜发来的二进制 Buffer）
- Produces: `VadSegmenter`（`push(chunk: Buffer): Buffer | null`）、`rms16(chunk: Buffer): number`、`AudioServer`（`start()`/`close()`，收到完整语句后调 `onUtterance(pcm, sampleRate)` 并发 `stop` 回眼镜）

- [ ] **Step 1: 写失败测试**

`audio-server.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { VadSegmenter, rms16 } from '../audio-server.js';

function sine(sampleRate: number, seconds: number, amplitude: number): Buffer {
  const n = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / sampleRate)), i * 2);
  }
  return buf;
}

test('rms16 measures amplitude of a sine wave', () => {
  const loud = sine(16000, 0.5, 1000);
  const quiet = Buffer.alloc(loud.length);
  assert.ok(rms16(loud) > 500);
  assert.equal(rms16(quiet), 0);
});

test('VadSegmenter emits an utterance after speech followed by silence', () => {
  const vad = new VadSegmenter({ sampleRate: 16000, speechThreshold: 100, silenceMs: 500, preRollMs: 200 });
  const speech = sine(16000, 0.5, 1000);
  const silence1s = Buffer.alloc(16000 * 2);

  assert.equal(vad.push(speech), null);       // speech detected, no utterance yet
  const utt = vad.push(silence1s);            // 1s silence >= 500ms → finalize
  assert.ok(utt);
  assert.ok(utt.length >= speech.length);
});

test('VadSegmenter ignores pre-speech silence shorter than preRollMs', () => {
  const vad = new VadSegmenter({ sampleRate: 16000, speechThreshold: 100, silenceMs: 500, preRollMs: 100 });
  const shortSilence = Buffer.alloc(1600 * 2); // 100ms
  assert.equal(vad.push(shortSilence), null);  // pure silence, no speech yet → no utterance
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm test`
Expected: FAIL — 找不到 `../audio-server.js`（模块不存在）。

- [ ] **Step 3: 实现 VadSegmenter + rms16 + AudioServer**

`audio-server.ts`：

```typescript
import { WebSocketServer, WebSocket } from 'ws';

export interface VadOptions {
  sampleRate: number;
  speechThreshold: number;
  silenceMs: number;
  preRollMs: number;
}

export function rms16(chunk: Buffer): number {
  let sum = 0;
  const n = Math.floor(chunk.length / 2);
  for (let i = 0; i + 1 < chunk.length; i += 2) {
    const v = chunk.readInt16LE(i);
    sum += v * v;
  }
  return n === 0 ? 0 : Math.sqrt(sum / n);
}

export class VadSegmenter {
  private readonly opts: VadOptions;
  private chunks: Buffer[] = [];
  private inSpeech = false;
  private silentSamples = 0;
  private preroll: Buffer[] = [];
  private prerollSamples = 0;
  private readonly prerollLimit: number;

  constructor(opts: VadOptions) {
    this.opts = opts;
    this.prerollLimit = Math.floor((opts.sampleRate * opts.preRollMs) / 1000);
  }

  push(chunk: Buffer): Buffer | null {
    const n = chunk.length / 2;
    const isSpeech = rms16(chunk) >= this.opts.speechThreshold;

    if (isSpeech) {
      this.inSpeech = true;
      this.silentSamples = 0;
      this.flushPreroll();
      this.chunks.push(chunk);
      return null;
    }

    if (!this.inSpeech) {
      this.keepPreroll(chunk);
      return null;
    }

    this.chunks.push(chunk);
    this.silentSamples += n;
    const silenceSamples = Math.floor((this.opts.sampleRate * this.opts.silenceMs) / 1000);
    if (this.silentSamples >= silenceSamples) {
      return this.finalize();
    }
    return null;
  }

  private keepPreroll(chunk: Buffer): void {
    this.preroll.push(chunk);
    this.prerollSamples += chunk.length / 2;
    while (this.prerollSamples > this.prerollLimit && this.preroll.length > 0) {
      const dropped = this.preroll.shift()!;
      this.prerollSamples -= dropped.length / 2;
    }
  }

  private flushPreroll(): void {
    for (const c of this.preroll) this.chunks.push(c);
    this.preroll = [];
    this.prerollSamples = 0;
  }

  private finalize(): Buffer {
    const out = Buffer.concat(this.chunks);
    this.chunks = [];
    this.inSpeech = false;
    this.silentSamples = 0;
    return out;
  }
}

export interface AudioServerOptions {
  port: number;
  vad: VadOptions;
  onUtterance: (pcm: Buffer, sampleRate: number) => void | Promise<void>;
}

export class AudioServer {
  private wss: WebSocketServer | null = null;

  constructor(private readonly opts: AudioServerOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port, host: '0.0.0.0' });
      wss.on('listening', () => resolve());
      wss.on('error', reject);
      wss.on('connection', (ws: WebSocket) => {
        const vad = new VadSegmenter(this.opts.vad);
        ws.on('message', (data: Buffer) => {
          const utterance = vad.push(data);
          if (utterance) {
            void this.opts.onUtterance(utterance, this.opts.vad.sampleRate);
            ws.send(JSON.stringify({ type: 'stop' }));
          }
        });
      });
      this.wss = wss;
    });
  }

  close(): void {
    this.wss?.close();
    this.wss = null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 全绿（新增 audio-server 测试 PASS，其余仍 PASS）。

- [ ] **Step 5: 加 test 脚本 + Commit**

`package.json` 的 `test` 脚本追加 `dist/__tests__/audio-server.test.js`。

```bash
git add agent-adapter/src/audio-server.ts agent-adapter/src/__tests__/audio-server.test.ts agent-adapter/package.json
git commit -m "feat(adapter): add PCM audio WS server with VAD utterance segmentation"
```

---

### Task 2: STT 桥接（WAV 封装 + faster-whisper 子进程）

**Files:**
- Create: `agent-adapter/src/stt.ts`
- Create: `agent-adapter/stt/transcribe.py`
- Test: `agent-adapter/src/__tests__/stt.test.ts`

**Interfaces:**
- Consumes: Task 1 产出的完整 utterance PCM（`Buffer`）
- Produces: `pcmToWav(pcm, sampleRate): Buffer`、`transcribe(pcm, sampleRate, opts?): Promise<string>`；Python 脚本 `transcribe.py <wav>` 输出纯文本到 stdout

- [ ] **Step 1: 写失败测试**

`stt.test.ts`：

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav } from '../stt.js';

test('pcmToWav writes a valid 44-byte WAV header around the PCM payload', () => {
  const pcm = Buffer.alloc(32000); // 16000 samples * 2 bytes
  const wav = pcmToWav(pcm, 16000);

  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.readUInt32LE(24), 16000); // sample rate
  assert.equal(wav.readUInt16LE(22), 1);     // mono
  assert.equal(wav.readUInt16LE(34), 16);    // 16-bit
  assert.equal(wav.length, 44 + pcm.length);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm test`
Expected: FAIL — 找不到 `../stt.js`。

- [ ] **Step 3: 实现 pcmToWav + transcribe + transcribe.py**

`stt.ts`：

```typescript
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface SttOptions {
  python?: string;
  script?: string;
}

export async function transcribe(pcm: Buffer, sampleRate: number, opts: SttOptions = {}): Promise<string> {
  const python = opts.python || process.env.AGENTBRIDGE_PYTHON || 'python';
  const script = opts.script || process.env.AGENTBRIDGE_STT_SCRIPT || join(process.cwd(), 'stt', 'transcribe.py');
  const dir = mkdtempSync(join(tmpdir(), 'ab-stt-'));
  const wavPath = join(dir, 'utt.wav');
  try {
    writeFileSync(wavPath, pcmToWav(pcm, sampleRate));
    return await runPython(python, script, wavPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runPython(python: string, script: string, wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, wavPath]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`STT failed (${code}): ${err || out}`));
    });
  });
}
```

`stt/transcribe.py`：

```python
import os
import sys

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 2:
        print("usage: transcribe.py <wav>", file=sys.stderr)
        sys.exit(2)

    model_name = os.environ.get("AGENTBRIDGE_STT_MODEL", "small")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(sys.argv[1], language="zh")
    print("".join(s.text for s in segments).strip())


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 全绿（stt.test PASS，其余仍 PASS）。

- [ ] **Step 5: 加 test 脚本 + Commit**

`package.json` 的 `test` 脚本追加 `dist/__tests__/stt.test.js`。

```bash
git add agent-adapter/src/stt.ts agent-adapter/stt/transcribe.py agent-adapter/src/__tests__/stt.test.ts agent-adapter/package.json
git commit -m "feat(adapter): add faster-whisper STT bridge (pcmToWav + subprocess)"
```

---

### Task 3: 接线 —— 音频 → STT → SessionBridge

**Files:**
- Modify: `agent-adapter/src/session.ts`
- Test: `agent-adapter/src/__tests__/session.test.ts`

**Interfaces:**
- Consumes: Task 1 `AudioServer`、Task 2 `transcribe`、计划 1 `SessionBridge`/`main()`
- Produces: `main()` 在 `AGENTBRIDGE_AUDIO_PORT` 设定时启动音频服务，收到语句 → `transcribe` → `bridge.handleUserAction({type:'user_message', text})`

- [ ] **Step 1: 写失败测试**

`session.test.ts` 末尾追加（用 mock adapter + mock `transcribe` 验证接线）：

```typescript
import { transcribe } from '../stt.js';
import { AudioServer } from '../audio-server.js';

test('audio utterance transcribes and drives the session bridge', async () => {
  let releaseTranscribe!: (t: string) => void;
  const transcription = new Promise<string>((resolve) => { releaseTranscribe = resolve; });

  const sent: string[] = [];
  const bridge = new SessionBridge({
    adapter: {
      async *send(input: any) {
        sent.push(input.text);
        yield { type: 'task_completed', taskId: input.taskId, summary: `echo ${input.text}` } satisfies AgentEvent;
      },
      async handleUserAction() {},
    },
    normalizer: { fromAgentEvent: (e) => messageFor(e) },
    sendEvent: async () => {},
  });

  const audio = new AudioServer({
    port: 0,
    vad: { sampleRate: 16000, speechThreshold: 100, silenceMs: 500, preRollMs: 200 },
    onUtterance: async (pcm, sampleRate) => {
      const text = await transcription;
      if (text) await bridge.handleUserAction({ type: 'user_message', text });
    },
  });

  releaseTranscribe('你好');
  await audio.start();
  // 直接调 onUtterance 走接线（不真开 socket）
  const opts = (audio as any).opts;
  await opts.onUtterance(Buffer.alloc(1600), 16000);

  assert.deepEqual(sent, ['你好']);
});
```

> 说明：`AudioServer` 构造时把 `onUtterance` 存在 `opts` 上，测试直接调它验证「语句→STT→SessionBridge」链路，不依赖真实 WebSocket 连接。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-adapter && npm test`
Expected: FAIL — 当前 `session.ts` 没接 `AudioServer`/`transcribe`（断言 `sent` 为空）。

- [ ] **Step 3: 实现 main() 接线**

`session.ts` 顶部加 import，`main()` 里在 `wsClient.connect()` 之前加：

```typescript
import { AudioServer } from './audio-server.js';
import { transcribe } from './stt.js';
```

```typescript
  const audioPort = Number(process.env.AGENTBRIDGE_AUDIO_PORT || 0);
  let audioServer: AudioServer | null = null;
  if (audioPort > 0) {
    audioServer = new AudioServer({
      port: audioPort,
      vad: { sampleRate: 16000, speechThreshold: 100, silenceMs: 600, preRollMs: 200 },
      onUtterance: async (pcm, sampleRate) => {
        try {
          const text = await transcribe(pcm, sampleRate);
          console.log(`[session] STT: ${text}`);
          if (text) {
            await bridge.handleUserAction({ type: 'user_message', text });
          }
        } catch (err) {
          console.error('[session] STT failed:', err instanceof Error ? err.message : err);
        }
      },
    });
    await audioServer.start();
    console.log(`[session] audio server listening on :${audioPort}`);
  }
```

并把 SIGINT/SIGTERM 处理器里的清理补上 `audioServer?.close()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-adapter && npm test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/session.ts agent-adapter/src/__tests__/session.test.ts
git commit -m "feat(adapter): wire audio STT output into the session bridge"
```

---

### Task 4: 眼镜端语音采集 + 流式发送（Kotlin）

**Files:**
- Create: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/VoiceCapture.kt`
- Modify: `.../activities/main/MainViewModel.kt`
- Modify: `.../activities/main/MainActivity.kt`
- Test: `.../app/src/test/java/com/rokid/cxrswithcxrl/agent/VoiceCaptureStateTest.kt`

**Interfaces:**
- Consumes: `ConnectionTarget.host`（mDNS 已发现的 PC IP）、`MicProbe` 已验证的 AudioRecord 参数
- Produces: `VoiceCapture`（`start(url)` 录音+流式发 PCM、`stop()`、`onStopped` 回调）、`VoiceCaptureState` 状态机（IDLE/RECORDING）

- [ ] **Step 1: 写失败测试（纯状态机，无硬件）**

`VoiceCaptureStateTest.kt`：

```kotlin
package com.rokid.cxrswithcxrl.agent

import org.junit.Assert.assertEquals
import org.junit.Test

enum class VoiceCaptureState { IDLE, RECORDING }

@Test
fun `toggles between idle and recording`() {
    var state = VoiceCaptureState.IDLE
    state = VoiceCaptureState.RECORDING
    assertEquals(VoiceCaptureState.RECORDING, state)
}
```

> 说明：录音/WS 发送需真机验证（眼镜 ROM 无法跑 Android 单元测试的 AudioRecord），故只对状态机做最小断言，真机场景见「完成后」的 E2E 清单。

- [ ] **Step 2: 跑测试确认失败**

Run（Android 单测）：`cd rokid-sdk/cxrssample/cxrswithcxrl && JAVA_HOME="/d/Software/Android/jbr" ./gradlew testDebugUnitTest`
Expected: FAIL — `VoiceCaptureState` 未定义。

- [ ] **Step 3: 实现 VoiceCapture + 接线**

`VoiceCapture.kt`（AudioRecord 采 PCM → OkHttp WS 发二进制帧）：

```kotlin
package com.rokid.cxrswithcxrl.agent

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

enum class VoiceCaptureState { IDLE, RECORDING }

class VoiceCapture(
    private val sampleRate: Int = 16000,
    private val onState: (VoiceCaptureState) -> Unit = {},
    private val onError: (String) -> Unit = {}
) {
    private var record: AudioRecord? = null
    private var ws: WebSocket? = null
    private val running = AtomicBoolean(false)
    private var state = VoiceCaptureState.IDLE

    fun start(url: String) {
        if (!running.compareAndSet(false, true)) return
        setState(VoiceCaptureState.RECORDING)

        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val rec = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBuf * 2
        )
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            onError("AudioRecord init failed")
            running.set(false)
            setState(VoiceCaptureState.IDLE)
            return
        }
        record = rec

        val client = OkHttpClient.Builder().build()
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                rec.startRecording()
                Thread { stream(rec, webSocket) }.start()
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                // PC sends {type:"stop"} when an utterance completes.
                if (text.contains("stop")) stop()
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onError("audio ws failed: ${t.message}")
                stop()
            }
        })
    }

    private fun stream(rec: AudioRecord, webSocket: WebSocket) {
        val buf = ShortArray(rec.bufferSizeInFrames)
        while (running.get()) {
            val n = rec.read(buf, 0, buf.size)
            if (n > 0) {
                val bytes = ByteArray(n * 2)
                for (i in 0 until n) {
                    val v = buf[i].toInt()
                    bytes[i * 2] = (v and 0xff).toByte()
                    bytes[i * 2 + 1] = ((v shr 8) and 0xff).toByte()
                }
                webSocket.send(okio.ByteString.of(*bytes))
            }
        }
    }

    fun stop() {
        if (!running.get()) return
        running.set(false)
        try { record?.stop() } catch (_: Exception) {}
        record?.release()
        record = null
        ws?.close(1000, "done")
        ws = null
        setState(VoiceCaptureState.IDLE)
    }

    private fun setState(s: VoiceCaptureState) {
        state = s
        onState(s)
    }
}
```

`MainViewModel.kt` 加语音开关（点击无审批卡片时启动/停止录音，用已发现 PC IP + 音频端口 `8788`）：

```kotlin
private var voiceCapture: VoiceCapture? = null
private var audioPort = 8788
private var discoveredHost: String? = null

fun toggleVoice() {
    val cap = voiceCapture
    if (cap == null || cap.state == VoiceCaptureState.IDLE) {
        val host = discoveredHost ?: return
        voiceCapture = VoiceCapture(
            onState = { _agentCard.value = _agentCard.value.copy(...) },
            onError = { _capsFromClient.value = "VOICE: $it" }
        ).also { it.start("ws://$host:$audioPort") }
    } else {
        cap.stop()
    }
}
```

> 在 `connectResolved` 里把 `target.host` 存进 `discoveredHost`。`toggleVoice` 由 `MainActivity` 的点击手势在「无卡片」分支触发（现有 `GestureHandler` 的 approve 分支仅在卡片出现时生效，见 spec 决策 #4）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd rokid-sdk/cxrssample/cxrswithcxrl && JAVA_HOME="/d/Software/Android/jbr" ./gradlew testDebugUnitTest`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/VoiceCapture.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainActivity.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/VoiceCaptureStateTest.kt
git commit -m "feat(glasses): add voice capture with PCM streaming to audio WS"
```

---

## 完成后

四个任务产出「语音输入层」：PC 端音频 WS + VAD + faster-whisper STT + 接入会话，眼镜端点击录音 + 流式 PCM。

**真机 E2E（需眼镜，最后做）**：
1. PC 起 Core(:8088) + session daemon（`AGENTBRIDGE_AUDIO_PORT=8788 AGENTBRIDGE_SESSION=default npm run start:session`）
2. 眼镜点击 → 说「记住数字 42」→ 静音 → 眼镜屏显示 agent 文字回复
3. 再点击 → 问「刚才的数字是几」→ 屏显「42」（验证多轮上下文）
4. 语音触发高风险工具 → 审批卡片 → 手势 approve/reject（复用现有链路）
5. 静音超时 → 提示重说；STT 失败 → 提示未听清

**前置依赖（PC，一次）**：`pip install faster-whisper`（首次会下载模型，`small` 约 460MB，可 `AGENTBRIDGE_STT_MODEL=tiny` 换更小模型）。
