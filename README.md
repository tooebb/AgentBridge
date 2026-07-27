# AgentBridge

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

**首个硬件终端：Rokid Glass 3（AR 眼镜）**——AR 眼镜是最自然的"移动办公"载体：抬头即见，语音+按键交互，不打断行走。AgentBridge 首个适配的眼镜端已预留完整交互路径（TTS 播报 + 通知卡片 + 按键/语音审批）。

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
    │              (BT·Rokid SDK)
    ▼
  AR Glass ←── 用户按键/语音审批
```

## 技术栈

| 组件 | 语言 | 框架/关键库 | 协议 |
|------|------|------------|------|
| **Middleware Core** | Go 1.21+ | gorilla/websocket, chi | WSS, REST |
| **Agent Adapter** | TypeScript (Node) | child_process, ws | Stdio pipe, WSS |
| **Web Dashboard** | React 18 + TypeScript | Vite | WSS, REST |
| **Phone App** (planned) | Kotlin | OkHttp, Rokid SDK | WSS, BT |
| **Glass App** (planned) | Kotlin | GlassSdk | BT |

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
│       └── store/             # 事件存储 (内存环形缓冲 · 200 events/session)
│
├── agent-adapter/             # Node.js Agent 适配器
│   └── src/
│       ├── index.ts           # 入口 · pipeline 串联
│       ├── adapters/claude.ts # Claude Code spawn (--print --verbose stream-json)
│       ├── context/engine.ts  # 上下文引擎 (滑动窗口 5 事件 · 阶段推断)
│       ├── normalizer.ts      # 事件分类 (6 正则规则 + 上下文消歧)
│       └── ws-client.ts       # WS 客户端 (连接 Core · 自动重连)
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

### 3. 运行 Agent Adapter 集成测试

```bash
cd agent-adapter
npm install
npx tsx src/index.ts
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

# 验证 SQLite replay + last_acked_seq + 设备动作回传到 agent_adapter
cd mock-device
npm install
GO_BIN=/path/to/go npm run test:e2e
```

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

## 当前状态 (2026-07-23)

| 模块 | 状态 | 说明 |
|------|------|------|
| Middleware Core | ✓ 完成 | 全部 6 端点 · 状态机 18 转移 · forGlass 6 事件类型独立渲染 |
| Agent Adapter | ✓ 完成 | Claude Code 端到端集成测试通过 |
| Web Dashboard | ✓ 完成 | 实时推送 + 历史事件 · 全事件类型展示 |
| Mock Device Client | ✓ 完成 | phone/watch/glass/earbuds 四端模拟 · `npm run phone` 启动 |
| Glass App (WebSocket 客户端) | 待开发 | WS 直连 Core + CXR 管 install/start 生命周期 |
| Phone App (CXR 生命周期) | 待开发 | CXR-L SDK 仅用于 `appUploadAndInstall` / `appStart` |
| 数据库 (PostgreSQL/Redis) | 待开发 | 当前使用内存存储 |
| 认证/安全 | 待开发 | — |

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

## License

Private — 当前为私有仓库。
