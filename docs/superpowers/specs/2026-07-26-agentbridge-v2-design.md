# AgentBridge V2 架构设计文档

**日期：** 2026-07-26
**状态：** 历史归档；大部分 Phase 1 核心目标已在 2026-07-27 落地，当前实现以 README、CLAUDE.md、docs/architecture.md 和代码为准
**范围：** Agent Adapter 重构 + Core 可靠性层 + Glass 客户端 + 协议向前兼容

> 归档说明：本文保留为设计来源和执行记录，不再作为最新运行说明。后续实现调整过部分路径与范围：SQLite 事件存储落在 `middleware-core/internal/store/eventstore.go`，没有创建 `store/sqlite/` 子包；断连补发验证落在 `mock-device/e2e-replay-action-test.js` 与 `device-session.js`；Agent provider 增加了 `openai-compatible` 和 `generic-cli`，未单独实现 `codex-api`；真实 Phone/Glass 客户端仍待在客户端工程中实现。

---

## 1. 目标与背景

### 1.1 核心问题

AI Agent（Claude Code、Codex 等）执行任务时，人必须守在电脑旁。构建报错确认、数据库迁移审批、部署授权——离开工位就停滞。

### 1.2 三个转化

1. **非结构化 → 结构化**：Agent 输出转为 6 种标准事件 + 风险评分
2. **PC 端 → 多设备**：同一事件在手机/手表/眼镜/耳机上自动变换形态
3. **被动监控 → 主动交互**：用户在任意设备上批准/拒绝/继续/暂停，直接反馈给 Agent

### 1.3 本次设计要解决的问题

| 问题 | 当前状态 | 目标 |
|------|---------|------|
| Agent 连接方式 | spawn CLI + stdout 正则解析，脆弱 | API 直连 + 多 Agent 适配器，可控 |
| 消息可靠性 | 内存 channel，满即丢，无恢复 | SQLite 持久化 + ack + 重连补发 |
| 眼镜交互 | 仅概念设计，无客户端 | Layer 2 按键交互 + 协议预留 Layer 3/4 |
| 协议扩展性 | ClientAction 固定字段 | 向前兼容，voice/text 字段预留 |
| 测试覆盖 | 无 Go 测试 | 表驱动测试覆盖 dispatcher 全部事件类型 |

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                     Agent 层（多适配器）                    │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐       │
│  │ Claude   │  │  Codex   │  │  Claude Code CLI  │       │
│  │ API      │  │  API     │  │  (spawn, 兜底)     │       │
│  │ (主用)    │  │ (OpenAI) │  │                   │       │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘       │
│       │              │                 │                  │
│       └──────────────┼─────────────────┘                  │
│                      │ 统一 AgentAdapter 接口             │
│                      ▼                                    │
│              ┌──────────────┐                             │
│              │  Agent Hub   │  路由 + 工具注册 + 审批拦截  │
│              └──────┬───────┘                             │
└─────────────────────┼─────────────────────────────────────┘
                      │ UnifiedMessage (REST POST /api/v1/events)
                      ▼
┌──────────────────────────────────────────────────────────┐
│                   Middleware Core (Go)                     │
│                                                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ 状态机    │  │ 风控引擎  │  │ 设备路由  │  │ 通知引擎  │ │
│  │ 7态18转移 │  │ 7规则    │  │ Dispatcher│  │ 即时/聚合 │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │              SQLite 存储层（新增）                   │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  │    │
│  │  │ events     │  │ approvals  │  │ sessions   │  │    │
│  │  │ (持久化+seq)│  │ (生命周期)  │  │ (注册信息)  │  │    │
│  │  └────────────┘  └────────────┘  └────────────┘  │    │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  ┌──────────────────────────────────────────────────┐    │
│  │              WebSocket Hub                         │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │    │
│  │  │ 设备连接  │  │ 补发队列  │  │ Dashboard广播│   │    │
│  │  └──────────┘  └──────────┘  └──────────────┘   │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────┬───────────────────────────────────┘
                       │ device_overrides (WSS)
          ┌────────────┼────────────┬────────────┐
          ▼            ▼            ▼            ▼
      ┌──────┐   ┌──────┐   ┌──────────┐  ┌────────┐
      │Phone │   │Watch │   │  Glass   │  │Earbuds │
      │      │   │      │   │(Rokid 3) │  │        │
      └──────┘   └──────┘   └──────────┘  └────────┘
                                │ 按键/语音审批
                                │ + WebSocket ack
