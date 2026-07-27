# AI Agent 跨设备交互中间层 — 架构设计方案

> **项目代号**：AgentBridge
> **MVP 目标**：4-6 周
> **首个硬件终端**：Rokid Glass 3（AR 眼镜）
> **参考对比**：GPT 提供的架构骨架（6 层模型）→ 融合优化为当前方案
> **当前文档状态**：2026-07-27 已按仓库实现同步；生产化规划与真实 Phone/Glass 客户端实现明确标注为后续工作。

---

## 1. 整体架构

```
                     +----------------------------+
                     |     AI Agent (PC)           |
                     |   Claude Code / Codex       |
                     +-------------+--------------+
                                   |
                      Hooks API / stdout pipe
                                   |
                     +-------------v--------------+
                     |      AGENT ADAPTER           |  Node.js/TS，跑在 PC
                     |  ┌───────────────────────┐  |
                     |  │ Agent Connector        │  |  可插拔适配器
                     |  │ (claude/codex spawn)   │  |
                     |  └───────────┬───────────┘  |
                     |              │ raw output    |
                     |  ┌───────────v───────────┐  |
                     |  │ Context Engine          │  |  上下文窗口（最近 N 条）
                     |  │ (消歧 & 关联)           │  |
                     |  └───────────┬───────────┘  |
                     |              │ context-aware |
                     |  ┌───────────v───────────┐  |
                     |  │ Event Normalization     │  |  正则+关键词+上下文
                     |  │ (RawOutput → UnifiedMsg) │  |  生成统一事件
                     |  └───────────┬───────────┘  |
                     +--------------+--------------+
                                    |
                         UnifiedMessage (JSON)
                                    |
                     +--------------v--------------+
                     |       MIDDLEWARE CORE         |  Golang，跑在服务器
                     |  ┌─────────────────────────┐ |
                     |  │      Event Pipeline      │ |
                     |  │  +---------------------+ │ |
                     |  │  │    State Machine    │ │ |
                     |  │  +---------+-----------+ │ |
                     |  │            │             │ |
                     |  │  +---------v-----------+ │ |
                     |  │  │   Risk Assessor     │ │ |
                     |  │  +---------+-----------+ │ |
                     |  │            │             │ |
                     |  │  +---------v-----------+ │ |
                     |  │  │   Device Dispatcher │ │ |
                     |  │  +---------+-----------+ │ |
                     |  │            │             │ |
                     |  │  +---------v-----------+ │ |
                     |  │  │   Approval Manager  │ │ |
                     |  │  │ (超时/重试/生命周期) │ │ |
                     |  │  +---------+-----------+ │ |
                     |  │            │             │ |
                     |  │  +---------v-----------+ │ |
                     |  │  │ Notification Engine │ │ |
                     |  │  │ (策略: 即时/聚合/静默)│ │ |
                     |  │  +---------------------+ │ |
                     |  └─────────────────────────┘ |
                     +--------------+--------------+
                                    |
                             wss:// (WebSocket)
                     +----------+-------+--------+
                     |          |       |        |
                Phone(Android) Phone(PWA) Watch  Earbuds(BLE)
                     |          |       |        |
               BT+P2P(Rokid SDK) |       |        |
                     |           |       |        |
                 AR Glass        |       |        |
                                 |       |        |
            USER ACTIONS <-------+-------+--------+
            (approve/reject/pause/continue via same WSS channel)
```

### 数据流（完整闭环场景）

```
PC Agent stdout
  → AgentAdapter 采集原始输出
  → Context Engine（滑动窗口消歧，"done"是子任务还是整体？）
  → Event Normalization（正则+上下文 → UnifiedMessage）
  → WebSocket → Core
  → State Machine 状态转移
  → Risk Assessor 计算风险分 + 移动端拦截判断
  → Device Dispatcher 生成各端 device_overrides
  → Notification Engine（决定推送策略：即时/聚合/静默）
  → WebSocket → Phone
  → BT CustomMessage → Glass → TTS + 通知卡片
    用户按键(approve) → Glass → BT → Phone → WebSocket
  → Core → Approval Manager（记录审批结果）→ ActionRouter
  → AgentAdapter → stdin → Agent 继续执行
```

### 与 GPT 架构的对比与融合

