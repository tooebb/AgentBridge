# AgentBridge

> 当前文档状态：2026-07-27 已按代码实现同步。`docs/superpowers/` 下的 dated spec/plan 是历史设计和执行记录；当前使用、运行与验收以本 README、`CLAUDE.md` 和 `docs/w3-integration-checklist.md` 为准。

> AI Agent 跨设备交互中间层 —— 让 Vibe Coding 不再被绑在电脑前。

### 问题

Claude Code、Codex 等 AI Agent 极大加速了开发效率，但带来了一个新的困境：**Agent 执行长任务时，人必须守在电脑旁**。构建报错要确认、数据库迁移要审批、部署要授权——一旦离开工位，Agent 就陷入长时间停滞。

现有的解决方案（Slack 通知、邮件告警）只能"看"，不能"操作"。你看到 Agent 卡住了，却没法在手机上点一下让它继续。而且 Agent 输出的日志冗长、结构化程度低，很难在手表或耳机这种小屏/无屏设备上呈现。

### 我们的方案

**AgentBridge** 是一个面向 AI Agent 的跨设备交互中间层系统。它对 Claude Code、Codex 等 Agent 产生的任务状态、执行结果、异常信息和审批请求进行结构化处理，并根据手机、智能手表、AR 眼镜、耳机等不同设备的特性及用户所处情境，自动生成适合当前终端的信息展示和交互方式。

核心思路是**三个转化**：

1. **非结构化 → 结构化**：Agent 的 stdout 流经过上下文消歧、事件分类，转化为 6 种标准事件类型（任务开始/执行中/阻塞/需审批/失败/完成），附带风险评分和可用操作列表。
2. **PC 端 → 多设备**：同一事件在不同设备上自动变换形态——眼镜上是一条语音播报 + 单击即批的卡片，手表上是聚合摘要，耳机上是简短的 TTS 播报。
3. **被动监控 → 主动交互**：不只是推送通知，用户可以在任意设备上执行批准、拒绝、暂停、继续、查看详情等操作，直接反馈给 Agent 继续执行。

### 创新点

- **设备自适应渲染**：一次事件，四端呈现。Core 的 Device Dispatcher 为每种设备生成专属的 `device_overrides`，手机收到的是卡片+按钮，眼镜收到的是 TTS 文本+快捷操作，无需客户端二次处理。
- **上下文消歧引擎**：纯关键词匹配有歧义——Agent 输出 "done" 可能是子步骤完成也可能任务结束。滑动窗口（5 条事件）+ 阶段推断，结合 strong signal 检测，显著提升分类准确率。
- **风险评估 + 移动端拦截**：累计评分模型（7 条规则，0-1.0 分），高风险操作（如 `rm -rf`、证书删除、数据库迁移）直接拦截移动端审批通道，强制用户返回 PC 确认，兼顾便捷与安全。
- **情境感知通知策略**：即时/聚合/静默三种模式，per-device 可配置。Glass 默认冷却 10 秒防打扰，Watch 默认 60 秒聚合。未来可结合头姿/佩戴状态推断用户场景自动切换。

**首个硬件终端：Rokid RG-glasses（AR 眼镜，CXR-L/CXR-S SDK）**——AR 眼镜是最自然的"移动办公"载体：抬头即见，语音+按键交互，不打断行走。AgentBridge 首个适配的眼镜端已预留完整交互路径（TTS 播报 + 通知卡片 + 按键/语音审批），眼镜直连 Core WebSocket，手机通过 CXR-L SDK 管理眼镜生命周期。

## 架构

```
AI Agent (Claude Code)
       │ stdout pipe
       ▼
┌──────────────────┐
│  Agent Adapter    │  Node.js/TS · PC 本地
│  spawn → context  │  滑动窗口消歧 · 事件分类
│  → normalize → WS │
└────────┬─────────┘
         │ UnifiedMessage (WSS)
         ▼
┌──────────────────┐
│ Middleware Core   │  Golang · 服务器
│ 状态机 → 风控     │  7 状态 · 18 转移
│ → 设备路由 → 审批 │  7 风控规则 · 5min 超时
│ → 通知引擎 → 存储 │  即时/聚合/静默策略
└────────┬─────────┘
         │ device_overrides (WSS)
    ┌────┼────┬─────┐
    ▼    ▼    ▼     ▼
  Phone Watch Glass Earbuds
              │ (WSS 直连 Core)
              ▼
         AR Glass ←── 用户按键/语音审批
              │
         Phone (CXR-L 仅管理生命周期: install + start)
```