```

---

## 3. Agent Adapter 层（重构）

### 3.1 统一接口

```typescript
// agent-adapter/src/adapters/types.ts

/** 所有 Agent 适配器必须实现的接口 */
interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapability[];

  /** 建立连接/初始化 */
  connect(): Promise<void>;

  /** 发送用户输入，返回异步事件流 */
  send(input: AgentInput): AsyncIterable<AgentEvent>;

  /** 处理设备回传的用户操作 */
  handleUserAction(action: ClientAction): Promise<void>;

  /** 断开连接 */
  disconnect(): Promise<void>;
}

interface AgentInput {
  type: 'start_task' | 'user_message' | 'action_response';
  text?: string;           // 用户自然语言输入（Layer 3/4）
  action?: ClientAction;   // 设备审批动作（Layer 2）
  taskId?: string;
}

type AgentEvent =
  | { type: 'text'; content: string }                    // 普通文本输出
  | { type: 'tool_call'; tool: string; args: unknown }   // 工具调用
  | { type: 'needs_approval'; tool: string; risk: number } // 需要审批
  | { type: 'task_started'; taskId: string }
  | { type: 'task_completed'; taskId: string; summary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_blocked'; taskId: string; reason: string }
  | { type: 'done'; text: string }                       // 对话结束

type AdapterCapability = 'file_ops' | 'shell_exec' | 'code_search' | 'conversation';
```

### 3.2 Claude API Adapter（主用，Phase 1 实现）

```typescript
// agent-adapter/src/adapters/claude-api.ts

import Anthropic from '@anthropic-ai/sdk';

class ClaudeAPIAdapter implements AgentAdapter {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private tools: Anthropic.Tool[];

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    this.messages.push({ role: 'user', content: input.text || 'Continue' });

    while (true) {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: this.messages,
        tools: this.tools,
      });

      // 收集文本输出
      const textBlocks = response.content.filter(c => c.type === 'text');
      for (const block of textBlocks) {
        yield { type: 'text', content: block.text };
      }

      // 处理工具调用
      const toolUses = response.content.filter(c => c.type === 'tool_use');
      for (const tool of toolUses) {
        // ═══ 审批拦截点 ═══
        const risk = this.assessRisk(tool.name, tool.input);
        if (risk >= 0.3) {
          yield {
            type: 'needs_approval',
            tool: tool.name,
            risk,
          };
          // 暂停等待用户操作 → handleUserAction() 被调用 → 继续
          return; // 等待外部调用 send() 恢复
        }

        // 执行工具
        const result = await this.executeTool(tool.name, tool.input);
        yield { type: 'tool_call', tool: tool.name, args: tool.input };

        this.messages.push({
          role: 'assistant',
          content: response.content,
        });
        this.messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: tool.id, content: result }],
        });
      }

      // 没有工具调用 = 对话自然结束
      if (toolUses.length === 0) {
        const summary = textBlocks.map(b => b.text).join('\n');
        yield { type: 'done', text: summary };
        return;
      }
    }
  }

  async handleUserAction(action: ClientAction): Promise<void> {
    // 收到审批结果后，追加 tool_result 并继续
    this.messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: action.taskId,
        content: action.type === 'approve' ? 'Approved by user from device' : 'Rejected by user from device',
      }],
    });
  }
}
```

### 3.3 Agent Hub（路由器）

```typescript
// agent-adapter/src/hub.ts

