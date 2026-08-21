# 线 B：眼镜端输入 + 免 PC 交互 设计文档

**目标**：在线 A（自动镜像）全部功能基础上，让眼镜成为主控台——用户通过眼镜语音/文字输入，驱动同一个本地 Claude 会话，整个交互过程不碰 PC（PC 仅启动时运行后台 Core + daemon + STT）。

**架构**（分层，采纳 codex 建议）：不推翻线 A 的 hook 自动镜像链路，新增一个「会话控制层」作为眼镜输入通道。两条路并存，线 A 不会因线 B 作废。

## 已验证的关键事实（spike 结论，2026-08-21）

| 风险点 | 结论 | 证据 |
|--------|------|------|
| 眼镜麦克风是否可用 | ✅ 可用 | `AudioRecord`（16kHz mono PCM16）初始化成功，说话时振幅从底噪 ~10 跳到 ~350 peak（~35x 信噪比） |
| SDK 是否支持多轮续会话 | ✅ 支持 | `query({ options: { resume: sessionId } })` 续会话，session_id 稳定 + 上下文保留（第 2 轮记得第 1 轮的数字） |

- **音频输入可用，音频输出(TTS)不可用**：`TextToSpeech` 死在 init（「音频引擎初始化失败」）。所以线 B 输入走语音，输出走文字。
- **Rokid 云 ASR 需 AK/SK（没有）**，眼镜锁 ROM 大概率无 Google 语音服务 → STT 必须 PC 端自建。

## 当前仓库落地状态（2026-08-21）

- 眼镜端已有麦克风探针代码：`rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/MicProbe.kt`。
- 探针使用 `AudioRecord`、16kHz、mono、PCM16；输出 `samples/peak/rms`，方便真机判断底噪与说话时信噪比。
- 探针统计逻辑已拆成 `MicProbeStats`，由 JVM 单测覆盖；Android 设备 API 仍只在真机/模拟器运行时验证。
- `MainActivity` 启动时请求 `RECORD_AUDIO`，授权后后台执行一次 15s 探针；Activity 销毁时会停止探针循环。
- `agent-adapter` 已支持文字多轮会话控制层的基础实现：`ClaudeCodeAdapter` 对后续 `user_message` 使用 SDK `resume`，并新增 `SessionBridge` daemon 入口 `npm run start:session`。

## 一次语音交互的数据流

```
眼镜空闲 → 点击开关 → 麦克风采 PCM
   → 流式发 PC → STT(faster-whisper) 转文字 → 静音检测断句
   → daemon 把文字喂进 SDK 会话（首轮 query / 后续 resume）
   → agent 跑：流式文字 → 眼镜屏显示
            高风险工具 → 审批卡片 → 眼镜 approve/reject（复用现有）
   → agent 结束 → 最终文字回传眼镜
```

## 组件与职责

| 组件 | 位置 | 改动 | 职责 |
|------|------|------|------|
| 眼镜语音采集 | 眼镜 App | 新增 | 点击开关触发录音，`AudioRecord` 采 PCM，流式发送 |
| 音频通道 | 眼镜↔PC | 新增 | 传输 PCM（见「音频通道决策」） |
| STT 引擎 | PC | 新增 | faster-whisper 转文字 + 静音检测（VAD）断句 |
| 会话控制层 | `agent-adapter` | 改 `adapters/claude.ts` | 首轮 `query` + 后续 `resume`，接收文字输入喂给会话 |
| Core | Go | 小改或不改 | 中继 user_message 输入 / 审批 / 文字输出 |
| 审批链路 | 现有 | 复用 | canUseTool → needs_approval → 眼镜 approve/reject → 执行 |

## 关键决策

