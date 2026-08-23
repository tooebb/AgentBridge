# 线 B 语音 UX 修复与增强 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修三件事——STT 延迟/偶发无回复、语音分阶段反馈、回复截断+view_details 失效——不改 Core 协议。

**Architecture:** 常驻 faster-whisper 模型消 15s 重载；daemon 回显 `user_input` 事件做分阶段状态；眼镜修 view_details 与正文截断。

**Tech Stack:** TypeScript (agent-adapter) / Python faster-whisper / Kotlin Compose (眼镜)。middleware-core 零改动。

## 全局约束

- middleware-core 零改动；`event_type` 仅新增使用字符串值 `"user_input"`。
- `DeviceMessage` / `UnifiedMessage` 字段不变。
- 审批链路（needs_approval → approve/reject）不触碰。
- 依赖 Core 容错：非法状态迁移只 log 不 reject（`cmd/server/main.go:138-143`）；眼镜通知 10s cooldown（`notify/engine.go:33`）会压掉中间非终结事件，属预期。

## 文件结构

| 文件 | 责任 |
|---|---|
| `agent-adapter/stt/transcribe_server.py`（新） | 常驻模型 HTTP 服务 |
| `agent-adapter/src/stt.ts` | `SttClient` 常驻调用 + 单次 fallback |
| `agent-adapter/src/session.ts` | 接线 SttClient + VAD 参数 + `user_input` 回显 |
| `agent-adapter/src/audio-server.ts` | VAD 日志 |
| `rokid-sdk/.../MainViewModel.kt` | `voiceStatus` 状态流 + `user_input` 处理 |
| `rokid-sdk/.../CardRenderer.kt` | 语音状态区 + 正文展开 |
| `rokid-sdk/.../CardStateMachine.kt` | `onViewDetails` 恒 toggle |
| `rokid-sdk/.../AgentActionHandler.kt` | auto-clear 15s |

---

### Task 1: 常驻 STT 服务（transcribe_server.py）

**Files:**
- Create: `agent-adapter/stt/transcribe_server.py`
- Test: 手动冒烟（见 Step 4）

**Interfaces:**
- Produces: HTTP 服务 `127.0.0.1:<AGENTBRIDGE_STT_PORT|8790>`，`GET /health` → 200，`POST /transcribe` 收 WAV 字节返回 UTF-8 文字；模型加载完成打印 `READY` 到 stdout。

- [ ] **Step 1: 写服务**

```python
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.stdout.reconfigure(encoding="utf-8")

from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("AGENTBRIDGE_STT_MODEL", "small")
PORT = int(os.environ.get("AGENTBRIDGE_STT_PORT", "8790"))

model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")


def transcribe_bytes(wav: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav)
        path = f.name
    try:
        segments, _info = model.transcribe(path, language="zh")
        return "".join(segment.text for segment in segments).strip()
    finally:
        os.unlink(path)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ready"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        wav = self.rfile.read(length)
        try:
            body = transcribe_bytes(wav).encode("utf-8")
            self.send_response(200)
        except Exception as e:
            body = f"ERROR: {e}".encode("utf-8")
            self.send_response(500)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("READY", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 语法检查**

Run: `python -m py_compile agent-adapter/stt/transcribe_server.py`
Expected: 无输出、退出码 0。

- [ ] **Step 3: 起服务验证 READY**

Run: `cd agent-adapter && AGENTBRIDGE_STT_PORT=8790 python stt/transcribe_server.py`
Expected: 约 15s 后 stdout 打印 `READY`（模型加载完成）。

- [ ] **Step 4: 冒烟 POST**

Run（另开终端）: `curl -s http://127.0.0.1:8790/health` → `{"status":"ready"}`；随后用任一 WAV 文件 `curl -s --data-binary @utterance.wav http://127.0.0.1:8790/transcribe` 返回中文文字。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/stt/transcribe_server.py
git commit -m "feat(stt): add persistent faster-whisper HTTP server"
```

---

### Task 2: SttClient 常驻调用 + fallback（stt.ts）

**Files:**
- Modify: `agent-adapter/src/stt.ts`
- Test: `agent-adapter/src/__tests__/stt.test.ts`（新增用例）

**Interfaces:**
- Consumes: `pcmToWav`（已有）、`transcribe_server.py`（Task 1）。
- Produces: `class SttClient { async start(): Promise<void>; async transcribe(pcm: Buffer, sampleRate: number): Promise<string>; close(): void }`；导出 `transcribe()` 保持原签名，内部懒初始化单例并 fallback。

- [ ] **Step 1: 写失败测试**

在 `agent-adapter/src/__tests__/stt.test.ts` 追加（用假 HTTP 服务）：

```typescript
import { SttClient } from '../stt.js';