| 维度 | GPT 方案 | 本方案 | 融合结果 |
|------|---------|--------|---------|
| 分层数 | 6 层 | 4 层 | 保持 4 层，模块内聚 |
| Event Normalization | 独立一层 | 放在 Agent Adapter 内 | 采用 GPT 的独立性，放到 Adapter 作为独立 Pipeline Stage |
| Context Engine | 有 | 无 | **新增**，放在 Adapter 内，Normalization 之前 |
| Approval Manager | 独立模块 | 分散在状态机+风控 | **新增独立模块**，管理审批生命周期 |
| Notification Engine | 独立模块 | 分散在 DeviceRouter | **新增独立模块**，管理推送策略 |
| Device SDK Layer | 独立一层 | 合并在 Device Adapter | 保持现有，Phone/Glass SDK 调用封装在客户端 |

---

## 2. 技术栈

| 组件 | 语言 | 框架/库 | 协议 | 存储 |
|------|------|---------|------|------|
| Middleware Core | **Golang** | gorilla/websocket + chi router | WSS, HTTPS REST | 内存 EventStore；可选 SQLite |
| Agent Adapter | **Node.js/TS** | Anthropic SDK, child_process, ws | REST/WS, stdio | 无（无状态） |
| Phone（改造已有） | **Kotlin** | OkHttp, PSecuritySDK | WSS, BT, P2P | SQLite（离线队列） |
| Glass（改造已有） | **Kotlin** | GlassSdk | BT | SharedPreferences |
| Web Dashboard | **React/TS** | React 18 + Vite | WSS, REST | 无 |

### 选型理由

- **Golang 做 Core**：goroutine 天然适合 "一个 session 一个 goroutine" 的并发模型；类型安全保护状态机正确性；编译为单二进制，部署简单
- **Node.js 做 Adapter**：LLM CLI 工具（claude/codex）的 `child_process.spawn` + `readline` 是最自然的接口；TypeScript 的类型系统足够 Adapter 层的复杂度
- **WebSocket 不做 MQTT/gRPC**：浏览器/手机/Node.js 都原生支持 WebSocket，不需要额外 broker；gRPC-web 移动端支持差需要 Envoy 代理；跨实例 pub/sub 后续可用 Redis 等基础设施补充
- **当前存储实现**：默认内存环形缓冲；设置 `AGENTBRIDGE_EVENT_DB` 后使用 SQLite 保存事件和设备 ack，支持断连重连后的 `last_acked_seq` 补发。
- **生产化存储规划**：PostgreSQL/Redis 仍可作为后续审计、跨实例队列和在线状态方案，但不是当前仓库实现。

---

## 3. 核心领域模型

### 3.1 事件类型（6 个公开任务事件 + 2 个内部管理事件）

```go
EventTaskStarted   = "task_started"     // 任务开始
EventTaskRunning   = "task_running"     // 执行中（心跳/默认降级）
EventTaskBlocked   = "task_blocked"     // 阻塞（超时/卡住/无输出）
EventNeedsApproval = "needs_approval"   // 需要用户审批
EventTaskFailed    = "task_failed"      // 失败
EventTaskCompleted = "task_completed"   // 完成
EventHeartbeat     = "heartbeat"        // 会话保活（内部）
EventUserAction    = "user_action"      // 用户操作响应（内部）
```

### 3.2 统一消息（UnifiedMessage）

```go
type UnifiedMessage struct {
    ID               string                 `json:"id"`
    TaskID           string                 `json:"task_id"`
    SessionID        string                 `json:"session_id"`
    EventType        EventType              `json:"event_type"`
    Title            string                 `json:"title"`          // 单行摘要（≤60 字符）
    Body             string                 `json:"body"`           // 详细内容（≤500 字符）
    Severity         Severity               `json:"severity"`       // info | warning | critical
    RiskScore        float64                `json:"risk_score"`     // 0.0 - 1.0
    RiskBlocked      bool                   `json:"risk_blocked"`   // 移动端是否拦截
    AvailableActions []AvailableAction      `json:"available_actions"`
    Timestamp        time.Time              `json:"timestamp"`
    AgentID          string                 `json:"agent_id"`
    RawEvidence      *RawEvidence           `json:"raw_evidence,omitempty"` // 跳转到原始日志
}
```

### 3.3 通信 Wire Format（WebSocket JSON）