1. **输入方式 = 语音**（麦克风已验证可用；眼镜打字不现实）
2. **输出方式 = 文字**（流式文字 + 最终摘要；TTS 语音朗读后置，因音频输出链路坏）
3. **STT 位置 = PC 端**（faster-whisper；Rokid 云 ASR 没 AK/SK，眼镜端无 Google 识别）
4. **触发方式 = 点击开关，一次一句**（空闲时点一下开始听，说一句后静音自动结束；与审批手势不冲突，因审批手势只在卡片出现时生效）
5. **多轮会话 = SDK resume**（首轮 `query` 拿 `session_id`，后续 `query({ options: { resume: sessionId } })`）
6. **会话生命周期 = 持久单会话**（用户多轮连续对话；重置方式后续定，先不实现）

## 复用 vs 新增

**复用（已跑通，不改）**：
- `canUseTool` 动态审批 + `assessRisk` 风险分级（`adapters/claude.ts` 已有，Phase 3a 验证）
- 审批卡片 / 手势 approve/reject（眼镜端已有）
- 文字回传（`task_completed.summary` / `text` 事件）
- AgentBridge WS 协议 + mDNS 服务发现
- `AgentInput.user_message` + `text` 字段（协议已预留）

**新增**：
- `adapters/claude.ts` 的 `send()` 多轮化：持久化 `session_id`，`user_message` 走 `resume`
- 眼镜端语音采集 + 点击开关（复用已验证的 `MicProbe` 采集逻辑，正式化）
- 音频通道（见下）
- PC 端 STT 服务（faster-whisper）

## 音频通道决策

眼镜的 PCM 怎么到 PC？两条候选：

- **方案 A（推荐）：复用现有 AgentBridge WS**。眼镜通过已连的 Core 连接发音频帧，Core 中继到 daemon。优点：一条连接、复用 mDNS 已发现的地址、无新发现逻辑。缺点：Core 需中继二进制帧（协议小改）。
- **方案 B：独立音频 WS**。眼镜开第二条 WS 直连 daemon 的音频端口（PC 同主机，端口固定或由 mDNS TXT 通告）。优点：Core 零改动、职责分离。缺点：第二条连接 + 地址发现。

默认走 **方案 A**；若 Core 二进制中继改动过大，退方案 B。具体在实现计划中敲定。

## 错误处理

- **静音检测超时**：用户点击后 N 秒无语音（如 10s），自动结束并提示。
- **STT 识别失败/低置信**：回传「未听清，请再说一次」到眼镜，不喂给 agent。
- **agent 会话出错**：`task_failed` 事件回传眼镜显示错误文字。
- **daemon/Core 重启**：会话丢失则重启一个 session（用户重说）；审批超时走现有 auto-allow。
- **断连重连**：复用现有 `AgentBridgeClient` 指数退避 + mDNS 重发现。

## 测试

**单元测试**（TDD）：
- `ClaudeCodeAdapter` 多轮：首轮 `query`、次轮 `resume`（mock `queryFactory` 断言 `options.resume` 传入正确 session_id）
- STT 断句逻辑（VAD）
- 眼镜端录音开关状态机
- 麦克风探针统计：`samples`、`peak`、`rms` 和进度文案格式

**E2E 真机场景**（复用 Phase 2/3a 方法论）：
1. 眼镜点击 → 说一句话 → PC STT 转文字 → 喂会话 → agent 文字回复回传眼镜
2. 多轮上下文：第 1 轮说「记住 42」，第 2 轮问「我刚说的数字」→ agent 回 42
3. 语音触发高风险工具 → 审批卡片 → 眼镜 approve → 工具执行
4. 静音超时 → 提示重说
5. STT 失败 → 提示未听清

## 范围

**In scope**：语音输入 → STT → 多轮会话 → 文字输出 + 审批闭环。
**Out of scope（后置）**：TTS 语音朗读、唤醒词、文字输入（键盘）、会话重置、多 Agent、认证/安全。

## 依赖

- `@anthropic-ai/claude-agent-sdk` v0.3.232（已有）
- faster-whisper（新增 Python 依赖，或 whisper.cpp 替代）