## 技术栈

| 组件 | 语言 | 框架/关键库 | 协议 |
|------|------|------------|------|
| **Middleware Core** | Go 1.21+ | gorilla/websocket, chi | WSS, REST |
| **Agent Adapter** | TypeScript (Node) | child_process, ws | Stdio pipe, WSS |
| **Web Dashboard** | React 18 + TypeScript | Vite | WSS, REST |
| **Phone App** (planned) | Kotlin | CXR-L SDK (client-l:1.0.4) | WSS |
| **Glass App** (planned) | Kotlin | CXR-S SDK + OkHttp WS | WSS |

## 项目结构

```
agentbridge/
├── middleware-core/           # Golang 中间层核心
│   ├── cmd/server/main.go     # 入口 · 6 REST/WS 端点
│   └── internal/
│       ├── domain/types.go    # 领域模型 (6 事件类型 · 7 状态 · 统一消息)
│       ├── statemachine/      # 状态机 (IDLE→STARTING→...→COMPLETED)
│       ├── risk/assessor.go   # 风控引擎 (7 规则 · 0-1.0 累计评分)
│       ├── approval/          # 审批管理 (生命周期 · 5min 超时 · 3 次重试)
│       ├── notify/            # 通知引擎 (即时/聚合/静默 · per-device 策略)
│       ├── device/            # 设备路由 (phone/watch/glass/earbuds 格式转换)
│       ├── ws/                # WebSocket Hub · session 管理 · dashboard 广播
│       └── store/             # 事件存储 (内存环形缓冲 · 可选 SQLite ack/replay)
│
├── agent-adapter/             # Node.js Agent 适配器
│   └── src/
│       ├── index.ts           # 入口 · AgentHub + Core WebSocket 串联
│       ├── hub.ts             # provider 选择和降级链
│       ├── adapters/          # claude-api/openai-compatible/generic-cli/claude-cli
│       ├── context/engine.ts  # 上下文引擎 (滑动窗口 5 事件 · 阶段推断)
│       ├── normalizer.ts      # AgentEvent 直接映射 + legacy raw output 分类
│       └── ws-client.ts       # WS 客户端 (连接 Core · 自动重连)
│
├── rokid-sdk/                 # Rokid 示例工程源码
│   ├── CXRLSample/            # 手机端 CXR-L 控制面样例
│   └── cxrssample/cxrswithcxrl/
│       └── app/src/main/java/com/rokid/cxrswithcxrl/
│           ├── agent/         # 眼镜端 AgentBridge WS、协议、卡片和动作处理
│           ├── activities/    # CustomApp 入口 Activity/ViewModel
│           └── receiver/      # 眼镜按键广播
│
└── dashboard/                 # React Web 监控面板
    └── src/
        ├── App.tsx            # 3 栏布局 · 历史+实时事件合并去重
        ├── hooks/             # useWebSocket · useSessions · useEventHistory
        └── components/        # Header · SessionList · EventTimeline · EventBadge
```

## 快速开始

### 前置条件

- Go 1.21+
- Node.js 18+
- (Windows) Git Bash — Claude Code 依赖 `CLAUDE_CODE_GIT_BASH_PATH`

### 1. 启动 Middleware Core

```bash
cd middleware-core
go mod tidy
go run cmd/server/main.go
# 监听 :8080，输出 "Server starting on :8080"
```

可选环境变量：

```bash
AGENTBRIDGE_ADDR=127.0.0.1:18080              # 覆盖默认监听地址 :8080
AGENTBRIDGE_EVENT_DB=/tmp/agentbridge.db      # 启用 SQLite 事件持久化和重连补发
```

### 2. 启动 Dashboard（可选）

```bash
cd dashboard
npm install
npm run dev
# 监听 :5173，Vite 代理 /api 和 /ws 到 Core
# 浏览器打开 http://localhost:5173
```

### 3. 运行 Agent Adapter