class AgentHub {
  private adapters: Map<string, AgentAdapter> = new Map();
  private activeAdapter: AgentAdapter | null = null;

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** 选择适配器：优先 API，降级 CLI */
  async select(preferred?: string): Promise<AgentAdapter> {
    if (preferred && this.adapters.has(preferred)) {
      this.activeAdapter = this.adapters.get(preferred)!;
    } else {
      // 自动选择：Claude API > Codex API > CLI fallback
      for (const name of ['claude-api', 'codex-api', 'claude-cli']) {
        if (this.adapters.has(name)) {
          this.activeAdapter = this.adapters.get(name)!;
          break;
        }
      }
    }

    await this.activeAdapter!.connect();
    return this.activeAdapter!;
  }
}
```

### 3.4 Agent 事件 → UnifiedMessage 映射

Agent 原生事件不再需要正则分类，直接映射：

| AgentEvent.type | UnifiedMessage.event_type | 说明 |
|-----------------|--------------------------|------|
| `task_started` | `task_started` | 直接映射 |
| `tool_call` | `task_running` | 工具执行中 |
| `task_blocked` | `task_blocked` | 直接映射 |
| `needs_approval` | `needs_approval` | 直接映射，携带 risk_score |
| `task_failed` | `task_failed` | 直接映射 |
| `task_completed` / `done` | `task_completed` | 直接映射 |
| `text` | `task_running` | 普通输出，默认事件 |

---

## 4. Core 存储层（SQLite）

### 4.1 Schema

```sql
-- middleware-core/internal/store/sqlite/schema.sql

PRAGMA journal_mode=WAL;       -- 写不阻塞读
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT '',
    agent_type  TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'idle',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    task_id     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    severity    TEXT NOT NULL DEFAULT 'info',
    risk_score  REAL NOT NULL DEFAULT 0,
    risk_blocked INTEGER NOT NULL DEFAULT 0,
    actions     TEXT NOT NULL DEFAULT '[]',   -- JSON array
    raw_json    TEXT NOT NULL,                -- 完整 UnifiedMessage JSON
    created_at  INTEGER NOT NULL,

    UNIQUE(session_id, seq)
);

CREATE INDEX idx_events_session_seq ON events(session_id, seq);

CREATE TABLE IF NOT EXISTS device_acks (
    session_id  TEXT NOT NULL,
    device_type TEXT NOT NULL,
    last_acked_event_id TEXT NOT NULL,   -- 最后确认的 message_id
    updated_at  INTEGER NOT NULL,

    PRIMARY KEY (session_id, device_type)
);

CREATE TABLE IF NOT EXISTS approvals (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    device_type TEXT NOT NULL DEFAULT '',
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    timeout_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
);

CREATE INDEX idx_approvals_task ON approvals(task_id);
```

### 4.2 Store 接口

```go
// middleware-core/internal/store/store.go

type Store interface {
    // 会话
    CreateSession(s *domain.Session) error
    GetSession(id string) (*domain.Session, error)
    UpdateSessionState(id string, state domain.TaskState) error
    ListActiveSessions() ([]*domain.Session, error)

    // 事件
    AppendEvent(msg *domain.UnifiedMessage) (seq int64, err error)
    GetEventsSince(sessionID string, seq int64) ([]*domain.UnifiedMessage, error)
    GetEventByID(id string) (*domain.UnifiedMessage, error)

    // 设备确认
    UpdateDeviceAck(sessionID string, deviceType domain.DeviceType, lastAckedID string) error
    GetDeviceAck(sessionID string, deviceType domain.DeviceType) (string, error)

    // 审批
    CreateApproval(a *ApprovalRecord) error
    UpdateApprovalStatus(id string, status Status) error
    GetApprovalByTask(taskID string) (*ApprovalRecord, error)
    ListPendingApprovals() ([]*ApprovalRecord, error)

    // 生命周期
    Close() error
}
```

### 4.3 从内存到 SQLite 的迁移

当前内存实现在 `internal/store/memory.go`。新增 `internal/store/sqlite/` 目录，实现相同的 `Store` 接口。`cmd/server/main.go` 中切换初始化：

```go
// 当前
store := memory.NewStore()