```
Server → Client：
{
  direction: "server_to_client",
  message_id, session_id, seq, is_replay, timestamp,
  event: { type, task_id, title, body, severity, risk_score, available_actions },
  device_overrides: {
    ar_glasses:  { tts_text, card_title, card_body, quick_actions },
    phone:       { card: { title, body, actions } },
    smartwatch:  { card_title, card_body, quick_actions },
    earbuds:     { tts_text }
  }
}

Client → Server：
{
  direction: "client_to_server",
  session_id, task_id, last_acked_seq,
  action: { type: "approve"|"reject"|"continue"|"pause"|"view_details", device_type, timestamp, text? }
}
```

**为什么 device_overrides 由服务端生成？** 每个设备的能力差异在服务端统一处理，新增设备类型无需客户端更新。客户端只拿自己对应 key 的数据即可。

**可靠性字段说明**：`seq` 是 Core 对每个 session 写入 EventStore 时生成的单调序号；客户端处理后维护 `last_acked_seq`，重连时携带该值，Core 会补发之后的事件并设置 `is_replay=true`。`action.text` 用于按键动作之外的语音/文本输入预留。

---

## 4. 状态机

```
IDLE ─(start)─→ STARTING ─(first_output)─→ RUNNING
                     │                          │
                (failure)              (blocked/needs_approval)
                     │                   ↙              ↘
                     v          BLOCKED                  AWAITING_APPROVAL
                  FAILED      (timeout 5min)          (approve)↙  ↘(reject)
                     ↑              ↓               RUNNING        RUNNING
                                  FAILED_TIMEOUT
RUNNING ─(completion)─→ COMPLETED（终态）
```

**无效转移直接拒绝并记录日志**，防止状态混乱。

---

## 5. Event Normalization（Agent Adapter 内）

**为什么放在 Adapter 而非 Core？** 事件分类本质是"理解 Agent 语义"，靠近 Agent 输出端更合理。Core 只接收已分类的 UnifiedMessage，不关心原始文本解析。

按优先级匹配（正则 + 关键词 + Context Engine 上下文），首个命中即分类：

| 优先级 | 事件类型 | 匹配规则 | 上下文加成 |
|--------|----------|----------|-----------|
| 1 | needs_approval | `approval required\|confirm?\|are you sure` | 前序是 shell/文件操作 |
| 2 | task_failed | `Error:\|FAILED\|FATAL\|exit code [1-9]` | 连续 3+ 条错误提高置信度 |
| 3 | task_blocked | `stuck\|blocked\|timeout\|cannot proceed` | 超过 2 分钟无新输出 |
| 4 | task_completed | `completed\|finished\|done\|build successful` | 前序是任务执行中 |
| 5 | task_started | `starting task\|launching\|beginning` | session 刚创建 |
| 6 | task_running | 默认降级（所有未匹配的输出） | — |

**实现位置**：`agent-adapter/src/normalizer.ts`

---

## 6. Context Engine（Agent Adapter 内）

**为什么需要？** 纯关键词分类存在歧义——Agent 输出 "done" 可能是子步骤完成，也可能是整个任务完成。上下文滑动窗口提供消歧依据。

```typescript
class ContextEngine {
  private window: RawEvent[] = [];      // 最近 5 条
  private maxWindowSize = 5;

  push(event: RawEvent): void { /* 维护滑动窗口 */ }

  getContext(): Context {
    return {
      recentOutputs:         // 最近输出文本（截断 200 字符）
      recentEventTypes:      // 最近分类结果
      timeSinceLastOutput:   // 距上次输出的时间间隔
      consecutiveErrors:     // 连续错误计数
      currentTaskPhase:      // 推断当前阶段 'init'|'executing'|'cleanup'
    };
  }
}
```

**消歧规则示例**：
- "done" 前 3 条有 `npm run build` → `task_completed`
- "done" 前 3 条有 `Starting task` → 可能是子步骤，降级为 `task_running`
- 连续 3 条 `task_failed` → 确认失败，提高置信度
- 超过 2 分钟无输出 + 当前非完成态 → `task_blocked`

---

## 7. Approval Manager（Core 内）

**为什么独立？** 审批涉及超时、重试、委派、过期等生命周期管理，分散在状态机和风控里会导致代码膨胀。

```go
type ApprovalManager struct {
    pendingApprovals map[string]*Approval
}

type Approval struct {
    ID            string
    TaskID        string
    Status        ApprovalStatus  // pending | approved | rejected | expired
    RiskScore     float64
    TimeoutAt     time.Time       // 默认创建后 5 分钟
    RetryCount    int             // 离线重试计数（最大 3 次）
    DeviceHistory []ApprovalAttempt
}
```