```bash
cd agent-adapter
npm install
npm run dev
# 连接到 Core，spawn Claude Code，发送事件
# Dashboard 可实时看到事件流
```

Agent Adapter 默认按 `claude-api` → `openai-compatible` → `generic-cli` → `claude-cli` 顺序选择可用适配器，也可以通过 `AGENTBRIDGE_AGENT` 指定：

```bash
# Claude API
ANTHROPIC_API_KEY=... AGENTBRIDGE_AGENT=claude-api npm run dev

# Claude Code / ccswitch / 其他兼容 CLI 包装器
AGENTBRIDGE_AGENT=generic-cli \
AGENTBRIDGE_AGENT_CMD=ccswitch \
AGENTBRIDGE_AGENT_ARGS='["--print","--output-format","stream-json","{prompt}"]' \
npm run dev

# OpenAI-compatible endpoint，例如 DeepSeek / OpenRouter / 本地兼容服务
AGENTBRIDGE_AGENT=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=https://api.example.com/v1 \
OPENAI_COMPATIBLE_API_KEY=... \
OPENAI_COMPATIBLE_MODEL=deepseek-v4-pro \
npm run dev
```

`generic-cli` 支持 `AGENTBRIDGE_AGENT_ENV` 传入 JSON 环境变量；`AGENTBRIDGE_AGENT_ARGS` 支持 JSON 字符串数组，参数内的 `{prompt}` 会被替换为初始任务提示。第一阶段 OpenAI-compatible 只实现最小文本调用和设备动作续写，复杂 tool calling / 流式输出 / 供应商差异适配后续单独扩展。

### 验证

```bash
# 查看 Core 健康状态
curl http://localhost:8080/health

# 查看所有 session
curl http://localhost:8080/api/v1/sessions

# 查看某 session 事件历史
curl http://localhost:8080/api/v1/events/{session_id}

# 验证 Phone/Glass 客户端 ack、去重和动作回传状态层
cd mock-device
npm install
npm run test:state

# 验证 SQLite replay + last_acked_seq + 设备动作回传到 agent_adapter
cd mock-device
npm run test:e2e
```

### Rokid Glass 客户端开发构建

眼镜端最小客户端位于 `rokid-sdk/cxrssample/cxrswithcxrl`，当前实现包括：

- `agent/AgentBridgeProtocol.kt`：对齐 Core JSON 字段的 Kotlin data class。
- `agent/AgentBridgeClient.kt`：OkHttp WebSocket、`last_acked_seq` 持久化、去重和 2s/4s/8s/30s 重连。
- `agent/AgentActionHandler.kt`：卡片状态、TTS 播报和按键动作路由。
- `agent/CardRenderer.kt`：Compose 状态卡片、审批卡片和调试状态行。
- `activities/main/MainViewModel.kt` / `MainActivity.kt`：启动 WS 客户端并接入现有按键广播。

开发阶段 Core 地址硬编码在 `AgentBridgeClient.DEFAULT_SERVER_URL`：

```kotlin
const val DEFAULT_SERVER_URL = "ws://192.168.1.100:8080"
const val DEFAULT_SESSION_ID = "default"
```

现场联调前需要把 `192.168.1.100` 改成 Core 所在电脑的局域网 IP，并确保 Core 使用 `AGENTBRIDGE_ADDR=0.0.0.0:8080` 启动。Android debug 包构建命令：

```bash
cd rokid-sdk/cxrssample/cxrswithcxrl
chmod +x gradlew
./gradlew :app:assembleDebug
```

生成的 APK 路径为 `app/build/outputs/apk/debug/app-debug.apk`，可通过手机端 CXR-L 样例的 CustomApp 安装/启动流程推送到眼镜。

### Phone / Glass 协议对齐

设备端 WebSocket 统一连接：

```bash
ws://<core-host>/ws/{session_id}?device_type=phone
ws://<core-host>/ws/{session_id}?device_type=ar_glasses
```