// 改为
store, err := sqlitestore.Open("agentbridge.db")
if err != nil { log.Fatal(err) }
defer store.Close()
```

上层代码（状态机、风控、事件处理）不需要任何修改，它们只依赖 `Store` 接口。

---

## 5. 消息可靠性协议

### 5.1 序列号与确认

```
┌─────── Core ───────┐                    ┌─── Glass Client ───┐
│                     │                    │                     │
│ AppendEvent(msg)    │                    │                     │
│   → DB seq=43       │                    │                     │
│   → push channel    │── DeviceMessage ──→│ onReceive(msg)      │
│      { msg_id:abc,  │   { msg_id:"abc", │   ackStore.save(    │
│        seq:43,      │     seq:43,        │     "abc")          │
│        ... }        │     ... }          │   renderCard(msg)   │
│                     │                    │                     │
│                     │                    │ ← 断连（WiFi 抖动）  │
│                     │                    │                     │
│                     │                    │ ← 重连               │
│                     │← WS connect ───────│ 带 last_acked_id=   │
│                     │  ?last_acked_id=   │   "xyz"             │
│                     │   xyz              │                     │
│                     │                    │                     │
│ 查 DB: abc 在 xyz 后│                    │                     │
│ → 补发 abc          │── DeviceMessage ──→│ onReceive(abc)      │
│                     │   { msg_id:"abc",  │ 本地查重: "abc" 已   │
│                     │     is_replay:true,│ 处理过 → 跳过！     │
│                     │     ... }          │                     │
└─────────────────────┘                    └─────────────────────┘
```

### 5.2 协议字段

**DeviceMessage（Server → Client）新增字段：**

```go
type DeviceMessage struct {
    Direction string                       `json:"direction"`    // "server_to_client"
    MessageID string                       `json:"message_id"`   // 唯一 ID，去重依据
    SessionID string                       `json:"session_id"`
    Seq       int64                        `json:"seq"`          // 新增：单调序列号
    IsReplay  bool                         `json:"is_replay"`    // 新增：是否为补发消息
    Timestamp int64                        `json:"timestamp"`
    Event     *UnifiedMessage              `json:"event"`
    Overrides map[DeviceType]*DeviceOutput `json:"device_overrides"`
}
```

**ClientMessage（Client → Server）新增字段：**

```go
type ClientMessage struct {
    Direction    string       `json:"direction"`
    SessionID    string       `json:"session_id"`
    TaskID       string       `json:"task_id"`
    LastAckedID  string       `json:"last_acked_id,omitempty"`  // 新增：最后确认的消息ID
    Action       ClientAction `json:"action"`
}

type ClientAction struct {
    Type       ActionType `json:"type"`
    DeviceType DeviceType `json:"device_type"`
    Timestamp  int64      `json:"timestamp"`
    Text       string     `json:"text,omitempty"`  // 新增：Layer 3/4 预留
}
```

### 5.3 重连与补发流程

```
1. Glass 断连 → writePump 检测到 write 错误 → closeOnce.Do → Unregister
2. Unregister 只删 Hub 中的 channel，不删 DB 数据
3. Glass 重连 → WS upgrade → Hub.Register
4. Register 检查 last_acked_id：
   a. 如果为空：新设备，从当前 seq 开始实时推送
   b. 如果有值：查 DB 获取该 message_id 之后的未确认事件 → 批量发送（is_replay=true）
5. Glass 收到 is_replay=true 的消息 → 检查本地去重缓存 → 跳过已处理的
6. Glass 定期（每收到 10 条或每 5 秒）发送 ack 更新
```

### 5.4 Channel 缓冲区增长

```go
// 之前: 64（太小，WiFi 场景容易丢）
ch := make(chan []byte, 64)

