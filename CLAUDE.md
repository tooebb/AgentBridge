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

## 当前状态 (2026-08-26)

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

### 眼镜连接模式（有线 ADB / 无线 LAN / mDNS）

眼镜 App 连 Core 有三种模式，历史演变如下。**核心教训：LAN 直连不能硬编码 PC IP**（DHCP 会漂移）。

| 模式 | 眼镜连的地址 | 依赖 | 状态 |
|------|-------------|------|------|
| ADB 反向隧道 | `ws://127.0.0.1:19090` | USB 连 PC + `adb reverse tcp:19090 tcp:8088` | ✅ Phase 2 验证过，最可靠 |
| LAN 直连（手动 IP） | `ws://<PC_IP>:8088` | 眼镜 WiFi + PC 同一网段 | ⚠️ 已被 mDNS 替代；代码保留兜底，但此 ROM `run-as` 被封，手动 IP 暂不可配置 |
| mDNS 服务发现 | 自动发现 PC IP | 同一 WiFi | ✅ 已实现（Core 广播 + NsdManager 发现 + 运行中 IP 漂移自动重发现） |

当前代码状态：Core 启动时广播 `_agentbridge._tcp`；眼镜 App 通过 NsdManager 自动发现 Core，并按 mDNS → 手动 IP → ADB 隧道降级链选择连接地址。`AgentBridgeClient.kt` 的默认值 `ws://127.0.0.1:19090` 仍保留。

**运行中重发现（2026-08-19 真机验证 ✅）**：眼镜运行中若 Core 换址/IP 漂移导致旧地址失效，`AgentBridgeClient` 用 `ReconnectTracker` 统计连续重连失败时长，超 60s 经 `Listener.onStale()` 通知 `MainViewModel`，后者拆旧 client、重置 `connectionStarted`、重跑 `startDiscovery` 重新 mDNS 发现并恢复连接。同端口重启（<60s）仍走快重连（2s→30s 退避），不触发重发现。

> 手动 IP 兜底（`scripts/set-glasses-config.ps1`）依赖 `adb run-as` 写 `shared_prefs/agent_bridge.xml`，但眼镜 ROM 把 `run-as` 一并封禁（返回 `error: closed`，同 `pm`/`dumpsys`），故该脚本在真机上不可用。降级链纯逻辑正确、单测覆盖，但实践中手动 IP 无法配置。

**踩坑（2026-08-19）**：
- PC 无线网卡 DHCP 动态，IP 会漂移（209→185），硬编码 IP 必失效。
- **不要**给 PC 网卡加静态 IP/alias 固定地址：`netsh add address` 会把 DHCP 网卡切静态并丢 DNS，导致无法联网；FlClash（TUN 模式）也会因网卡 IP 变化重连断网。
- 眼镜熄屏/重启后 WiFi 被系统关闭，需 `svc wifi enable` 开一次 + App WiFiLock 锁住。

**WiFi 硬件**：Qualcomm kiwi_v2 (WiFi 6)，网络 GAEA 5GHz。眼镜重启后需 ADB 开一次 WiFi（watchdog 自动执行）。

### Phase 3（多 Agent 集成 / 生产加固）— 🔜 进行中

**Phase 3a（真实本地 Agent 会话适配层 MVP）** — ✅ 真机 E2E 通过 (2026-08-14)
- Spec: `docs/superpowers/specs/2026-08-11-claude-code-adapter-v2-design.md`
- Plan: `docs/superpowers/plans/2026-08-11-claude-code-adapter-v2-plan.md`
- 目标：Claude Code CLI → AgentBridge → 眼镜审批闭环（stream-json control 协议拦截 + 风控分级）— 已跑通，不追求通用插件生态
- E2E 四场景通过：①只读工具自动放行 ②写文件 approve 执行 ③rm reject 拒绝 ④超时 auto-allow
- 遗留 bug 已修复（commit `db30e04`）：task_id 统一会话级（`currentTaskId`）/ Core 风险分沿用 adapter 传入值（`assessor.go`）/ 审批超时 30s→120s / 状态机 completed/failed 可复位。详见 `docs/2026-08-14-phase3a-e2e-bugfix.md`

#### 自动镜像（交互模式）

用法：先起 Core，再在 `agent-adapter/` 运行 `npm run start:relay`，然后用户终端正常运行 `claude`；高风险工具调用会通过 PreToolUse hook 自动镜像到眼镜审批。

自动镜像依赖 Claude Code hook。若以 `--bare` 或 `--settings '{"disableAllHooks":true}'` 启动 claude，hook 不加载，眼镜将不会收到审批卡片。这是 Claude Code 的 CLI 设计，非 AgentBridge 可封堵；请勿在需要眼镜监督的场景下使用这些参数。

