# W3 眼镜端现场联调手册

本文档记录 Phase 2 MVP 的真机联调步骤。目标是验证眼镜端 CustomApp 通过 WebSocket 直连 Core，完成状态展示、审批卡片、按键动作回传和断线重连 replay。

## 1. Core 启动

在 Core 所在电脑启动服务，监听所有网卡：

```bash
cd middleware-core
AGENTBRIDGE_ADDR=0.0.0.0:8080 AGENTBRIDGE_EVENT_DB=/tmp/agentbridge-w3.db go run ./cmd/server
```

记录电脑局域网 IP，例如 `192.168.31.208`。眼镜端不能使用 `127.0.0.1`。

## 2. 眼镜端地址配置

修改：

```text
rokid-sdk/cxrssample/cxrswithcxrl/app/src/main/java/com/rokid/cxrswithcxrl/agent/AgentBridgeClient.kt
```

把默认地址改成现场 Core 地址：

```kotlin
const val DEFAULT_SERVER_URL = "ws://192.168.31.208:8080"
const val DEFAULT_SESSION_ID = "default"
```

MVP 阶段地址硬编码。更换 Wi-Fi 或电脑 IP 后需要重新编译安装 APK；后续小阶段再做手机端配置入口或 ADB 参数覆盖。

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
| 单击 approve/continue | 镜腿按键单击 | Core 收到 `action.type` 为 quickActions[0]，并携带 `last_acked_seq` |
| 双击 reject/pause | 镜腿按键双击 | Core 收到 `action.type` 为 quickActions[1]，并携带 `last_acked_seq` |
| 长按 view_details | 镜腿按键长按 | Core 收到 `action.type=view_details` |
| 断线重连 replay | 断网后恢复 | 眼镜携带 `last_acked_seq` 重连；只恢复未确认消息，重复 seq 计入 duplicate 不重复播报 |

## 5. 日志留存

现场验收需要保留：

```bash
adb devices
adb logcat -d -t 300
```

同时保存 Core 控制台日志、Agent Adapter 日志和眼镜屏幕状态。若 Android 编译或设备连接不可用，先执行 `docs/w3-integration-checklist.md` 中的模拟检查，真机结果不得用模拟结果替代。
