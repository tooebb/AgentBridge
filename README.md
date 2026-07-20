# AgentBridge

AI Agent 跨设备交互中间层 —— 让 Claude Code 等 AI Agent 在执行长时间任务时，通过手机、AR 眼镜、手表、耳机向你推送状态、请求审批，你可以在任意设备上响应，Agent 继续执行。

**首个硬件终端：Rokid Glass 3（AR 眼镜）**

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

### 验证

```bash
# 查看 Core 健康状态
curl http://localhost:8080/api/v1/health

# 查看所有 session
curl http://localhost:8080/api/v1/sessions

# 查看某 session 事件历史
curl http://localhost:8080/api/v1/events/{session_id}
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

## 当前状态 (2026-07-20)

| 模块 | 状态 | 说明 |
|------|------|------|
| Middleware Core | ✓ 完成 | 全部 6 端点 · 状态机 9 转移验证通过 |
| Agent Adapter | ✓ 完成 | Claude Code 端到端集成测试通过 |
| Web Dashboard | ✓ 完成 | 实时推送 + 历史事件 · 全事件类型展示 |
| Mock Device Client | 待开发 | 验证 Core→设备 管道（无需真机） |
| Phone App (AgentBridgeService) | 待开发 | 阻塞于无 Android 真机 |
| Glass App (AgentActionHandler) | 待开发 | 阻塞于无 Android 真机 |
| 数据库 (PostgreSQL/Redis) | 待开发 | 当前使用内存存储 |
| 认证/安全 | 待开发 | — |

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