test('SttClient.transcribe POSTs wav and returns text', async () => {
  // 起一个极简 http 服务返回固定文本，端口随机
  const { port, server } = await fakeSttServer('你好');
  process.env.AGENTBRIDGE_STT_PORT = String(port);
  const c = new SttClient();
  c.port = port; c.ready = true; // 绕过 spawn，直接测 HTTP 路径
  const text = await c.transcribe(Buffer.alloc(3200), 16000);
  assert.equal(text, '你好');
  server.close();
});
```

> 注：`SttClient` 需把 `port`/`ready` 设为可写字段以便注入测试；`fakeSttServer` 用 `node:http` 起临时服务返回 body 文本。

- [ ] **Step 2: 运行确认失败**

Run: `npm run build && node --test dist/__tests__/stt.test.js`
Expected: FAIL（`SttClient` 未定义）。

- [ ] **Step 3: 实现 SttClient**

在 `stt.ts` 顶部补充 `import { spawn, type ChildProcess } from 'node:child_process';`（已有 `spawn`），并新增：

```typescript
export class SttClient {
  port = Number(process.env.AGENTBRIDGE_STT_PORT || 8790);
  ready = false;
  private child: ChildProcess | null = null;
  private fallback = false;

  async start(): Promise<void> {
    const python = process.env.AGENTBRIDGE_PYTHON || 'python';
    const script = process.env.AGENTBRIDGE_STT_SERVER || join(process.cwd(), 'stt', 'transcribe_server.py');
    try {
      this.child = spawn(python, [script], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
      await this.waitReady();
      this.ready = true;
    } catch (err) {
      console.warn('[stt] persistent server failed, falling back to one-shot:', err instanceof Error ? err.message : err);
      this.fallback = true;
    }
  }

  private async waitReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`STT server not ready within ${timeoutMs}ms`);
  }

  async transcribe(pcm: Buffer, sampleRate: number): Promise<string> {
    if (this.fallback) return runPythonFallback(pcm, sampleRate);
    const wav = pcmToWav(pcm, sampleRate);
    const res = await fetch(`http://127.0.0.1:${this.port}/transcribe`, { method: 'POST', body: wav });
    if (!res.ok) throw new Error(`STT server error ${res.status}`);
    return (await res.text()).trim();
  }

  close(): void {
    this.child?.kill();
    this.child = null;
    this.ready = false;
  }
}
```

并新增单次 fallback（复用现有 `runPython`）：

```typescript
async function runPythonFallback(pcm: Buffer, sampleRate: number): Promise<string> {
  const python = process.env.AGENTBRIDGE_PYTHON || 'python';
  const script = process.env.AGENTBRIDGE_STT_SCRIPT || join(process.cwd(), 'stt', 'transcribe.py');
  const dir = mkdtempSync(join(tmpdir(), 'agentbridge-stt-'));
  const wavPath = join(dir, 'utterance.wav');
  try {
    writeFileSync(wavPath, pcmToWav(pcm, sampleRate));
    return await runPython(python, script, wavPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

把现有 `transcribe()` 导出改为单例封装：

```typescript
let sttClient: SttClient | null = null;

export async function transcribe(pcm: Buffer, sampleRate: number, opts: SttOptions = {}): Promise<string> {
  if (!sttClient) {
    sttClient = new SttClient();
    await sttClient.start();
  }
  return sttClient.transcribe(pcm, sampleRate);
}

export function closeStt(): void {
  sttClient?.close();
  sttClient = null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run build && node --test dist/__tests__/stt.test.js`
Expected: 全部 PASS（新增用例 + 既有 stt 用例）。

- [ ] **Step 5: Commit**

```bash
git add agent-adapter/src/stt.ts agent-adapter/src/__tests__/stt.test.ts
git commit -m "feat(stt): add SttClient persistent transcription with one-shot fallback"
```

---

### Task 3: VAD 参数 + 日志（audio-server.ts / session.ts）

**Files:**
- Modify: `agent-adapter/src/audio-server.ts`、`agent-adapter/src/session.ts`

**Interfaces:**
- Consumes: `VadSegmenter`（已有）。
- Produces: `handleConnection` 打印连接/语句日志；`session.ts` 的 VAD 参数改为 `{ sampleRate:16000, speechThreshold:60, silenceMs:1000, preRollMs:400 }`。

- [ ] **Step 1: 加日志**

在 `audio-server.ts` 的 `handleConnection` 顶部与 `push` 语句分支加：

```typescript
private handleConnection(ws: WebSocket): void {
  console.log('[audio] device connected');
  const vad = new VadSegmenter(this.opts.vad);
  ws.on('message', (data) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    const utterance = vad.push(chunk);
    if (!utterance) return;
    console.log(`[audio] utterance finalized: ${utterance.length} bytes (~${Math.round(utterance.length / 2 / (this.opts.vad.sampleRate / 1000))}ms)`);
    void Promise.resolve(this.opts.onUtterance(utterance, this.opts.vad.sampleRate)).catch((err) => {
      console.error('[audio] failed to handle utterance:', err instanceof Error ? err.message : err);
    });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
  });
  ws.on('close', () => console.log('[audio] device disconnected'));
}
```

- [ ] **Step 2: 改 VAD 参数**

在 `session.ts` 的 `AudioServer` 构造处，把 `vad` 改为：

```typescript
vad: { sampleRate: 16000, speechThreshold: 60, silenceMs: 1000, preRollMs: 400 },
```

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add agent-adapter/src/audio-server.ts agent-adapter/src/session.ts
git commit -m "feat(audio): relax VAD thresholds and add utterance logging"
```

---

### Task 4: user_input 回显（session.ts）

**Files:**
- Modify: `agent-adapter/src/session.ts`

**Interfaces:**
- Consumes: `wsClient.sendEvent(msg: UnifiedMessage)`（已有，`bridge.forward` 在用）。
- Produces: `userInputEvent(sessionId, text): UnifiedMessage`（`event_type:"user_input"`）。

- [ ] **Step 1: 写事件构造 + 接线**

在 `session.ts` 加：

```typescript
function userInputEvent(sessionId: string, text: string): UnifiedMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    task_id: sessionId,
    session_id: sessionId,
    event_type: 'user_input',
    title: '语音输入',
    body: text,
    severity: 'info',
    risk_score: 0,
    risk_blocked: false,
    available_actions: [],
    timestamp: new Date().toISOString(),
    agent_id: 'claude-cli',
  };
}
```

`main()` 里把 `onUtterance` 改为：

```typescript
onUtterance: async (pcm, sampleRate) => {
  try {
    const text = await transcribe(pcm, sampleRate);
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
```

> 注意：`sessionId` 变量在 `main()` 中已存在（`const sessionId = ...`），直接使用。

- [ ] **Step 2: shutdown 收尾常驻进程**

`session.ts` 顶部把 `import { transcribe } from './stt.js';` 改为 `import { transcribe, closeStt } from './stt.js';`，并在 `shutdown` 里加：

```typescript
const shutdown = async () => {
  audioServer?.close();
  await bridge.close();
  wsClient.close();
  closeStt();
  process.exit(0);
};
```

- [ ] **Step 3: 编译**

Run: `npm run build`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add agent-adapter/src/session.ts
git commit -m "feat(session): echo user_input event with recognized text"
```

---

### Task 5: 眼镜 voiceStatus 状态流（MainViewModel.kt）

**Files:**
- Modify: `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt`

**Interfaces:**
- Produces: `val voiceStatus: StateFlow<String>`；`onState` 映射 RECORDING→"聆听中…"、IDLE→"识别中…"；`onMessage` 处理 `user_input`/`task_completed`/`task_failed`/`needs_approval`。

- [ ] **Step 1: 加状态流**

在 `_capsFromClient` 附近加：

```kotlin
private val _voiceStatus = MutableStateFlow("")
val voiceStatus = _voiceStatus.asStateFlow()
```

- [ ] **Step 2: toggleVoice 映射**

`toggleVoice()` 里的 `VoiceCapture(onState = ...)` 改为：

```kotlin
onState = { state ->
    _capsFromClient.value = "VOICE: ${state.name.lowercase()}"
    _voiceStatus.value = when (state) {
        VoiceCaptureState.RECORDING -> "聆听中…"
        VoiceCaptureState.IDLE -> "识别中…"
    }
},
```

- [ ] **Step 3: onMessage 处理 user_input**

`AgentBridgeClient.Listener.onMessage` 开头加：

```kotlin
override fun onMessage(message: DeviceMessage, duplicate: Boolean) {
    when (message.event?.eventType) {
        "user_input" -> _voiceStatus.value = "已识别: ${message.event?.body.orEmpty()}（处理中…）"
        "task_completed", "task_failed", "needs_approval" -> _voiceStatus.value = ""
    }
    _agentCard.value = handler.reduce(message, duplicate)
    _debugStatus.value = debugText(
        if (duplicate) "duplicate ignored"
        else "event=${message.event?.eventType ?: "unknown"} seq=${message.seq}"
    )
}
```

- [ ] **Step 4: 编译 APK 验证**

Run: 按项目既有流程 `gradlew assembleDebug`（JAVA_HOME 指向 Gradle JDK）。
Expected: BUILD SUCCESSFUL。

- [ ] **Step 5: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainViewModel.kt
git commit -m "feat(glasses): add voiceStatus state flow for staged voice feedback"
```

---

### Task 6: 眼镜语音状态区渲染（CardRenderer.kt）

**Files:**
- Modify: `rokid-sdk/.../agent/CardRenderer.kt`、`rokid-sdk/.../activities/main/MainActivity.kt`

**Interfaces:**
- Consumes: `MainViewModel.voiceStatus`。
- Produces: `AgentBridgeScreen(card, capsFromClient, debugStatus, voiceStatus)` 新增参数并渲染。

- [ ] **Step 1: 加参数渲染**

`AgentBridgeScreen` 签名加 `voiceStatus: String = ""`，在 `ConnectionHeader(card)` 之后插入：

```kotlin
if (voiceStatus.isNotBlank()) {
    Spacer(modifier = Modifier.height(8.dp))
    Text(
        text = voiceStatus,
        color = Color(0xFF8AB4F8),
        style = MaterialTheme.typography.bodyLarge,
        maxLines = 4,
        overflow = TextOverflow.Ellipsis
    )
}
```

- [ ] **Step 2: MainScreen 传入**

`MainActivity.kt` 的 `MainScreen`：

```kotlin
val voiceStatus by viewModel.voiceStatus.collectAsState()
AgentBridgeScreen(card = agentCard, capsFromClient = fromClient, debugStatus = debugStatus, voiceStatus = voiceStatus)
```

`Preview` 里 `AgentBridgeScreen(card = AgentCardState(), capsFromClient = "subscribe: preview")` 保持不变（voiceStatus 有默认值）。

- [ ] **Step 3: 编译 APK**

Run: `gradlew assembleDebug`
Expected: BUILD SUCCESSFUL。

- [ ] **Step 4: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/activities/main/MainActivity.kt
git commit -m "feat(glasses): render voice status line"
```

---

### Task 7: 完整回复查看（CardStateMachine / CardRenderer / AgentActionHandler）

**Files:**
- Modify: `rokid-sdk/.../agent/CardStateMachine.kt`、`rokid-sdk/.../agent/CardRenderer.kt`、`rokid-sdk/.../agent/AgentActionHandler.kt`
- Test: 新增 `rokid-sdk/.../agent/CardStateMachineTest.kt`（JVM 单测）

**Interfaces:**
- Consumes: `AgentCardState.detailsVisible`、`details`、`body`。
- Produces: `onViewDetails` 恒 toggle；正文 `detailsVisible` 时无行数上限；auto-clear 15s。

- [ ] **Step 1: 写失败测试（onViewDetails 对空 details 也 toggle）**

```kotlin
class CardStateMachineTest {
    @Test
    fun `onViewDetails toggles even when details blank`() {
        val state = AgentCardState(body = "回复正文", details = "")
        val toggled = CardStateMachine.onViewDetails(state)
        assertTrue(toggled.detailsVisible)
        assertFalse(CardStateMachine.onViewDetails(toggled).detailsVisible)
    }
}
```

- [ ] **Step 2: 运行确认失败**

Run: `gradlew testDebugUnitTest --tests "*CardStateMachineTest*"`
Expected: FAIL（当前 `onViewDetails` 对空 details 返回原 state）。

- [ ] **Step 3: 修 onViewDetails**

```kotlin
fun onViewDetails(current: AgentCardState): AgentCardState =
    current.copy(detailsVisible = !current.detailsVisible)
```

- [ ] **Step 4: 修 CardRenderer maxLines**

`AgentCard` 正文 `Text` 的 `maxLines` 改为：

```kotlin
maxLines = if (card.detailsVisible) Int.MAX_VALUE else 4,
```

- [ ] **Step 5: 修 auto-clear**

`AgentActionHandler` 的 `AUTO_CLEAR_DELAY_MS`：

```kotlin
private const val AUTO_CLEAR_DELAY_MS = 15000L
```

- [ ] **Step 6: 运行确认通过**

Run: `gradlew testDebugUnitTest --tests "*CardStateMachineTest*"`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardStateMachine.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/CardRenderer.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentActionHandler.kt rokid-sdk/cxrssample/cxrswithcxrl/app/src/test/java/com/rokid/cxrswithcxrl/agent/CardStateMachineTest.kt
git commit -m "fix(glasses): make view_details toggle and expand full reply body"
```

---

## 真机 E2E 清单（最终验证）

1. PC：`AGENTBRIDGE_AUDIO_PORT=8788 AGENTBRIDGE_SESSION=default npm run start:session`，确认日志 `audio server listening on :8788` 且 STT 服务 `READY`。
2. 眼镜单击 → 屏幕依次出现「聆听中… → 识别中… → 已识别: <文字>（处理中…）→ 回复卡片」。
3. 连续两次说话，第二次间隔 <15s 应仍 ~2s 出结果（验证常驻模型生效）。
4. 回复正文：滑动 view_details 能展开、且不再 3s 消失（15s 内可读全）。
5. 轻声/句中停顿仍能完整识别（验证 VAD 放宽）。
