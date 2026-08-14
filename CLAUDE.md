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

## 当前状态 (2026-08-11)

### Phase 1（PC only）— ✅ 全部完成

Middleware Core / Agent Adapter / Web Dashboard / Mock Device 可运行，协议对齐。

### Phase 2（真机联调 / 端到端闭环）— ✅ 全部完成 (2026-08-11)

**核心成果**：Agent 输出 → 眼镜卡片渲染 → 用户手势审批 → 工具真正执行 → 结果回传，完整闭环跑通。

**眼镜端组件（cxrswithcxrl，`com.rokid.cxrswithcxrl`）**：

| 组件 | 文件 | 状态 |
|------|------|------|
| 协议数据类 | `agent/AgentBridgeProtocol.kt` | ✅ |
| WS 客户端 + 重连 | `agent/AgentBridgeClient.kt` | ✅ |
| 卡片状态 + TTS | `agent/AgentActionHandler.kt` | ✅ 卡片逻辑已验证，TTS 代码已写待真机验证音频 |
| Compose 卡片 UI | `agent/CardRenderer.kt` | ✅ |
| 键盘手势处理 | `activities/main/MainActivity.kt` | ✅ |
| 集成层 | `activities/main/MainViewModel.kt` | ✅ |

**真机验证 — 12 场景全部通过**：

| # | 场景 | 日期 | 结果 |
|---|------|------|------|
| 1 | WebSocket 连接 | 08-04 | ✅ Core 收到 `device_type=ar_glasses` |
| 2 | 卡片显示 | 08-04 | ✅ status/actionable/alert 卡片正常渲染 |
| 3 | 单击 → approve | 08-04 | ✅ 500ms 消抖，Core 收到 action |
| 4 | 双击 → reject | 08-04 | ✅ 500ms 内两次 keyCode=83 视为双击 |
| 5 | 滑动 → view_details | 08-04 | ✅ 向镜腿=19 / 向镜片=20 |
| 6 | 断连重连 | 08-04 | ✅ 指数退避 + is_replay 去重 |
| 7 | 卡片保护 | 08-05 | ✅ actionable_card 不被 task_running 覆盖 |
| 8 | E2E relay 验证 | 08-05 | ✅ Core→眼镜→Core→Adapter→ccswitch 全链路 |
| 9 | DeepSeek API 集成 | 08-11 | ✅ anthropic 协议兼容，model=deepseek-v4-pro |
| 10 | **approve→execute 闭环** | 08-11 | ✅ 单击→工具执行→文件写入成功 |
| 11 | **reject 拒绝** | 08-11 | ✅ 双击→工具不执行→Agent 收到拒绝换方案 |
| 12 | **Core 重启恢复** | 08-11 | ✅ 适配器+眼镜自动重连，seq 重置不丢卡片 |

**4 项关键 bug 修复（commit `c6ad543`）**：
- adapter: approve 后真正执行工具（之前只返回"Approved"文本）
- adapter: main() 不再在 agent turn 后 close/shutdown，保持进程等待用户操作
- adapter: ws-client 过滤 `is_replay` 消息，防止旧事件重放级联
- glasses: `connect()` 时重置 seq 跟踪，防止 Core 重启后卡片僵死

**新建设施**：
- `scripts/tunnel-watchdog.ps1` — 眼镜 WiFi 保活 + ADB 隧道守护 + ADB daemon 自动恢复（每 10s）
- `scripts/deploy-apk.ps1` — APK 推送→安装→验证→自动开 WiFi 一键部署

**手机端（CXRLSample）**：仅做 CXR 生命周期（install + start），不参与数据面。

### 眼镜 WiFi 发现与 LAN 直连 (2026-08-11)

**重大发现**：眼镜有完整 WiFi 6 硬件（wlan0, 芯片 kiwi_v2），支持 5GHz 频段。之前"眼镜没有 WiFi"的判断是错的——系统默认禁用 station 模式以省电。

| 项 | 值 |
|----|-----|
| WiFi 芯片 | Qualcomm kiwi_v2, WiFi 6 |
| 连接网络 | GAEA, 5GHz (5200MHz) |
| 眼镜 IP | 192.168.31.50 |
| PC IP | 192.168.31.209 |
| 信号 | RSSI -21 ~ -19, 极好 |
| 延时 | ping < 10ms |

**连接模式**：从 ADB 反向隧道 (`ws://127.0.0.1:19090`) 改为 LAN 直连 (`ws://192.168.31.209:8088`)。

**WiFi 稳定性**：
- Android 10+ 禁止非系统 App 调用 `setWifiEnabled()`，App 无法自行开 WiFi
- App 启动时申请 `WIFI_MODE_FULL_HIGH_PERF` WiFiLock，**锁住后熄屏不掉**
- 眼镜重启后需用 ADB 开一次 WiFi（已加入 watchdog 自动执行）
- 日常使用全程无线，只有眼镜完全断电才需重新插 USB 开 WiFi

### Phase 3（多 Agent 集成 / 生产加固）— 🔜 进行中

**Phase 3a（真实本地 Agent 会话适配层 MVP）** — ✅ 真机 E2E 通过 (2026-08-14)
- Spec: `docs/superpowers/specs/2026-08-11-claude-code-adapter-v2-design.md`
- Plan: `docs/superpowers/plans/2026-08-11-claude-code-adapter-v2-plan.md`
- 目标：Claude Code CLI → AgentBridge → 眼镜审批闭环（stream-json control 协议拦截 + 风控分级）— 已跑通，不追求通用插件生态
- E2E 四场景通过：①只读工具自动放行 ②写文件 approve 执行 ③rm reject 拒绝 ④超时 auto-allow
- 待修 bug：`docs/2026-08-14-phase3a-e2e-bugfix.md`（task_id 不一致 / Core 风险分缺口 / 30s 超时太短）

**Phase 2 刻意推迟到 Phase 3 的项目**：
- TTS 真机验证（代码已写，音频引擎初始化失败，需排查 Rokid 音频路由）
- 语音审批（依赖 TTS 可用）
- 手机端 AgentBridgeService（作为网络中枢 fallback）
- middleware-core 测试（Go 表驱动测试 for dispatcher + approval manager）
- 主动 ack 补全（当前 seq 去重已覆盖核心场景）
- 认证/安全层

**环境启动必查**：
- Core 端口 → `AGENTBRIDGE_ADDR=":8088"`（避免 NI Application Web Server 抢占 8080）
- Agent Adapter → `AGENTBRIDGE_SESSION=default`（与眼镜同 session）
- ADB 隧道 → 双设备（手机 `4EU0221B11003871` + 眼镜 `1901092534002787`）
- 连通验证 → `curl http://127.0.0.1:19090/health` 应返回 200
- 守护进程 → `scripts/tunnel-watchdog.ps1` 保持运行

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