Phone/Glass 客户端需要维护本地 `last_acked_seq`。每次接受 `server_to_client` 消息后，若存在 `seq`，客户端应先按 `seq` 去重，再把本地 ack 更新为最大已处理序号；重连时带上 `last_acked_seq` 查询参数，Core 会补发之后的消息并标记 `is_replay=true`。设备动作回传也应带 `last_acked_seq`，并可在 `action.text` 中携带语音/文本输入：

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
    "text": "approved from glasses"
  }
}
```

`mock-device` 已按这套规则实现 Phone/Glass 行为：自动维护 ack、重连时请求 replay、忽略重复 `seq`、展示 live/replay 状态，并在 approve/reject/continue/pause/view_details 回传中携带最新 `last_acked_seq`。可用以下命令做本地验证：

```bash
cd mock-device
npm run test:state
npm run phone
npm run glass
```

### W3 实机闭环联调准备

进入真实 W3 眼镜联调前，先执行模拟 readiness 检查：

```bash
# 先启动 Core，再运行
cd mock-device
SERVER=http://127.0.0.1:8080 npm run test:w3
```

该脚本模拟 `ar_glasses` 客户端，验证眼镜端审批消息、TTS/屏显 overrides、按键/语音 approve 回传、`agent_adapter` relay、以及断连重连后的 `last_acked_seq` 补发。完整实机验收清单见 `docs/w3-integration-checklist.md`。

进入真实 W3/手机联调前，可先跑主机预检：

```bash
cd mock-device
SERVER=http://127.0.0.1:8080 npm run w3:preflight
```

预检会串联 Node/依赖/Core health/模拟 W3 readiness，并检查当前主机是否能通过 `adb devices` 看到设备。仓库自测模式下没有 `adb` 或没有设备只会提示 WARN；现场联调时使用 `W3_REQUIRE_DEVICE=1`，看不到 `state=device` 的 W3/手机设备会直接失败。

## 事件类型 & 状态机

### 6 种事件类型

| 事件 | 说明 |
|------|------|
| `task_started` | 任务开始 |
| `task_running` | 执行中（默认分类） |
| `task_blocked` | 阻塞/超时 |
| `needs_approval` | 需要用户审批 |
| `task_failed` | 执行失败 |
| `task_completed` | 执行完成 |

### 状态转移

```
IDLE → STARTING → RUNNING ⇄ BLOCKED
                    ↓  ↘    ↗
              AWAITING_APPROVAL → RUNNING
                    ↓
                FAILED · FAILED_TIMEOUT
                    ↓
              COMPLETED（终态）