#### 会话交接（出门 / 回家接力）

眼镜和 PC 终端轮流 resume 同一个 Claude Code 会话，实现「PC 做一半 → 出门眼镜继续 → 回家 PC 继续」。核心机制：daemon 每次 resume 时把活跃 session id 写进 `<Cwd>\.agentbridge-current-session`（`.gitignore` 已忽略），两个脚本都读它，免去手动输入完整 UUID。

| 脚本 | 作用 | 命令 |
|------|------|------|
| `scripts/start-session.ps1` | 启动眼镜 daemon，自动 resume 落盘会话（出门接力） | `.\scripts\start-session.ps1` |
| `scripts/resume-glasses.ps1` | PC 终端 resume 眼镜刚用过的会话（回家接力） | `.\scripts\resume-glasses.ps1` |

**关键约束：接力是顺序的，不是并发的。** 同一个会话的 `.jsonl` 不能被两个进程同时写。切换前必须先关掉正在 hold 该会话的进程：

- **出门接力（PC → 眼镜）**：PC 终端 Ctrl+C 关掉 `claude` → 确认 Core 仍在 `:8088` → `.\scripts\start-session.ps1` → 眼镜连上自动 resume。
- **回家接力（眼镜 → PC）**：停掉 session.js daemon → `.\scripts\resume-glasses.ps1`（自动 `claude -r <id>`）。

`start-session.ps1` 支持 `-Cwd <dir>` 指定项目目录、`-ResumeSession <id>` 显式钉住某个会话（省略则读落盘文件，再回退到该 cwd 下 mtime 最新的会话）。

**实操注意（真机验证过的坑）**：
- 两个脚本和 `.agentbridge-current-session` 都在**项目根**，不在 `agent-adapter\` 下；跑之前确认提示符停在 `...\AgentBridge-master>`。
- `start-session.ps1` 结尾会 `Set-Location` 到 `agent-adapter` 再跑 daemon，Ctrl+C 停掉后提示符**留在 `agent-adapter`**。切回 PC 先 `cd ..` 回项目根再 `resume-glasses.ps1`。
- Core 是常驻服务，跟「在哪个终端窗口启动」无关；另开窗口跑脚本不会让 Core 消失，判断标准是进程还在不在（`netstat -ano | findstr :8088`）。

**生产加固 bug 修复（2026-08-26，已提交，均无需真机，`go test ./...` 全绿）**：
- Bug B：relay 订阅 wsClient `error` 事件，Core 重启不崩溃（`agent-adapter/src/relay.ts`）
- #88：Core hub 同名设备重复注册安全覆盖，`Unregister` 改 channel 感知（`internal/ws/hub.go` + 测试）
- Bug A：Core mDNS 随 IP 漂移周期重注册（`internal/mdns/broadcaster.go` + 测试）
- #29：middleware-core 测试补全——dispatcher 6 事件类型 + approval manager 并发安全（`go test ./...` 全绿）
- #89：眼镜端重连去重 `ReconnectGuard`（onFailure+onClosed 双重连去重，`agent/ReconnectGuard.kt`）
- 条件 WakeLock：仅关键卡片（actionable/executing/rejected/alert）常亮，闲态允许熄屏（`CardStateMachine.shouldKeepScreenOn` + `MainActivity` collect `agentCard`）

**MVP 阶段已收敛（2026-08-27，同 WiFi 内闭环，不跨网络）**：

已搁置（用户决定不推进）：
- TTS 语音输出（音频引擎初始化失败，Rokid 音频路由问题）— 不再排查
- 语音审批（依赖 TTS；眼镜输出以卡片文字 + 手势为主，语音输入 STT 仍可用）
- 主动 ack 补全（seq 去重 + is_replay 已覆盖核心场景，判定不做）

Launch 阶段（跨网络）再议：
- 手机端 AgentBridgeService（作为网络中枢 fallback）
- 认证/安全层（WebSocket 鉴权，跨网络/公网时必需）

**环境启动必查（推荐一键）**：
- 冷启动：`.\scripts\start-all.ps1`（Core + STT + watchdog + session.js）；切换项目：`cd 目标项目` 后 `.\scripts\start-session.ps1`；关底座：`.\scripts\stop-core.ps1`。详见 `docs/superpowers/specs/2026-08-25-one-click-startup-design.md`。
- 日常完整流程（冷启动 + 出门/回家双向接力 + 语音/手势速查）：`docs/usage.md`。
- 手动清单（备查）：Core `AGENTBRIDGE_ADDR=":8088"` / Adapter `AGENTBRIDGE_SESSION=default` / 眼镜连接见「眼镜连接模式」/ 双设备 `4EU0221B11003871` + `1901092534002787` / watchdog `scripts\tunnel-watchdog.ps1`。

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
