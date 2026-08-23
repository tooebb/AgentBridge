# 线 B 语音 UX 修复与增强 设计文档

> 状态：已批准（2026-08-23）。本 spec 覆盖语音链路的三个问题：①延迟高/偶发无回复 ②无实时反馈 ③回复截断+view_details 失效。

**Goal:** 让眼镜语音输入「快、有反馈、回复可读全」，不改 Core 协议、不改 AgentBridgeClient 消息协议、审批链路不变。

**Architecture:** 常驻 faster-whisper 模型消掉每次 ~15s 重载；daemon 在 STT 完成后回显 `user_input` 事件到眼镜做分阶段状态；眼镜端修 view_details 与正文截断。

**Tech Stack:** Go (Core，不动) / TypeScript (agent-adapter) / Python faster-whisper (STT) / Kotlin Compose (眼镜)。

## 全局约束

- **不改 Core 协议**：middleware-core 零改动。Core 的事件类型枚举、状态机、通知引擎全部保持现状。
- **不改 AgentBridgeClient 消息协议**：`DeviceMessage`/`UnifiedMessage` 字段不变，只新增使用 `event_type` 字符串值。
- **审批链路不变**：`needs_approval` → approve/reject → 工具执行的既有链路不被触碰。
- 新增的 `event_type: "user_input"` 是 Core 状态机不认识的值，依赖 Core 的容错行为（见「关键发现」）。

## 关键发现（设计依据）

1. **Core 状态机容错**（`middleware-core/cmd/server/main.go:138-143`）：非法状态迁移只 `log.Printf`，不 reject 事件，事件照常 dispatch 到设备。因此 `user_input` 事件能透传到眼镜，只是日志多一条 benign error，且状态机保持原状态（Idle），后续 Claude 的 `task_started` 仍从 Idle 正常起跳。
2. **Core 眼镜通知有 10s cooldown**（`middleware-core/internal/notify/engine.go:33`）：非终结事件 10s 内只发第一条；`task_completed/task_failed/needs_approval/task_blocked` 为终结事件、永远发。这对本设计**有利**：`user_input` 回显卡片会持续显示，中间 Claude 的 `task_started`/`task_running`（text 流）被 cooldown 压掉、不闪屏，最终 `task_completed`（终结）正常到达。
3. **回复正文未被截断到 500 字符**：`task_completed` 的 `summary` 来自 `resultText()`，未 slice；截断发生在眼镜渲染层 `maxLines=4`，以及 `onViewDetails` 对空 `details` 的 no-op。

---

## 改动 1：STT 常驻模型（修 15s 延迟）

### 根因
`agent-adapter/stt/transcribe.py:13` 每次调用 `WhisperModel("small")` 重新加载 ~483MB 模型，单次 ~15s。

### 方案
新增常驻 Python HTTP 服务，模型只加载一次；Node 侧通过 `SttClient` 调用，失败 fallback 到旧的单次调用。

### 文件

**新建 `agent-adapter/stt/transcribe_server.py`**
- `sys.stdout.reconfigure(encoding="utf-8")`。
- `model_name = os.environ.get("AGENTBRIDGE_STT_MODEL", "small")`。
- 启动即 `WhisperModel(model_name, device="cpu", compute_type="int8")`，加载完成后向 stdout 打印一行 `READY`。
- 用 `http.server.ThreadingHTTPServer` + `BaseHTTPRequestHandler` 监听 `AGENTBRIDGE_STT_PORT`（默认 `8790`，仅绑定 `127.0.0.1`）。
- 路由：
  - `GET /health` → `200`（模型就绪）。
  - `POST /transcribe` → 请求体为 WAV 字节，写入临时文件，`model.transcribe(path, language="zh")`，响应体为拼接后的文字（UTF-8）。
- 每个请求用完即删临时文件。

**改 `agent-adapter/src/stt.ts`**
- 新增 `SttClient` 类：
  - `start(python, script)`: spawn `python transcribe_server.py`，等 stdout 出现 `READY`（或轮询 `/health`，超时 120s），随后做一次预热转写。
  - `transcribe(pcm, sampleRate)`: `pcmToWav` → `POST http://127.0.0.1:<port>/transcribe` → 返回文字。
  - `close()`: kill 子进程。
- 保留 `pcmToWav` 与 `runPython`（作为 fallback）。
- `transcribe()` 导出改为懒初始化一个模块级单例 `SttClient`：启动失败或健康检查失败时，回退到现有单次 `runPython` 路径。

**改 `agent-adapter/src/session.ts`**
- `main()` 里在启动 `AudioServer` 时创建 `SttClient` 实例，`onUtterance` 用它转写；`shutdown()` 时 `close()`。

### 效果
首次 ~15s 在 daemon 启动时预热掉，之后每句 ~1-2s。

---

## 改动 2：VAD 稳定性 + 日志（修偶发无回复）