```

共 7 个状态，18 条合法转移路径。

## 风控规则

| 规则 | 风险分 | 拦截移动端 |
|------|--------|-----------|
| 删除证书文件 (.key/.pem/.crt) | 0.8 | ✓ |
| 危险操作 (rm -rf / DROP TABLE / force push / terraform destroy) | 0.9 | ✓ |
| 部署发布 (deploy / publish / release / npm publish) | 0.6 | ✓ |
| 数据库迁移 (migrate / alembic / flyway) | 0.7 | ✓ |
| Shell 命令执行 | 0.2 | — |
| 认证变更 | 0.5 | — |
| 删除普通文件 | 0.2 | — |

- **低风险** (<0.3)：单击即批
- **中风险** (0.3–0.7)：需确认审批
- **高风险** (≥0.7 或 blockOnMobile)：仅可在 PC 端审批

## 当前状态 (2026-07-27)

| 模块 | 状态 | 说明 |
|------|------|------|
| Middleware Core | 已实现 | REST/WS 端点、状态机、风控、审批、通知策略、设备分发、Dashboard 广播、事件历史 |
| Event Store | 已实现 | 默认内存环形缓冲；`AGENTBRIDGE_EVENT_DB` 启用 SQLite 持久化、`seq`、`last_acked_seq` 和重连补发 |
| Agent Adapter | 已实现 | `claude-api` / `openai-compatible` / `generic-cli` / `claude-cli` provider 选择，设备动作可 relay 回 agent |
| Web Dashboard | 已实现 | session 列表、历史事件、实时事件流、事件类型展示 |
| Mock Device Client | 已实现 | phone/watch/glass/earbuds 四端模拟；ack、replay、approve/reject/continue/pause/view_details 回传 |
| W3 模拟联调 | 已实现 | `npm run test:w3` 和 `npm run w3:preflight` 覆盖 W3 协议 readiness |
| Glass App (真实客户端) | 开发中 | 眼镜端 OkHttp WS 客户端、TTS、卡片渲染、按键回传已落在 `rokid-sdk/cxrssample/cxrswithcxrl`；待 Android 环境编译和真机验收 |
| Phone App (真实客户端) | 待开发 | CXR-L SDK 仅用于 `appUploadAndInstall` / `appStart` 生命周期管理 |
| 认证/安全 | 待开发 | 当前未实现 API key/JWT/设备授权 |

### superpowers 历史计划对照

`docs/superpowers/` 下的 2026-07-26 spec/plan 是历史设计和执行记录，其中大部分核心目标已经落地，但部分文件路径和实现方式被后续实现调整过：

| 历史目标 | 当前状态 |
|----------|----------|
| SQLite 持久化、`seq`、`last_acked_seq`、重连补发 | 已完成；落地在 `middleware-core/internal/store/eventstore.go`，通过 `AGENTBRIDGE_EVENT_DB` 启用 |
| Claude API 主路径 + CLI fallback | 已完成；同时补了 `openai-compatible` 和 `generic-cli` |
| Agent Adapter 统一接口与 AgentHub | 已完成 |
| Mock Device 断连补发/动作回传验证 | 已完成；实际文件是 `mock-device/e2e-replay-action-test.js` 和 `device-session.js` |
| Phone/Glass 协议对齐 | 仓库内 mock-device 状态层已完成；眼镜端 Kotlin 客户端已按同一协议实现，手机端配置入口后续补齐 |
| W3 实机闭环 | 仓库内 readiness、preflight 和文档清单已完成；真实设备现场联调仍待执行 |
| PostgreSQL/Redis、完整认证安全、通用模型 provider runtime | 未作为当前切片实现；保留为后续生产化规划 |

### CXR-L SDK 联调（设备：华为 NOP_AN00 + Rokid RG-glasses）

| 功能 | 状态 | 说明 |
|------|------|------|
| CustomView | ✅ 通过 | 手机 JSON 布局 → 眼镜渲染 |
| CustomApp 安装 | ✅ 通过 | `appUploadAndInstall` 成功（WiFi 必须空闲） |
| CustomApp 启动 | ✅ 通过 | `appStart` → `onOpenAppResult: true` |
| 眼镜→手机 (sendMessage) | ✅ 通过 | 按键事件回传正常，走 Notify 协议 |
| 手机→眼镜 (sendCustomCmd) | ❌ 放弃 | `cxrservice` 路由为 ShortMessage 类型，不转发到 CustomApp 订阅回调，闭源无法修复 |

### 眼镜数据通道：最终方案

**CXR Caps 全双工（方案 A）→ 已放弃**。`sendCustomCmd`（ShortMessage）与 `sendMessage`（Notify）走不同协议路径，前者不被路由到应用层。

**WebSocket 直连 + CXR 仅管生命周期（方案 B）**：
- CXR 负责：应用安装与启动（已确认可用）
- WebSocket 负责：Core ↔ 眼镜所有数据通信
- 协议：标准 JSON，与 Dashboard / Mock Device 同一套
- 眼镜端：OkHttp WS 客户端连接 `ws://<PC-IP>:8080/ws/{sessionID}?device_type=ar_glasses`
- 本仓库当前完成 Core 协议、mock-device 模拟、联调清单和眼镜端 MVP 客户端代码；真实设备编译安装与现场验收仍待执行。

## 设备通知策略

| 设备 | 默认策略 | 最低级别 | 允许操作 |
|------|---------|---------|---------|
| Phone | 即时 | info | ✓ |
| Watch | 聚合 (60s) | warning | — |
| Glass | 即时 (冷却 10s) | info | ✓ |
| Earbuds | 即时 | warning | — |

## 相关文档

- [架构设计方案](docs/architecture.md) — 完整设计文档（13 章节）
- [业务需求](docs/requirements.md) — 产品需求说明
- [W3 实机闭环联调清单](docs/w3-integration-checklist.md) — W3 接入前置检查、协议要求和验收标准
- `docs/superpowers/` — 2026-07-26 设计/计划归档，保留作历史记录，不作为当前运行说明

## License

Private — 当前为私有仓库。
