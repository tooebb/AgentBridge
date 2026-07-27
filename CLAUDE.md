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

## 当前状态 (2026-07-27)

Middleware Core / Agent Adapter / Web Dashboard / Mock Device Client **已有可运行实现**；真实 Phone / Glass 客户端仍待在客户端工程内完成。

### CXR-L SDK 联调（设备：华为 NOP_AN00 + Rokid RG-glasses）

| 功能 | 状态 | 说明 |
|------|------|------|
| CustomView | ✅ 通过 | 手机 JSON 布局 → 眼镜渲染 |
| CustomApp 安装 | ✅ 通过 | `appUploadAndInstall` 成功（之前 Meizu 失败是 WiFi 热点冲突，非固件限制） |
| CustomApp 启动 | ✅ 通过 | `appStart` → `onOpenAppResult: true` |
| 眼镜→手机 (sendMessage) | ✅ 通过 | 按键事件回传正常 |
| 手机→眼镜 (sendCustomCmd) | ❌ 放弃 | 根因：`cxrservice` 将 `sendCustomCmd` 路由为 `ShortMessage` 类型（`notifyType:UNKNOWN`），不被转发到 CustomApp 的 `subscribe` 回调。眼镜→手机的 `sendMessage` 走 `Notify` 类型正常。两方向使用不同协议消息类型，属 SDK 底层实现问题，闭源无法修复。 |

### 眼镜数据通道方案

**方案 A — CXR Caps 全双工**（官方推荐）→ **已放弃**
- 原因：`sendCustomCmd` (ShortMessage) 与 `sendMessage` (Notify) 走不同协议路径，前者不被路由到应用层，属 SDK 闭源不可修复
- CXR 保留用途：`appUploadAndInstall` / `appStart`（已验证 ✅）

**方案 B — WebSocket 直连 + CXR 仅管生命周期**（当前方向）
- CXR 负责：应用安装与启动（已确认可用）
- WebSocket 负责：Core ↔ 眼镜所有数据通信（审批、状态、通知、重连补发）
- 协议：标准 JSON，与 Dashboard/Mock Device 同一套；设备连接 `ws://<PC-IP>:8080/ws/{session_id}?device_type=ar_glasses`
- 状态：Core Device Dispatcher 已适配眼镜（6 个公开任务事件 × 独立渲染），`mock-device` 已覆盖 ack/replay/动作回传；真实眼镜端 OkHttp WS 客户端待实现

存储 / 认证状态：
- 事件存储默认使用内存环形缓冲；设置 `AGENTBRIDGE_EVENT_DB=/path/to/events.db` 后启用 SQLite 持久化、`last_acked_seq` 和重连补发。
- PostgreSQL/Redis 仍是后续生产化规划，不是当前实现。
- 认证/安全仍待开发。
