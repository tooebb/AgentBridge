# Phase2 MVP 临时本地测试文档

本文档给本地测试 agent 使用，用于在没有 Rokid 真机的情况下先拿取仓库内工程并验证 Phase2 MVP 的可测试部分。本文档是临时说明，后续真机链路稳定后可合并进 `docs/w3-device-field-test.md`。

## 1. 拉取工程

```bash
git clone https://github.com/tooebb/AgentBridge.git
cd AgentBridge
git checkout agent/recovered
```

当前需要重点测试的工程目录：

- `middleware-core/`：WebSocket Core，负责 session、device、seq、ack/replay。
- `agent-adapter/`：Agent 事件入口。
- `mock-device/`：本地模拟 phone/watch/glass/earbuds 和 W3 预检。
- `rokid-sdk/cxrssample/cxrswithcxrl/`：眼镜端 CustomApp MVP。
- `rokid-sdk/CXRLSample/`：手机端 CXR-L 控制面样例。

## 2. Core 协议回归

```bash
cd middleware-core
go test ./...
```

通过标准：所有 Go 测试通过，尤其是 EventStore、dispatcher、WebSocket handler 相关测试不能退化。

## 3. Mock Device / W3 本地测试

```bash
cd mock-device
npm install
npm run test:e2e
npm run test:w3
npm run w3:preflight
```

通过标准：

- `test:e2e` 覆盖 action 回传和 replay。
- `test:w3` 覆盖 W3/ar_glasses 的协议 readiness。
- `w3:preflight` 能确认当前主机具备进入眼镜端联调的基本条件。

这些命令只证明 Core 协议和模拟设备链路正常，不能替代真实眼镜 App 的编译、安装和屏幕验收。

## 4. 眼镜端 APK 编译

```bash
cd rokid-sdk/cxrssample/cxrswithcxrl
chmod +x gradlew
./gradlew :app:assembleDebug
```

默认 WebSocket 地址在：

```text
app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt
```

现场测试前把 `DEFAULT_SERVER_URL` 改为 Core 所在电脑的局域网地址，例如：

```kotlin
const val DEFAULT_SERVER_URL = "ws://192.168.31.208:8080"
const val DEFAULT_SESSION_ID = "default"
```

通过标准：生成 `app/build/outputs/apk/debug/app-debug.apk`。如果本地环境缺 Android SDK、JDK 或私有 Maven 访问能力，把完整 Gradle 错误记录到 issue，不要用 mock 测试结果替代 APK 编译结论。

## 5. 手动联调脚本

启动 Core：

```bash
cd middleware-core
AGENTBRIDGE_ADDR=0.0.0.0:8080 AGENTBRIDGE_EVENT_DB=/tmp/agentbridge-w3.db go run ./cmd/server
```

另开终端启动模拟眼镜：

```bash
cd mock-device
SERVER=http://127.0.0.1:8080 npm run glass
```

如果需要 Agent Adapter 参与：

```bash
cd agent-adapter
npm install
npm run dev
```

本地 agent 需要记录：

- Core 日志中是否出现 `device_type=ar_glasses`。
- 模拟眼镜是否收到带 `seq` 的事件。
- action 回传是否包含 `action.type`、`action.text`、`last_acked_seq`。
- 断线重连后是否只 replay 未确认消息，且 replay 消息带 `is_replay=true`。

## 6. 真机验收保留项

以下内容必须在真实 Rokid 环境中确认，不能由本地 agent 单独关闭：

- CXR-L 是否能安装并启动 `cxrswithcxrl` debug APK。
- 眼镜端是否能通过同一 Wi-Fi 访问 `ws://<PC-LAN-IP>:8080`。
- Compose 卡片在眼镜屏幕上的字号、截断和状态行是否可读。
- 单击、双击、长按的按键广播是否与 `KeyReceiver` 映射一致。
- TTS 是否只在非 replay 消息播报一次。