// 改为: 256 + 背压日志
ch := make(chan []byte, 256)
// channel 满时：不再静默丢弃，而是记录 WARN 日志 + 依赖 DB 补发
```

---

## 6. Glass 客户端设计

### 6.1 组件结构

```
MainActivity
├── CardRenderer（Composable）
│   ├── StatusCard     ← status_card
│   ├── ActionableCard ← actionable_card（按键映射激活）
│   └── AlertCard      ← alert_card（闪烁提示）
│
├── GlassWSClient
│   ├── connect(serverUrl, sessionId, lastAckedId)
│   ├── onMessage → 去重 → CardRenderer.render()
│   ├── onClose → 指数退避重连
│   └── sendAction(type, text?)
│
└── AckStore (SharedPreferences)
    ├── last_acked_message_id
    └── recent_message_ids[]（最近 100 条，LRU）
```

### 6.2 按键映射（Layer 2）

| 眼镜按键 | 对应动作 | 说明 |
|---------|---------|------|
| 单击（前/确认） | 触发 QuickActions[0] | 通常是 approve/continue |
| 双击（后/取消） | 触发 QuickActions[1] | 通常是 reject/pause |
| 上滑/下滑 | 切换聚焦的 action | 多 action 时导航 |
| 长按 | view_details | 查看详情/发送 text |

### 6.3 卡片渲染规则

对应 Core Dispatcher 的 RenderHint：

| RenderHint | 用途 | 视觉特征 |
|-----------|------|---------|
| `status_card` | task_started/running/completed | 标题 + 单行摘要，绿色/白色 |
| `actionable_card` | task_blocked/needs_approval | 标题 + 摘要 + 按键提示 + 边框闪烁 |
| `alert_card` | task_failed | 标题 + 摘要 + 红色，自动 TTS 播报 |
| `card` | 默认 | 标题 + 摘要 |

### 6.4 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| WebSocket 客户端 | OkHttp 4.x | Android 生态标准，支持 RFC 6455 |
| 持久化 | SharedPreferences | 极轻量，只需存 ack 状态 |
| UI | Jetpack Compose | 与现有 MainActivity 一致 |
| TTS | Android TextToSpeech（离线） | 绕过 Rokid AK/SK 缺口 |
| 语音输入（预留）| Android SpeechRecognizer | Layer 3 时启用 |

---

## 7. 设备发现与会话绑定（Phase 2）

眼镜如何知道 Core 的地址和 Session ID？

**开发阶段（Phase 1-2）：**
- Core 地址：硬编码或 ADB 传入（`adb shell am start -e server ws://192.168.1.100:8080`）
- Session ID：眼镜连接 Core 后，Core 返回活跃 session 列表，用户按键选择

**生产阶段（Phase 3+）：**
- mDNS/Bonjour 服务发现 Core 地址
- 或通过 Phone CXR 传入（但受限于 sendCustomCmd 不可用，需要 Phone 也连 Core WS 再中转）

**Phase 1 简化方案：**
- Mock Device / Dashboard 不需要这个功能
- Glass 端使用 `ws://<hardcoded-ip>:8080/ws/default?device_type=ar_glasses`
- "default" session 为开发默认会话

---

## 8. 错误处理策略

### 8.1 各层故障模式

| 层级 | 故障 | 处理 |
|------|------|------|
| **Agent Adapter** | API 超时/限流 | 重试 3 次 → 降级到 CLI fallback |
| **Agent Adapter** | API key 失效 | 发送 `task_failed` + 通知用户 |
| **Core** | SQLite 锁 | WAL 模式避免；重试 3 次后返回 503 |
| **Core** | Channel 满 | WARN 日志，依赖 DB 补发 |
| **Glass** | WiFi 断连 | 指数退避重连（2s → 4s → 8s → max 30s） |
| **Glass** | WS 消息解析失败 | 跳过该消息，记录日志 |
| **Glass** | 重复消息 | 本地去重缓存，静默跳过 |