**生命周期**：
```
创建 → PENDING ─(超时 5min)→ EXPIRED（通知 PC：用户不可达）
       │
       ├─(用户 approve)→ APPROVED → 执行
       └─(用户 reject) → REJECTED → 回退
```

**重试策略**：
- 手机离线：当前通过 EventStore 记录 `seq` 和设备 `last_acked_seq`，设备重连后补发未确认事件；跨实例队列属于后续生产化规划
- 最多重试 3 次，间隔递增：1min → 3min → 5min
- 全部失败 → 标记 EXPIRED

---

## 8. Notification Engine（Core 内）

**为什么需要？** 不是每个事件都应该立刻推送到设备。需要聚合重复心跳、过滤低严重度事件、根据用户情境调整策略。

```go
type NotificationPolicy struct {
    Mode            string   // "instant" | "aggregated" | "quiet"
    AggInterval     int      // 聚合间隔（秒）
    MinSeverity     Severity // 低于此级别的静默
    AllowActions    bool     // 是否允许设备端交互操作
    CooldownSeconds int      // 同类事件冷却（秒）
}
```

**默认策略**：

| 设备 | 模式 | 最低严重度 | 允许操作 | 冷却 |
|------|------|-----------|---------|------|
| Phone | instant | info | Y | — |
| Watch | aggregated | warning | N | 60s |
| Glass | instant | info | Y | 10s |
| Earbuds | instant | warning | N | — |

**聚合规则**：
- 同一 task 的连续 `task_running` → 每 60s 最多推一次
- `task_completed` / `task_failed` → 始终即时推送（不可聚合）
- 用户处于通勤/运动状态（Glass 佩戴检测 + 头姿追踪）→ 自动切换 aggregated 模式

---

## 9. 风险评估引擎（Core 内）

累积评分，`blockOnMobile` 直接拒绝移动端审批：

| 规则 | 风险分 | 拦截移动端 | 示例 |
|------|--------|-----------|------|
| 删除证书文件（.key/.pem/.crt） | 0.8 | Y | `rm src/certs/prod.key` |
| 破坏性命令 | 0.9 | Y | `rm -rf /`, `DROP TABLE`, `git push --force`, `terraform destroy` |
| 远程部署/发布 | 0.6 | Y | `deploy`, `npm publish`, `git push --tags` |
| 数据库迁移 | 0.7 | Y | `prisma migrate`, `alembic upgrade`, `flyway migrate` |
| 认证/权限变更 | 0.5 | N | 修改 JWT secret、更改 IAM 策略 |
| 删除普通文件 | 0.2 | N | 删除未引用的代码文件 |
| Shell 命令执行 | 0.2 | N | 常规 `npm test`, `cargo build` |

**交互分级**：
- **低风险（< 0.3）**：单击立即批准，无需二次确认
- **中风险（0.3 - 0.7）**：需确认的审批
- **高风险（≥ 0.7）**：移动端显示"返回 PC 确认"，Device Dispatcher 不生成可操作按钮

---

## 10. 存储设计

### 当前实现：内存 + SQLite

| 表 | 用途 | 关键字段 |
|----|------|---------|
| events | 事件历史和 replay | session_id, seq, message_id, raw_json, created_at |
| device_acks | 设备确认位点 | session_id, device_type, last_acked_seq, updated_at |

默认 `store.NewEventStore(200)` 使用每 session 最多 200 条事件的内存环形缓冲。设置 `AGENTBRIDGE_EVENT_DB=/path/to/events.db` 后，`store.NewSQLiteEventStore` 会创建上述 SQLite 表，并在设备连接时按 `last_acked_seq` 查询补发消息。

与 2026-07-26 历史计划相比，当前实现没有新增 `store/sqlite/` 子包、独立 Store 接口或 approvals SQLite 表；SQLite 先服务于事件历史、设备 ack 和 replay 闭环。审批记录仍由当前进程内的 `approval.Manager` 管理，持久化审计留给后续生产化切片。

### 生产化规划：PostgreSQL（持久化，审计用）

| 表 | 用途 | 关键字段 |
|----|------|---------|
| users | 用户 | api_key_hash, created_at |
| sessions | Agent 会话 | agent_type, current_state, pc_hostname, started_at |
| tasks | 子任务 | session_id→, parent_task_id→, title, state, risk_score |
| events | 事件日志 | session_id→, task_id→, event_type, unified_message(JSONB) |
| user_actions | 操作审计 | task_id→, event_id→, action_type, device_type |
| device_sessions | 设备连接 | session_id→, device_type, connection_state, last_seen |
| approvals | 审批记录 | task_id→, status, risk_score, timeout_at, retry_count |

