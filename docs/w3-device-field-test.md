# W3 眼镜端现场联调手册

本文档记录 Phase 2 MVP 的真机联调步骤。目标是验证眼镜端 CustomApp 通过 WebSocket 直连 Core，完成状态展示、审批卡片、按键动作回传和断线重连 replay。

## 1. 连接模式

### 模式 A：ADB Reverse Tunnel（开发阶段，推荐）

手机通过 USB 连接 PC，ADB 将手机 19090 端口转发到 PC 8080：

```bash
adb reverse tcp:19090 tcp:8080
```

眼镜端使用 `ws://127.0.0.1:19090` 连接 Core（CustomApp 运行在手机 Android 系统上，走手机的 TCP 栈）。

Core 启动（监听 localhost 即可）：
```bash
cd middleware-core
AGENTBRIDGE_EVENT_DB=/tmp/agentbridge-w3.db go run ./cmd/server
```

眼镜端 `AgentBridgeClient.kt` 默认地址：
```kotlin
const val DEFAULT_SERVER_URL = "ws://127.0.0.1:19090"
```

### 模式 B：LAN 直连（部署/无 USB 场景）

Core 监听所有网卡，眼镜端使用 Core 电脑的局域网 IP：

```bash
AGENTBRIDGE_ADDR=0.0.0.0:8080 AGENTBRIDGE_EVENT_DB=/tmp/agentbridge-w3.db go run ./cmd/server
```

修改 `AgentBridgeClient.kt`：
```kotlin
const val DEFAULT_SERVER_URL = "ws://192.168.31.208:8080"
```

## 2. 眼镜端地址配置

`DEFAULT_SERVER_URL` 位于：
```text
rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt
```

默认值为 `ws://127.0.0.1:19090`（ADB reverse 模式）。切换到 LAN 模式时需改为 Core 电脑的局域网 IP，然后重新编译安装 APK。

## 3. APK 构建与安装

```bash
cd rokid-sdk/cxrssample/cxrswithcxrl
chmod +x gradlew
./gradlew :app:assembleDebug
```

APK 生成路径：

```text
app/build/outputs/apk/debug/app-debug.apk
```

通过手机端 `rokid-sdk/CXRLSample` 的 CustomApp install/start 流程安装并启动眼镜 App。

## 4. 验收矩阵

| 场景 | 操作 | 通过标准 |
|------|------|----------|
| WS 连接 | 启动眼镜 App | Core 日志出现 `device_type=ar_glasses`，眼镜状态显示 `WS: connected` |
| 状态卡片 | 发送 `task_started` / `task_running` | 眼镜显示标题、正文、ack 序号和事件状态 |
| 审批卡片 | 发送 `needs_approval` | 眼镜显示 actionable card、quick action 提示，TTS 播报一次 |
| 单击 → approve | 触控板单击 (keyCode=83) | 500ms 消抖，Core 收到 `action.type=approve` (QuickActions[0]) |
| 双击 → reject | 触控板双击 (keyCode=83×2) | 500ms 内两次 click，Core 收到 `action.type=reject` (QuickActions[1]) |
| 滑动 → view_details | 向镜腿 (19) / 向镜片 (20) 滑动 | Core 收到 `action.type=view_details` |
| 物理按键 → reject | 眼镜物理返回键 (keyCode=4) | Core 收到 `action.type=reject` |
| 断线重连 replay | 断网后恢复 | 眼镜携带 `last_acked_seq` 指数退避重连；replay 消息不重复播报 |

## 5. 日志留存

现场验收需要保留：

```bash
adb devices
adb logcat -d -t 300
```

同时保存 Core 控制台日志、Agent Adapter 日志和眼镜屏幕状态。若 Android 编译或设备连接不可用，先执行 `docs/w3-integration-checklist.md` 中的模拟检查，真机结果不得用模拟结果替代。