### 8.2 Agent Hub 降级链

```
首选: Claude API Adapter
  ↓ 连接失败/超时
次选: Codex API Adapter（如果配置了 key）
  ↓ 连接失败/无 key
兜底: Claude Code CLI spawn
```

---

## 9. 测试策略

### 9.1 单元测试

| 模块 | 文件 | 覆盖范围 |
|------|------|---------|
| device/dispatcher | `dispatcher_test.go`（已完成） | 27 cases：6 事件类型 + 边缘情况 |
| store/sqlite | `sqlite_test.go` | CRUD + seq 单调性 + ack 更新 |
| approval/manager | `manager_test.go` | 生命周期 + Lock vs RLock 回归 |
| notify/engine | `engine_test.go` | 冷却豁免 needs_approval/task_blocked |
| Agent Hub | `hub.test.ts` | 适配器选择 + 降级链 |

### 9.2 集成测试

| 测试 | 工具 | 覆盖 |
|------|------|------|
| Roundtrip | `mock-device/roundtrip-test.js`（已改进） | POST → WS → ack 完整链路 |
| 断连重连 | `mock-device/reconnect-test.js`（新增） | 断连 → 重连 → 补发 → 去重 |
| 多设备 | `mock-device/orchestrator.js`（已有） | 4 设备同时连接 |

### 9.3 端到端测试（Phase 2）

```
Claude API → Agent Hub → Core (SQLite) → Mock Glass → 按键审批 → Core → Agent Hub → Claude API 继续
```

---

## 10. 目录变更

```
agentbridge/
├── agent-adapter/
│   └── src/
│       ├── adapters/
│       │   ├── types.ts          ← 新增：AgentAdapter 接口定义
│       │   ├── claude-api.ts     ← 新增：Claude API 适配器
│       │   ├── codex-api.ts      ← 新增：Codex API 适配器
│       │   └── claude.ts         ← 保留：CLI spawn 兜底
│       ├── hub.ts                ← 新增：Agent Hub 路由器
│       ├── normalizer.ts         ← 简化：不再需要正则分类
│       ├── context/engine.ts     ← 保留：上下文窗口
│       └── ws-client.ts          ← 修改：适应新协议
│
├── middleware-core/
│   └── internal/
│       ├── store/
│       │   ├── store.go          ← 新增：Store 接口
│       │   ├── memory.go         ← 保留：内存实现（测试用）
│       │   └── sqlite/
│       │       ├── sqlite.go     ← 新增：SQLite 实现
│       │       └── schema.sql    ← 新增：建表语句
│       ├── ws/
│       │   ├── hub.go            ← 修改：Register 支持 last_acked_id
│       │   └── handler.go        ← 修改：协议新字段
│       └── domain/
│           └── types.go          ← 修改：ClientAction 加 Text 字段
│
├── mock-device/
│   ├── roundtrip-test.js         ← 已改进：polling 替代 sleep
│   └── reconnect-test.js         ← 新增：重连补发测试
│
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-07-26-agentbridge-v2-design.md  ← 本文档
```

---

## 11. 开发阶段

### Phase 1 — Core 可靠性 + Agent API 切换（PC only）

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 1.1 | SQLite Store 实现 + schema 初始化 | 0.5 天 | — |
| 1.2 | Store 接口注入到 main.go，替换内存 store | 0.25 天 | 1.1 |
| 1.3 | Hub.Register 支持 last_acked_id 补发 | 0.5 天 | 1.1 |
| 1.4 | DeviceMessage 加 seq/is_replay 字段 | 0.25 天 | — |
| 1.5 | ClientAction 加 text 字段（协议向前兼容） | 0.1 天 | — |
| 1.6 | Claude API Adapter 实现 + Agent Hub | 1 天 | — |
| 1.7 | 移除 normalizer 中的正则分类，改为直接映射 | 0.5 天 | 1.6 |
| 1.8 | approval/manager + notify/engine 测试 | 0.5 天 | — |
| 1.9 | Roundtrip + reconnect 集成测试 | 0.5 天 | 1.3 |
| — | **合计** | **~4 天** | — |

