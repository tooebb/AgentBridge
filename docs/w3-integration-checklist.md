# W3 实机闭环联调清单

本文档用于 W3 眼镜接入前后的最小验收。目标不是替代真实 SDK 开发，而是把 Core、Agent Adapter、Phone/Glass 协议和实机交互的通过标准固定下来。

## 1. 前置环境

- Core 使用可持久化配置启动：`AGENTBRIDGE_EVENT_DB=/path/to/events.db`。
- Core 监听地址对眼镜端可访问：本机调试可用 `AGENTBRIDGE_ADDR=0.0.0.0:8080`。
- Agent Adapter 已连接同一个 session，并优先使用可用 provider；没有 `ANTHROPIC_API_KEY` 时确认 `generic-cli`、OpenAI-compatible 或 `claude-cli` fallback 可用。
- W3 端能访问：`ws://<core-host>/ws/<session_id>?device_type=ar_glasses&last_acked_seq=<seq>`。
- 眼镜端样例工程使用 `rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt` 中的 `DEFAULT_SERVER_URL` 和 `DEFAULT_SESSION_ID`。开发阶段默认值是 `ws://192.168.1.100:8080` / `default`，现场联调前必须改为 Core 机器的局域网 IP。

## 2. 自动前置检查

先启动 Core，再执行：

```bash
cd mock-device
SERVER=http://127.0.0.1:8080 npm run test:w3
```

该检查会模拟 ar_glasses 设备，覆盖：

- 眼镜端收到 `needs_approval`。
- 消息带 `seq` 和 `is_replay`，可用于 ack/replay。
- `device_overrides.ar_glasses` 含 TTS 文本、可操作卡片渲染 hint 和快捷动作。
- approve 动作携带 `last_acked_seq`、`device_type=ar_glasses`、语音文本并 relay 到 `agent_adapter`。
- 断连重连后按照 `last_acked_seq` 补发后续消息。

如果准备进入真实 W3/手机联调，先执行主机预检：

```bash
cd mock-device
SERVER=http://127.0.0.1:8080 npm run w3:preflight
```

该预检会检查 Node.js、mock-device 依赖、Core `/health`、模拟 W3 readiness，以及当前主机是否能通过 `adb devices` 看到设备。默认仓库自测模式下，未安装 `adb` 或未连接设备只会给出 WARN；现场真实联调时使用：

```bash
W3_REQUIRE_DEVICE=1 SERVER=http://127.0.0.1:8080 npm run w3:preflight
```

此时如果主机看不到 `state=device` 的 W3/手机设备，预检会失败并提示需要现场接入设备。

## 3. W3 端协议要求

- 首次连接携带 `device_type=ar_glasses`。
- 本地保存 `last_acked_seq`，收到每条 `server_to_client` 消息后先按 `seq` 去重，再更新最大已处理 seq。
- 重连时追加 `last_acked_seq`，只展示 `seq` 更大的补发消息。
- 展示 `is_replay=true` 的消息时不要重复触发震动/强提醒，可只恢复卡片状态。
- 按键、语音、触控动作统一通过 `client_to_server` 回传，`action.text` 用于语音转写或短文本说明。
- `risk_blocked=true` 时眼镜端只展示“需回到 PC 确认”，不显示 approve 快捷动作。

示例动作：

```json
{
  "direction": "client_to_server",
  "session_id": "demo-session",
  "task_id": "task-1",
  "last_acked_seq": 12,
  "action": {
    "type": "approve",
    "device_type": "ar_glasses",
    "timestamp": 1785121200000,
    "text": "approved by voice"
  }
}
```

## 4. 实机场景验收

| 场景 | 操作 | 通过标准 |
|------|------|----------|
| WebSocket 连接 | W3 连接 Core session | Core 识别为 `ar_glasses`，能收到实时或 replay 消息 |
| 屏显展示 | 发送 `needs_approval` | 眼镜显示可操作卡片，标题/正文不溢出，快捷动作正确 |
| TTS | 发送审批/失败/完成事件 | 播报使用 `device_overrides.ar_glasses.tts_text`，长度适合眼镜端 |
| 按键审批 | 眼镜按键 approve/reject | Core 生成 `user_action` 并 relay 给 `agent_adapter` |
| 语音审批 | 语音 approve/continue/pause | `action.text` 保留语音文本，Agent Adapter 能继续处理 |
| 断连重连 | 断网后恢复连接 | 只补发 `last_acked_seq` 之后的消息，不重复展示旧消息 |
| 高风险拦截 | 发送 `risk_blocked=true` 事件 | 眼镜端不允许移动审批，只提示回 PC 确认 |
| 多动作覆盖 | reject/continue/pause/view_details | 前三者回写 Agent，`view_details` 只用于详情展示 |

## 5. 手动联调命令

```bash
# Core
cd middleware-core
AGENTBRIDGE_ADDR=0.0.0.0:8080 AGENTBRIDGE_EVENT_DB=/tmp/agentbridge-w3.db go run ./cmd/server

# Agent Adapter
cd agent-adapter
AGENTBRIDGE_AGENT=generic-cli \
AGENTBRIDGE_AGENT_CMD=claude \
AGENTBRIDGE_AGENT_ARGS='["--print","--output-format","stream-json","{prompt}"]' \
npm run dev

# 本地模拟 W3
cd mock-device
SERVER=http://127.0.0.1:8080 npm run glass

# 眼镜端 APK
cd rokid-sdk/cxrssample/cxrswithcxrl
chmod +x gradlew
./gradlew :app:assembleDebug
```

真实设备联调需要现场补充以下输出，便于继续定位：

```bash
adb devices
adb logcat -d -t 300
```

同时保留 Core 控制台日志和 W3/手机 App 日志；如果设备未接入当前可执行命令的主机，本仓库只能完成模拟验证，无法直接判断 SDK、蓝牙、系统 TTS 或按键事件是否正常。

## 6. 当前边界

- 本仓库提供 W3 接入协议、模拟验证和联调清单；真实 W3 App 的 SDK 接入、蓝牙链路、系统级 TTS/按键事件绑定仍需要在客户端工程内完成。
- 2026-07-28 本地 agent 已完成协议层验证：Go tests、E2E、W3 readiness、Mock Glass 和 Agent Adapter -> Core -> Mock Glass 全链路均通过；该结论只代表后端/协议层无阻断性 bug，不替代真实 Rokid 设备验收。
- `npm run w3:preflight` 能确认当前主机是否具备进入实机联调的条件，但不能替代 W3 SDK/App 真实运行验证。
- OpenAI-compatible provider 目前是最小文本调用骨架，不覆盖所有模型的 tool calling 和流式差异。
- 实机验收前应先跑 `npm run test:w3`、`npm run test:e2e`、`middleware-core go test ./...`。
- 2026-07-28 当前开发环境的 Android 编译被系统 JDK `java.security` 配置阻断，需在 Android Studio 或可用 JDK/Android SDK 环境中执行 `./gradlew :app:assembleDebug` 后再进入真机验收。
