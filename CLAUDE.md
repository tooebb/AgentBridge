# AgentBridge

AI Agent 跨设备交互中间层。结构化 Agent 输出 → 分发到手机/手表/眼镜/耳机 → 用户远程审批。

## 怎么跑

```bash
# Core (Golang, :8080)
cd middleware-core && go run cmd/server/main.go

# Dashboard (React, :5173)
cd dashboard && npm install && npm run dev

# Agent Adapter (Node.js)
cd agent-adapter && npm install && npm run dev

# Mock Device (测试用，无需真机)
cd mock-device && npm install && npm run phone
```

## 技术栈

| 组件 | 语言 |
|------|------|
| Core | Go 1.21+, chi, gorilla/websocket |
| Agent Adapter | TypeScript, child_process, ws |
| Dashboard | React 18, TypeScript, Vite |
| Mock Device | Node.js, ws |

## 目录约定

- `middleware-core/` — 不要在这里 `npm install`
- `agent-adapter/`, `dashboard/`, `mock-device/` — 各自有独立 `package.json`
- `docs/` — 架构设计、需求、W3 联调清单和历史设计/计划文档
- 当前目录是 Git 仓库；改动前后用 `git status --short --branch` 确认工作区状态

## 当前状态 (2026-08-04)

### Phase 1（PC only）— ✅ 全部完成

Middleware Core / Agent Adapter / Web Dashboard / Mock Device 可运行，协议对齐。

### Phase 2（WiFi 联调 / 真机）— 🔄 核心闭环已跑通

**眼镜端（cxrswithcxrl，`com.rokid.cxrswithcxrl`）**：
| 组件 | 文件 | 状态 |
|------|------|------|
| 协议数据类 | `agent/AgentBridgeProtocol.kt` | ✅ |
| WS 客户端 + 重连 | `agent/AgentBridgeClient.kt` | ✅ |
| 卡片状态 + TTS | `agent/AgentActionHandler.kt` | TTS 代码已写，待真机验证 |
| Compose 卡片 UI | `agent/CardRenderer.kt` | ✅ |
| 键盘手势处理 | `activities/main/MainActivity.kt` | ✅ 真机验证通过 |
| 集成层 | `activities/main/MainViewModel.kt` | ✅ |

**真机验证结果（2026-08-04，ADB 隧道直连）**：

| # | 场景 | 结果 |
|---|------|------|
| 1 | WebSocket 连接 | ✅ Core 收到 `device_type=ar_glasses` |
| 2 | 卡片显示 | ✅ status/actionable/alert 卡片正常渲染 |
| 3 | 单击 → approve | ✅ 500ms 消抖，Core 收到 `action.type=approve` |
| 4 | 双击 → reject | ✅ 两次 keyCode=83 在 500ms 内视为双击 |
| 5 | 滑动 → view_details | ✅ 向镜腿=19 / 向镜片=20，Core 记录日志 |
| 6 | 断连重连 | ✅ 指数退避重连 + is_replay 去重 |

**手机端（CXRLSample）**：仅做 CXR 生命周期（install + start），不参与数据面。

**2026-08-05 新增**：

| # | 场景 | 结果 |
|---|------|------|
| 7 | 卡片保护 | ✅ actionable_card 不被 task_running 覆盖 |
| 8 | E2E relay 验证 | ✅ Core→眼镜→Core→Agent Adapter→ccswitch stdin 全链路 |

**待完成**：
- TTS 真机验证（代码已写，被未知音频问题搁置）
- 语音审批
- 手机端 AgentBridgeService（网络中枢 fallback）
- 代码清理：删 WiFi 死代码 ✅、抽 GestureHandler ✅、补主动 ack
- **P0**：ccswitch 结构化工具审批 / 切换到 claude-api 适配器（实现 approve→执行闭环）
- Core 端口被 NI Application Web Server 抢占时换 8088 端口
- Agent Adapter 用 `127.0.0.1` 而非 `localhost`（避免 IPv6 断连）

### CXR-L SDK 联调

| 功能 | 状态 |
|------|------|
| CustomView | ✅ |
| CustomApp 安装 | ✅ |
| CustomApp 启动 | ✅ |
| 眼镜→手机 (sendMessage) | ✅ |
| 手机→眼镜 (sendCustomCmd) | ❌ 放弃（SDK 闭源协议路由问题） |

### 数据通道：WebSocket 直连，CXR 仅管生命周期（不再改动）

存储：默认内存环形缓冲，可选 SQLite（`AGENTBRIDGE_EVENT_DB`）。认证/安全仍待开发。

### 仓库

- Fork: `https://github.com/tooebb/AgentBridge` (origin)
- Upstream: `https://github.com/GaeainCloud/AgentBridge`
- 当前分支: `agent/recovered`