### 生产化规划：Redis（热路径，低延迟）

| Key Pattern | 用途 | TTL |
|-------------|------|-----|
| `session:{id}:state` | 当前会话状态 | 24h after end |
| `session:{id}:devices` | 已连接设备集合 | session 期间 |
| `session:{id}:event_queue` | 离线事件队列（Sorted Set by timestamp） | 1h |
| `user:{id}:presence` | 用户主设备类型 | 5min 心跳 |
| `pubsub:events` | 跨实例事件广播 | N/A |

---

## 11. 安全设计

当前仓库尚未实现本节能力；以下是生产化设计目标。

- **认证流程**：API Key（bcrypt 存）→ 换取 JWT（PC 8h / 设备 24h）
- **设备授权**：Device JWT 仅限所属 session，操作只能响应对应事件（防重放）
- **传输加密**：WSS + TLS 1.3 全链路；Glass ↔ Phone 走 BT（Rokid SDK 底层已加密）
- **数据隔离**：Session ID 用 UUID v4（不可枚举），严格按 session 隔离
- **速率限制**：每设备每秒最多 10 个操作

---

## 12. Rokid Glass 集成方案

### 12.1 思路

不重写眼镜端，在已有 Demo 基础上最小化改动：

```
Middleware Core ← WSS → Phone App（加 AgentBridgeService）
                            ↕ BT + P2P（已有 Rokid SDK）
                        Glass App（加 AgentActionHandler）
```

### 12.2 Phone App 改动（glass3sdkphonedemo）

| 文件 | 操作 | 内容 |
|------|------|------|
| `agent/AgentBridgeService.kt` | **新建** | WebSocket 客户端 + BT 消息转发 + Action 回传 |
| `data/ProjectBusinessType.kt` | 修改 | 新增 `AGENT_TTS`, `AGENT_ACTION`, `AGENT_NOTIFICATION` |
| `DeviceLinkerManager.kt` | 修改 | messageListener 扩展，解析 `AGENT_ACTION` 类型 |
| `AndroidManifest.xml` | 修改 | 注册 AgentBridgeService（前台服务） |

### 12.3 Glass App 改动（glassdemo）

| 文件 | 操作 | 内容 |
|------|------|------|
| `agent/AgentActionHandler.kt` | **新建** | TTS 播放 + 通知展示 + 按键映射 + 语音命令 |
| `GlassesButtonReceiver.kt` | 修改 | 单击 → agent approve，双击 → agent reject |
| `MessageReceiveActivity.kt` | 修改 | 解析 `AGENT_TTS` / `AGENT_NOTIFICATION` 消息类型 |
| `SendMessageActivity.kt` | 修改 | 注册离线语音命令 "approve" / "reject" |

---

## 13. 开发路线图（6 周）

| 周 | 目标 | 关键产出 |
|----|------|---------|
| **W1** | 基础 & Agent 接入 | Core 骨架 + Claude Code Adapter + Event Normalizer + Context Engine + 状态机 |
| **W2** | 设备适配 & 手机集成 | Device Adapter + Notification Engine + Phone App AgentBridgeService |
| **W3** | Glass 端到端闭环 | Glass App 改造 + 按键/语音反馈 + 完整审批闭环测试 |
| **W4** | 风控 & 审批 & 容错 | Risk Assessor + Approval Manager + 离线重连 + 移动端拦截 |
| **W5** | Dashboard & 打磨 | React 监控面板 + 性能优化 + 边缘场景覆盖 |
| **W6** | MVP 交付 | 文档 + Demo 环境 + 演示数据 |

---

## 14. 关键决策记录