### 根因
- `silenceMs=600` 句中停顿 >600ms 即切碎语句，后续音频因眼镜已 stop 而丢失。
- `speechThreshold=100`、`preRollMs=200` 偏保守，轻声/句首易漏。
- STT 空结果时 `if (text)` 静默丢弃，无反馈、无日志。

### 方案

**改 `agent-adapter/src/session.ts`**
- VAD 参数改为 `{ sampleRate: 16000, speechThreshold: 60, silenceMs: 1000, preRollMs: 400 }`。

**改 `agent-adapter/src/audio-server.ts`**
- `handleConnection` 增加日志：连接建立、语句开始（首次触发 speech）、语句结束（时长 ms + 采样数）。
- 保留现有 `rms16` 阈值逻辑，不改分段算法。

**改 `agent-adapter/src/session.ts`（空结果处理）**
- `onUtterance` 里 `text` 为空时，仍回显一条 `user_input` 事件（body=「未识别到语音」），不再静默。

---

## 改动 3：分阶段状态 + 文字回显

### 阶段流转

| 阶段 | 驱动方 | 通道 |
|---|---|---|
| 聆听中 | 眼镜本地（VoiceCapture RECORDING） | 无 |
| 识别中 | 眼镜本地（收到 `stop` → IDLE） | 音频 WS |
| 已识别 + 处理中 | daemon 回显 `user_input` 事件 | Core |
| 回复 | `task_completed`（终结事件） | Core |

### daemon 侧（`agent-adapter/src/session.ts`）

`onUtterance` 改为：
1. `text = await transcribe(pcm, sampleRate)`。
2. `await wsClient.sendEvent(userInputEvent(text))` —— 先回显。
3. `text` 非空时 `await bridge.handleUserAction({ type: 'user_message', text })`。

`userInputEvent(text)` 构造 `UnifiedMessage`：
```
{
  id: <uuid>,
  task_id: sessionId,
  session_id: sessionId,
  event_type: "user_input",
  title: "语音输入",
  body: text,
  severity: "info",
  risk_score: 0,
  risk_blocked: false,
  available_actions: [],
  timestamp: <ISO>,
  agent_id: "claude-cli",
}
```

### 眼镜侧

**改 `MainViewModel.kt`**
- 新增 `_voiceStatus: MutableStateFlow<String>("")` + `voiceStatus` 只读流。
- `toggleVoice()` 的 `VoiceCapture.onState`：RECORDING → `"聆听中…"`，IDLE → `"识别中…"`。
- `AgentBridgeClient.Listener.onMessage` 增加分支：`message.event?.eventType == "user_input"` → `_voiceStatus.value = "已识别: ${body}（处理中…）"`；`task_completed` / `task_failed` / `needs_approval` → `_voiceStatus.value = ""`。

**改 `CardRenderer.kt`**
- 在卡片上方/下方渲染 `voiceStatus` 状态区（醒目样式，非空白时不显示或置灰原有的 `capsFromClient` 调试行）。
- `AgentBridgeScreen` 签名增加 `voiceStatus: String = ""` 参数，`MainScreen` 传入。

---

## 改动 4：完整回复查看

### 根因
1. `CardStateMachine.onViewDetails`（`rokid-sdk/.../agent/CardStateMachine.kt:102-103`）在 `details` 为空时直接 `return current`；而文本回复的 `details` 恒为空（`normalizer.ts:150` 只有 `needs_approval` 才填 details）→ 滑动无效果，用户感知为「退出来」。
2. `CardRenderer` 正文 `maxLines = 4` 截断。
3. `AgentActionHandler.AUTO_CLEAR_DELAY_MS = 3000` 太短，长回复没读完就消失。

### 方案

**改 `CardStateMachine.kt`**
- `onViewDetails` 去掉守卫，恒 `current.copy(detailsVisible = !current.detailsVisible)`。

**改 `CardRenderer.kt`**
- 正文 `maxLines = if (card.detailsVisible) Int.MAX_VALUE else 4`；`details` 为空时仍展示 `body`（现有三元逻辑已满足，保留）。

**改 `AgentActionHandler.kt`**
- `AUTO_CLEAR_DELAY_MS` 3000 → 15000。

---

## 测试策略

- **agent-adapter**（Node，`node --test`）：`SttClient` 用假 HTTP 服务测启动/转写/fallback；`VadSegmenter` 边界（阈值、静音、preroll）；`userInputEvent` 结构字段断言。
- **眼镜**（Kotlin，JVM 单测）：`CardStateMachine.onViewDetails` 对空 `details` 也能 toggle；`reduce` 对 `user_input` 的渲染分支。
- **真机 E2E**（手动）：单击→说话→观察「聆听中→识别中→已识别+处理中→回复」四阶段；回复正文滑动展开可读全。

## 非目标

- 流式逐字转写（本次只做「识别完成后回显」，不做边说边出字）。
- TTS 语音朗读（眼镜 ROM 音频输出仍 broken，见技术约束）。
- 手机端网络中枢 fallback、认证/安全层、Core mDNS IP 漂移重注册（Bug A）。