### Phase 2 — Glass 客户端（WiFi 联调）

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 2.1 | GlassWSClient（OkHttp + 重连 + ack） | 1 天 | Phase 1 |
| 2.2 | CardRenderer（3 种卡片 Compose 组件） | 1 天 | 2.1 |
| 2.3 | AckStore（SharedPreferences 去重缓存） | 0.5 天 | 2.1 |
| 2.4 | 按键映射 + 内置 TTS 集成 | 0.5 天 | 2.2 |
| 2.5 | 眼镜真机联调（同 WiFi → Core） | 1 天 | 2.1-2.4 |
| 2.6 | Mock Device glass 模式验证 | 0.5 天 | 2.1 |
| — | **合计** | **~4.5 天** | — |

### Phase 3 — 端到端集成

> **注意：此节已过时。** Phase 3 已重新规划为 Phase 3a/3b/3c 三层路线。
> 当前活跃文档：
> - Spec: `docs/superpowers/specs/2026-08-11-claude-code-adapter-v2-design.md`
> - Plan: `docs/superpowers/plans/2026-08-11-claude-code-adapter-v2-plan.md`
> - 进度：Phase 3a spec + plan 已完成，待 Codex 执行 Task 1-6（纯代码），Task 7（E2E 验证）需真机环境。

| # | 任务 | 预估 | 依赖 |
|---|------|------|------|
| 3.1 | Phone CXR 生命周期管理（仅 install/start）| 0.5 天 | Phase 2 |
| 3.2 | 三端联调（PC → Core → Glass） | 1 天 | 3.1 |
| 3.3 | Agent Hub 降级链测试 | 0.5 天 | 3.2 |
| 3.4 | (可选) Layer 3 语音输入 | 1 天 | 3.2 |
| — | **合计** | **~3 天** | — |

---

## 12. 向前兼容性

### 12.1 协议版本化

URL 中增加版本号，确保未来协议升级不破坏旧客户端：

```
ws://host:8080/ws/{sessionID}?device_type=ar_glasses&protocol=v2
```

未指定 protocol 的客户端视为 v1（兼容旧 Mock Device）。

### 12.2 字段策略

- 新增字段一律 `omitempty`，旧客户端忽略未知字段
- 废弃字段保留两个版本周期后再删除
- `ClientAction.Text` 当前为空，Layer 3 时启用，不破坏 Layer 2

---

## 13. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Anthropic API 被墙 | 低（当前 CLI 通）| 高 | CLI fallback + Codex 备选 |
| SQLite WAL 在 Windows 上有兼容问题 | 低 | 中 | 检测 OS，Windows 上禁用 WAL 或用 LevelDB |
| Rokid 眼镜字体不支持 Unicode 前缀符号 | 中 | 低 | 用纯文字替代（"阻塞"/"审批"/"失败"） |
| 眼镜 WiFi 不稳定导致频繁重连 | 中 | 中 | 指数退避 + 本地缓存 + 补发保证 |
| CXR sendCustomCmd 不可用（已确认） | — | — | 已放弃，WebSocket 替代 |

---

## 14. 待定事项（Phase 2 决策）

- [ ] Glass 会话选择 UI（从活跃 session 列表中选择）
- [ ] mDNS 服务发现 vs 手动输入 Core 地址
- [ ] Layer 3 语音：Android SpeechRecognizer vs Core Whisper 中转
- [ ] 多 Agent 并发会话支持（当前假设单会话）
- [ ] 数据库定期压缩/清理策略