| # | 决策 | 选择 | 原因 |
|----|------|------|------|
| 1 | Core 语言 | **Golang** | goroutine 并发模型天然适合 WebSocket Hub；类型安全保护状态机 |
| 2 | 通信协议 | **WebSocket** | 全端原生，双向低延迟，无额外 broker 依赖 |
| 3 | Glass 数据通道 | **WebSocket 直连 Core，CXR 仅管生命周期** | `sendCustomCmd` 已确认无法稳定进入 CustomApp 订阅回调，数据面改走标准 WS |
| 4 | 设备转换 | **服务端生成 device_overrides** | 减少终端功耗，新设备零客户端更新 |
| 5 | TTS/ASR | **手机本地 TTS + Glass 离线命令** | 不依赖 Rokid AK/SK（待商务获取），MVP 可用 |
| 6 | Agent Adapter 部署 | **PC 本地** | 低延迟，与 Agent 同进程组；未来可迁云 |
| 7 | Event Normalization | **放 Agent Adapter 内** | "理解语义"靠近数据源，Core 只处理已分类消息 |
| 8 | Context Engine | **独立模块（新增）** | 消歧"done"等模糊输出，提高分类准确率 |
| 9 | Approval Manager | **独立模块（新增）** | 审批生命周期独立管理，不在状态机和风控间分散 |
| 10 | Notification Engine | **独立模块（新增）** | 聚合/过滤/情境适配与事件分发解耦 |

---

## 15. 项目文件结构

```
agentbridge/
├── middleware-core/              # Golang 服务端
│   ├── cmd/server/main.go       # 服务入口
│   ├── internal/
│   │   ├── domain/types.go      # 领域模型 + 枚举
│   │   ├── ws/hub.go            # WebSocket Hub (session + device 管理)
│   │   ├── ws/handler.go        # WebSocket 连接处理器
│   │   ├── statemachine/        # 状态机
│   │   ├── risk/assessor.go     # 风险评估引擎
│   │   ├── device/dispatcher.go # 设备路由 + 格式转换
│   │   ├── approval/manager.go  # 审批管理器
│   │   ├── notify/engine.go     # 通知引擎
│   │   └── store/eventstore.go  # 内存/SQLite 事件存储 + ack/replay
│   └── go.mod / go.sum
│
├── agent-adapter/               # Node.js/TS Agent 适配器
│   ├── src/
│   │   ├── index.ts             # 入口，启动适配器
│   │   ├── adapters/
│   │   │   ├── claude-api.ts    # Claude API 适配器
│   │   │   ├── claude.ts        # Claude Code CLI 适配器
│   │   │   ├── generic-cli.ts   # 通用 CLI 适配器
│   │   │   └── openai-compatible.ts
│   │   ├── context/engine.ts    # Context Engine（滑动窗口）
│   │   ├── normalizer.ts        # Event Normalization（正则+上下文）
│   │   └── ws-client.ts         # WebSocket 客户端（连接 Core）
│   ├── package.json / tsconfig.json
│
├── dashboard/                   # React/TS 监控面板
├── mock-device/                 # phone/watch/glass/earbuds 模拟客户端和联调脚本
└── docs/
    ├── architecture.md          # 本文档
    ├── requirements.md          # 产品需求
    └── w3-integration-checklist.md
```

---

## 16. 验证方案

1. **Core 验证**：`cd middleware-core && go test ./...`
2. **Mock Device 验证**：先启动 Core，再执行 `cd mock-device && npm run test:e2e`
3. **W3 模拟验证**：先启动 Core，再执行 `cd mock-device && SERVER=http://127.0.0.1:8080 npm run test:w3`
4. **W3 主机预检**：真实联调前执行 `cd mock-device && SERVER=http://127.0.0.1:8080 npm run w3:preflight`；现场要求真机时增加 `W3_REQUIRE_DEVICE=1`
5. **风险拦截验证**：Agent 尝试执行 `rm -rf` → 手机/眼镜显示「返回 PC 确认」，按钮不可点击
6. **Dashboard 验证**：Dashboard 实时展示 session 事件流、状态变迁时序图、审批历史

## 17. 当前实现进度对照

| 方向 | 状态 | 说明 |
|------|------|------|
| Core 事件链路 | 已实现 | REST ingest、状态机、风控、审批、通知、设备分发、Dashboard 广播 |
| EventStore 可靠性 | 已实现 | 内存 ring buffer + 可选 SQLite，支持 `seq`、`last_acked_seq`、replay |
| Agent provider | 已实现 | `claude-api`、`openai-compatible`、`generic-cli`、`claude-cli` |
| Mock Device / W3 readiness | 已实现 | 状态层、e2e replay/action、W3 readiness 和 preflight |
| 真实 Phone/Glass App | 待实现 | 本仓库只有协议、模拟器和联调清单；客户端工程需补 OkHttp WS、TTS、按键/语音绑定 |
| 生产化安全/存储 | 待实现 | API key/JWT、设备授权、PostgreSQL/Redis、审批审计持久化 |
