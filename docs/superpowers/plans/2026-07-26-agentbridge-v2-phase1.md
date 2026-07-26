# AgentBridge V2 Phase 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 核心可靠性基建（SQLite 持久化 + 断连补发）+ Agent API 切换（Claude API 为主，CLI 兜底）+ 协议向前兼容

**架构思路：** SQLite 替代纯内存存储作为事件持久层；Hub.Register 新增 lastAckedSeq 参数支持重连时补发未确认事件；Agent Adapter 从 spawn+正则解析重构为统一 AgentAdapter 接口 + 多适配器 + Agent Hub 降级链

**技术栈：** Go 1.21+ (chi, gorilla/websocket, mattn/go-sqlite3), TypeScript (ws, @anthropic-ai/sdk), Node.js 18+

## 全局约束

- 协议新增字段一律 `omitempty`，不破坏旧客户端
- Channel 缓冲区从 64 提升到 256，满时输出 WARN 日志 + 依赖 DB 补发
- SQLite 必须开启 WAL 模式
- 只改 Core 和 Agent Adapter，Dashboard 和 Mock Device 原地不动
- CLI fallback 必须保留，API 模式作为主用但非唯一

---

## 文件结构

```
本次创建:
  middleware-core/internal/store/store.go              — Store 接口 + ApprovalRecord
  middleware-core/internal/store/sqlite/sqlite.go      — SQLite 实现
  middleware-core/internal/store/sqlite/sqlite_test.go — SQLite 单元测试
  agent-adapter/src/adapters/types.ts                 — AgentAdapter 接口 + AgentEvent 类型
  agent-adapter/src/adapters/claude-api.ts            — Claude API 适配器
  agent-adapter/src/hub.ts                            — Agent Hub 路由器
  mock-device/reconnect-test.js                       — 重连补发集成测试

本次修改:
  middleware-core/internal/domain/types.go            — Seq/IsReplay/LastAckedSeq/Text 字段
  middleware-core/internal/ws/hub.go                  — 注入 Store + Register(lastAckedSeq) + replayMissed
  middleware-core/internal/ws/handler.go               — 解析 last_acked_seq 查询参数
  middleware-core/cmd/server/main.go                  — 初始化 SQLite + 传入 Hub
  agent-adapter/src/normalizer.ts                     — 简化：AgentEvent 直接映射
  agent-adapter/src/index.ts                          — 使用 Agent Hub 替代直接 spawn
```

---

### Task 1: 协议字段扩展（向前兼容）

**涉及文件:**
- 修改: `middleware-core/internal/domain/types.go:100-133`

**接口契约:**
- 产出: `DeviceMessage.Seq int64`, `DeviceMessage.IsReplay bool`, `ClientMessage.LastAckedSeq int64`, `ClientAction.Text string`

- [ ] **Step 1: 扩展 DeviceMessage 结构体**

找到 `middleware-core/internal/domain/types.go` 第 100-108 行的 `DeviceMessage`，在 `SessionID` 行后、`Timestamp` 行前插入两个新字段：

```go
// DeviceMessage 是最终发送给单个设备的输出消息，已包含设备专属渲染。
type DeviceMessage struct {
	Direction   string                       `json:"direction"`
	MessageID   string                       `json:"message_id"`
	SessionID   string                       `json:"session_id"`
	Seq         int64                        `json:"seq,omitempty"`       // 单调递增序列号，用于 ack 追踪
	IsReplay    bool                         `json:"is_replay,omitempty"` // 是否为重连后补发的历史消息
	Timestamp   int64                        `json:"timestamp"`
	Event       *UnifiedMessage              `json:"event"`
	Overrides   map[DeviceType]*DeviceOutput `json:"device_overrides"`
}
```

- [ ] **Step 2: 扩展 ClientMessage 和 ClientAction 结构体**

找到第 120-133 行，修改：

```go
// ClientMessage 是设备回传给中间层的用户操作消息。
type ClientMessage struct {
	Direction    string       `json:"direction"`
	SessionID    string       `json:"session_id"`
	TaskID       string       `json:"task_id"`
	LastAckedSeq int64        `json:"last_acked_seq,omitempty"` // 设备最后确认的 seq，用于重连补发
	Action       ClientAction `json:"action"`
}

// ClientAction 是设备端用户的操作载荷。
type ClientAction struct {
	Type       ActionType `json:"type"`
	DeviceType DeviceType `json:"device_type"`
	Timestamp  int64      `json:"timestamp"`
	Text       string     `json:"text,omitempty"` // Layer 3/4 语音输入预留字段
}
```

- [ ] **Step 3: 验证编译**

```bash
cd middleware-core && go build ./...
```
期望结果: BUILD OK。所有新字段都有 `omitempty`，现有代码不受影响。

- [ ] **Step 4: 提交**

```bash
git add middleware-core/internal/domain/types.go
git commit -m "feat: 协议新增 Seq/IsReplay/LastAckedSeq/Text 字段，向前兼容"
```

---

### Task 2: Store 接口定义

**涉及文件:**
- 创建: `middleware-core/internal/store/store.go`

**接口契约:**
- 产出: `Store` 接口, `ApprovalRecord` 结构体

- [ ] **Step 1: 创建 store.go**

```go
// middleware-core/internal/store/store.go

package store

import "agentbridge/internal/domain"

// ApprovalRecord 持久化审批记录，镜像审批状态。
type ApprovalRecord struct {
	ID         string
	TaskID     string
	SessionID  string
	Status     string // "pending" | "approved" | "rejected" | "expired"
	RetryCount int
	MaxRetries int
	TimeoutAt  int64 // unix 毫秒
	CreatedAt  int64
	ResolvedAt int64
	DeviceType string
}

// Store 定义事件、设备确认、审批的持久化接口。
type Store interface {
	// 事件 — seq 按 session 单调递增
	AppendEvent(sessionID string, msg *domain.UnifiedMessage) (seq int64, err error)
	GetEventsSince(sessionID string, sinceSeq int64) ([]*domain.UnifiedMessage, error)

	// 设备确认 — 记录每个设备最后确认的 seq
	UpdateDeviceAck(sessionID string, deviceType domain.DeviceType, seq int64) error
	GetDeviceAckSeq(sessionID string, deviceType domain.DeviceType) (int64, error)

	// 审批
	CreateApproval(a *ApprovalRecord) error
	UpdateApprovalStatus(id string, status string) error
	GetApprovalByTask(taskID string) (*ApprovalRecord, error)
	ListPendingApprovals() ([]*ApprovalRecord, error)

	Close() error
}
```

- [ ] **Step 2: 验证编译**

```bash
cd middleware-core && go build ./...
```

- [ ] **Step 3: 提交**

```bash
git add middleware-core/internal/store/store.go
git commit -m "feat: 定义 Store 持久化接口"
```

---

### Task 3: SQLite Store 实现

**涉及文件:**
- 创建: `middleware-core/internal/store/sqlite/sqlite.go`
- 创建: `middleware-core/internal/store/sqlite/sqlite_test.go`

**接口契约:**
- 产出: `sqlitestore.Open(path string) (*SQLiteStore, error)`，实现 `store.Store`
- 消费: `store.Store` (Task 2)

- [ ] **Step 1: 安装 SQLite 驱动**

```bash
cd middleware-core && go get github.com/mattn/go-sqlite3@latest
```

- [ ] **Step 2: 创建 sqlite.go**

```go
// middleware-core/internal/store/sqlite/sqlite.go

package sqlitestore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"agentbridge/internal/domain"
	"agentbridge/internal/store"

	_ "github.com/mattn/go-sqlite3"
)

type SQLiteStore struct {
	db *sql.DB
	mu sync.RWMutex
}

// Open 创建或打开 SQLite 数据库并执行迁移。
func Open(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite3", path+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("打开 SQLite 失败: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite 串行写入

	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("SQLite 迁移失败: %w", err)
	}
	return &SQLiteStore{db: db}, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS events (
			id TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT NOT NULL,
			seq INTEGER NOT NULL, event_type TEXT NOT NULL, title TEXT DEFAULT '',
			body TEXT DEFAULT '', severity TEXT DEFAULT 'info',
			risk_score REAL DEFAULT 0, risk_blocked INTEGER DEFAULT 0,
			actions TEXT DEFAULT '[]', raw_json TEXT NOT NULL, created_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, seq)
		);
		CREATE INDEX IF NOT EXISTS idx_events_sess_seq ON events(session_id, seq);

		CREATE TABLE IF NOT EXISTS device_acks (
			session_id TEXT NOT NULL, device_type TEXT NOT NULL,
			last_acked_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, device_type)
		);

		CREATE TABLE IF NOT EXISTS approvals (
			id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
			status TEXT DEFAULT 'pending', device_type TEXT DEFAULT '',
			retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
			timeout_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
			resolved_at INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
	`)
	return err
}

// AppendEvent 写入一条事件并返回其序列号。
func (s *SQLiteStore) AppendEvent(sessionID string, msg *domain.UnifiedMessage) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var maxSeq sql.NullInt64
	if err := s.db.QueryRow(
		"SELECT MAX(seq) FROM events WHERE session_id = ?", sessionID,
	).Scan(&maxSeq); err != nil {
		return 0, err
	}
	nextSeq := int64(1)
	if maxSeq.Valid {
		nextSeq = maxSeq.Int64 + 1
	}

	actions, _ := json.Marshal(msg.AvailableActions)
	raw, _ := json.Marshal(msg)
	rb := 0
	if msg.RiskBlocked {
		rb = 1
	}

	_, err := s.db.Exec(
		`INSERT INTO events (id,session_id,task_id,seq,event_type,title,body,severity,risk_score,risk_blocked,actions,raw_json,created_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		msg.ID, sessionID, msg.TaskID, nextSeq, string(msg.EventType),
		msg.Title, msg.Body, string(msg.Severity), msg.RiskScore,
		rb, string(actions), string(raw), time.Now().UnixMilli(),
	)
	return nextSeq, err
}

// GetEventsSince 查询指定 session 中 seq > sinceSeq 的所有事件。
func (s *SQLiteStore) GetEventsSince(sessionID string, sinceSeq int64) ([]*domain.UnifiedMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		"SELECT raw_json FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC",
		sessionID, sinceSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*domain.UnifiedMessage
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var m domain.UnifiedMessage
		if json.Unmarshal([]byte(raw), &m) != nil {
			continue
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

// UpdateDeviceAck 更新设备最后确认的 seq（不存在则插入）。
func (s *SQLiteStore) UpdateDeviceAck(sessionID string, dt domain.DeviceType, seq int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO device_acks (session_id,device_type,last_acked_seq,updated_at)
		 VALUES (?,?,?,?) ON CONFLICT(session_id,device_type)
		 DO UPDATE SET last_acked_seq=excluded.last_acked_seq, updated_at=excluded.updated_at`,
		sessionID, string(dt), seq, time.Now().UnixMilli(),
	)
	return err
}

// GetDeviceAckSeq 获取设备最后确认的 seq，无记录时返回 0。
func (s *SQLiteStore) GetDeviceAckSeq(sessionID string, dt domain.DeviceType) (int64, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var seq int64
	err := s.db.QueryRow(
		"SELECT last_acked_seq FROM device_acks WHERE session_id=? AND device_type=?",
		sessionID, string(dt),
	).Scan(&seq)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return seq, err
}

// CreateApproval 插入一条审批记录。
func (s *SQLiteStore) CreateApproval(a *store.ApprovalRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO approvals (id,task_id,session_id,status,device_type,retry_count,max_retries,timeout_at,created_at)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		a.ID, a.TaskID, a.SessionID, a.Status, a.DeviceType,
		a.RetryCount, a.MaxRetries, a.TimeoutAt, a.CreatedAt,
	)
	return err
}

// UpdateApprovalStatus 更新审批状态。
func (s *SQLiteStore) UpdateApprovalStatus(id, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		"UPDATE approvals SET status=?, resolved_at=? WHERE id=?",
		status, time.Now().UnixMilli(), id,
	)
	return err
}

// GetApprovalByTask 按任务 ID 查找审批记录。
func (s *SQLiteStore) GetApprovalByTask(taskID string) (*store.ApprovalRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a := &store.ApprovalRecord{}
	err := s.db.QueryRow(
		`SELECT id,task_id,session_id,status,device_type,retry_count,max_retries,timeout_at,created_at,resolved_at
		 FROM approvals WHERE task_id=? ORDER BY created_at DESC LIMIT 1`, taskID,
	).Scan(&a.ID, &a.TaskID, &a.SessionID, &a.Status, &a.DeviceType,
		&a.RetryCount, &a.MaxRetries, &a.TimeoutAt, &a.CreatedAt, &a.ResolvedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("未找到任务 %s 的审批记录", taskID)
	}
	return a, err
}

// ListPendingApprovals 列出所有待处理的审批。
func (s *SQLiteStore) ListPendingApprovals() ([]*store.ApprovalRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT id,task_id,session_id,status,device_type,retry_count,max_retries,timeout_at,created_at,resolved_at
		 FROM approvals WHERE status='pending' ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*store.ApprovalRecord
	for rows.Next() {
		a := &store.ApprovalRecord{}
		if err := rows.Scan(&a.ID, &a.TaskID, &a.SessionID, &a.Status, &a.DeviceType,
			&a.RetryCount, &a.MaxRetries, &a.TimeoutAt, &a.CreatedAt, &a.ResolvedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) Close() error { return s.db.Close() }
```

- [ ] **Step 3: 编写单元测试**

```go
// middleware-core/internal/store/sqlite/sqlite_test.go

package sqlitestore

import (
	"os"
	"testing"

	"agentbridge/internal/domain"
)

func TestAppendAndQueryEvents(t *testing.T) {
	path := "test_events.db"
	defer os.Remove(path)
	s, err := Open(path)
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	defer s.Close()

	// 写入第一条事件
	msg := &domain.UnifiedMessage{ID: "evt-1", TaskID: "t1", SessionID: "s1",
		EventType: domain.EventTaskStarted, Title: "开始", Body: "任务启动",
		Severity: domain.SeverityInfo, RiskScore: 0, RiskBlocked: false,
	}
	seq1, err := s.AppendEvent("s1", msg)
	if err != nil {
		t.Fatalf("写入事件失败: %v", err)
	}
	if seq1 != 1 {
		t.Errorf("第一条 seq 应为 1，实际为 %d", seq1)
	}

	// 写入第二条事件
	msg2 := &domain.UnifiedMessage{ID: "evt-2", TaskID: "t1", SessionID: "s1",
		EventType: domain.EventTaskCompleted, Title: "完成", Body: "任务结束",
		Severity: domain.SeverityInfo, RiskScore: 0, RiskBlocked: false,
	}
	seq2, _ := s.AppendEvent("s1", msg2)
	if seq2 != 2 {
		t.Errorf("第二条 seq 应为 2，实际为 %d", seq2)
	}

	// 查询 seq > 0 应返回全部 2 条
	events, _ := s.GetEventsSince("s1", 0)
	if len(events) != 2 {
		t.Fatalf("seq>0 查询应返回 2 条，实际返回 %d 条", len(events))
	}

	// 查询 seq > 1 应只返回第二条
	events2, _ := s.GetEventsSince("s1", 1)
	if len(events2) != 1 {
		t.Fatalf("seq>1 查询应返回 1 条，实际返回 %d 条", len(events2))
	}
	if events2[0].ID != "evt-2" {
		t.Errorf("应返回 evt-2，实际为 %s", events2[0].ID)
	}
}

func TestDeviceAck(t *testing.T) {
	path := "test_ack.db"
	defer os.Remove(path)
	s, _ := Open(path)
	defer s.Close()

	// 写入 ack
	if err := s.UpdateDeviceAck("s1", domain.DeviceGlass, 42); err != nil {
		t.Fatalf("更新 ack 失败: %v", err)
	}
	seq, err := s.GetDeviceAckSeq("s1", domain.DeviceGlass)
	if err != nil {
		t.Fatalf("查询 ack 失败: %v", err)
	}
	if seq != 42 {
		t.Errorf("ack seq 应为 42，实际为 %d", seq)
	}

	// 更新 ack
	s.UpdateDeviceAck("s1", domain.DeviceGlass, 45)
	seq2, _ := s.GetDeviceAckSeq("s1", domain.DeviceGlass)
	if seq2 != 45 {
		t.Errorf("更新后 seq 应为 45，实际为 %d", seq2)
	}

	// 未确认过的设备应返回 0
	seq3, _ := s.GetDeviceAckSeq("s1", domain.DevicePhone)
	if seq3 != 0 {
		t.Errorf("未 ack 设备应返回 0，实际为 %d", seq3)
	}
}

func TestApprovalCRUD(t *testing.T) {
	path := "test_approval.db"
	defer os.Remove(path)
	s, _ := Open(path)
	defer s.Close()

	// 创建审批
	err := s.CreateApproval(&store.ApprovalRecord{
		ID: "a1", TaskID: "t1", SessionID: "s1",
		Status: "pending", MaxRetries: 3,
		TimeoutAt: 9999999, CreatedAt: 1111111,
	})
	if err != nil {
		t.Fatalf("创建审批失败: %v", err)
	}

	// 查询审批
	a, _ := s.GetApprovalByTask("t1")
	if a.Status != "pending" {
		t.Errorf("状态应为 pending，实际为 %s", a.Status)
	}

	// 更新审批状态
	s.UpdateApprovalStatus("a1", "approved")
	a2, _ := s.GetApprovalByTask("t1")
	if a2.Status != "approved" {
		t.Errorf("更新后状态应为 approved，实际为 %s", a2.Status)
	}
}
```

- [ ] **Step 4: 运行测试**

```bash
cd middleware-core && go test ./internal/store/sqlite/ -v
```
期望结果: `TestAppendAndQueryEvents PASS`, `TestDeviceAck PASS`, `TestApprovalCRUD PASS`

- [ ] **Step 5: 提交**

```bash
git add middleware-core/internal/store/sqlite/ middleware-core/go.mod middleware-core/go.sum
git commit -m "feat: SQLite 持久化层 — 事件存储、ack 追踪、审批 CRUD"
```

---

### Task 4: 注入 Store 到 Hub，实现补发逻辑

**涉及文件:**
- 修改: `middleware-core/internal/ws/hub.go` — Hub 结构体 + NewHub + Register + 新增 replayMissed + SendToDevice
- 修改: `middleware-core/internal/ws/handler.go` — 解析 last_acked_seq 查询参数
- 修改: `middleware-core/cmd/server/main.go` — 初始化 SQLite + 传入 Hub

**接口契约:**
- 消费: `store.Store` (Task 2), `sqlitestore.Open` (Task 3)
- 产出: `Hub.Register(sessionID, userID string, deviceType domain.DeviceType, lastAckedSeq int64) (chan []byte, error)`

- [ ] **Step 1: 修改 hub.go — Hub 结构体、NewHub、Register**

```go
// middleware-core/internal/ws/hub.go

// 在 import 块中增加:
// "agentbridge/internal/store"

type Hub struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	dashboards []chan []byte
	db         store.Store  // 持久化层
}

// NewHub 创建 Hub 实例，注入持久化存储。
func NewHub(db store.Store) *Hub {
	return &Hub{
		sessions: make(map[string]*Session),
		db:       db,
	}
}

// Register 注册设备连接，支持传入 lastAckedSeq 用于重连补发。
func (h *Hub) Register(sessionID, userID string, deviceType domain.DeviceType, lastAckedSeq int64) (chan []byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		s = &Session{
			ID:      sessionID,
			UserID:  userID,
			Devices: make(map[domain.DeviceType]chan []byte),
			Created: time.Now(),
		}
		h.sessions[sessionID] = s
	}

	// 关闭旧 channel（重连场景）
	if oldCh, exists := s.Devices[deviceType]; exists {
		close(oldCh)
	}

	ch := make(chan []byte, 256)
	s.Devices[deviceType] = ch

	// 补发断连期间错过的消息
	if lastAckedSeq > 0 && h.db != nil {
		go h.replayMissed(sessionID, deviceType, lastAckedSeq, ch)
	}

	return ch, nil
}

// replayMissed 从 DB 查询 seq > lastAckedSeq 的事件并以 is_replay=true 补发。
func (h *Hub) replayMissed(sessionID string, deviceType domain.DeviceType, lastAckedSeq int64, ch chan []byte) {
	events, err := h.db.GetEventsSince(sessionID, lastAckedSeq)
	if err != nil || len(events) == 0 {
		return
	}

	for _, evt := range events {
		msg := &domain.DeviceMessage{
			Direction: "server_to_client",
			MessageID: uuid.New().String(),
			SessionID: sessionID,
			Seq:       lastAckedSeq + 1, // 近似值，后续可精确化
			IsReplay:  true,
			Timestamp: time.Now().UnixMilli(),
			Event:     evt,
			Overrides: nil,
		}

		data, err := json.Marshal(msg)
		if err != nil {
			continue
		}

		select {
		case ch <- data:
		default:
			log.Printf("hub: 补发 channel 已满 session=%s device=%s", sessionID, deviceType)
		}
	}
}
```

> **说明：** `replayMissed` 中的 `Seq` 值目前是近似值。如需精确 seq，需要在 Store 层让 `GetEventsSince` 同时返回 seq，或在 `UnifiedMessage` 中嵌入 seq。这在当前单设备场景下不影响功能，可在后续迭代中完善。

- [ ] **Step 2: 修改 hub.go — SendToDevice 写入 DB 并设置 Seq**

```go
// SendToDevice 向指定设备的 channel 发送消息，同时持久化事件。
func (h *Hub) SendToDevice(sessionID string, deviceType domain.DeviceType, msg *domain.DeviceMessage) error {
	h.mu.RLock()
	defer h.mu.RUnlock()

	s, ok := h.sessions[sessionID]
	if !ok {
		return ErrSessionNotFound
	}
	ch, ok := s.Devices[deviceType]
	if !ok {
		return ErrDeviceNotFound
	}

	// 持久化事件并获取 seq
	if h.db != nil && msg.Event != nil {
		seq, err := h.db.AppendEvent(sessionID, msg.Event)
		if err != nil {
			log.Printf("hub: 事件持久化失败: %v", err)
		} else {
			msg.Seq = seq
		}
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	select {
	case ch <- data:
		return nil
	default:
		// channel 满时不阻塞，依赖重连时补发机制
		log.Printf("hub: channel 已满 session=%s device=%s（消息丢失，重连时补发）", sessionID, deviceType)
		return nil
	}
}
```

- [ ] **Step 3: 修改 handler.go — 解析 last_acked_seq**

在 WebSocket 升级处理函数中，从 URL query 解析 `last_acked_seq`：

```go
// middleware-core/internal/ws/handler.go

// HandleUpgrade 中的变更部分：
func HandleUpgrade(
	w http.ResponseWriter, r *http.Request,
	hub *Hub, sessionID string, deviceType domain.DeviceType,
	onMessage OnMessageFunc,
) error {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}

	// 解析重连补发参数
	lastAckedSeq := int64(0)
	if seqStr := r.URL.Query().Get("last_acked_seq"); seqStr != "" {
		fmt.Sscanf(seqStr, "%d", &lastAckedSeq)
	}

	sendCh, err := hub.Register(sessionID, "", deviceType, lastAckedSeq)
	if err != nil {
		conn.Close()
		return err
	}

	// ... 其余处理逻辑不变 ...
}
```

- [ ] **Step 4: 修改 main.go — 初始化 SQLite 并传入 Hub**

```go
// middleware-core/cmd/server/main.go

import (
	// ... 现有 imports ...
	"agentbridge/internal/store/sqlite"
)

type Server struct {
	// ... 现有字段 ...
	db *sqlitestore.SQLiteStore  // 持久化存储
}

func main() {
	// 初始化 SQLite
	dbStore, err := sqlitestore.Open("agentbridge.db")
	if err != nil {
		log.Fatalf("无法打开数据库: %v", err)
	}
	defer dbStore.Close()

	srv := &Server{
		router:      chi.NewRouter(),
		hub:         ws.NewHub(dbStore),   // 传入持久化层
		stateMgr:    statemachine.New(),
		riskEng:     risk.NewAssessor(risk.DefaultRules()),
		dispatcher:  device.NewDispatcher(),
		approvalMgr: approval.NewManager(),
		notifyEng:   notify.NewEngine(notify.DefaultPolicies()),
		eventStore:  store.NewEventStore(200),
		db:          dbStore,
	}

	srv.setupRoutes()

	addr := ":8080"
	log.Printf("AgentBridge 中间层启动: %s (数据库=%s)", addr, "agentbridge.db")
	if err := http.ListenAndServe(addr, srv.router); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
```

- [ ] **Step 5: 编译验证**

```bash
cd middleware-core && go build ./...
```
期望结果: BUILD OK

- [ ] **Step 6: 提交**

```bash
git add middleware-core/internal/ws/hub.go middleware-core/internal/ws/handler.go middleware-core/cmd/server/main.go
git commit -m "feat: Hub 接入 SQLite，支持重连补发 + SendToDevice 自动持久化"
```

---

### Task 5: AgentAdapter 接口定义 + 事件类型

**涉及文件:**
- 创建: `agent-adapter/src/adapters/types.ts`

**接口契约:**
- 产出: `AgentAdapter` 接口, `AgentInput`, `AgentEvent`, `DeviceAction`, `AdapterCapability`

- [ ] **Step 1: 创建 types.ts**

```typescript
// agent-adapter/src/adapters/types.ts

/** 所有 AI Agent 适配器必须实现的统一接口 */
export interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapability[];

  /** 建立连接，初始化会话状态 */
  connect(): Promise<void>;

  /** 向 Agent 发送输入，返回异步事件流 */
  send(input: AgentInput): AsyncIterable<AgentEvent>;

  /** 处理来自设备的用户操作（审批、语音等） */
  handleUserAction(action: DeviceAction): Promise<void>;

  /** 断开连接，清理资源 */
  disconnect(): Promise<void>;
}

/** 发送给 Agent 的输入 */
export interface AgentInput {
  type: 'start_task' | 'user_message' | 'action_response';
  text?: string;
  action?: DeviceAction;
  taskId?: string;
  sessionId?: string;
}

/** 设备回传的用户操作 */
export interface DeviceAction {
  type: string;    // approve | reject | continue | pause | view_details
  deviceType: string;
  text?: string;   // Layer 3/4 语音输入（预留）
}

/** Agent 执行过程中产生的各类事件 */
export type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'needs_approval'; tool: string; risk: number; taskId?: string }
  | { type: 'task_started'; taskId: string }
  | { type: 'task_completed'; taskId: string; summary: string }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_blocked'; taskId: string; reason: string }
  | { type: 'done'; text: string };

/** 适配器能力声明 */
export type AdapterCapability = 'file_ops' | 'shell_exec' | 'code_search' | 'conversation';
```

- [ ] **Step 2: 提交**

```bash
git add agent-adapter/src/adapters/types.ts
git commit -m "feat: 定义 AgentAdapter 统一接口与 AgentEvent 事件类型"
```

---

### Task 6: Claude API Adapter 实现

**涉及文件:**
- 创建: `agent-adapter/src/adapters/claude-api.ts`

**接口契约:**
- 消费: `AgentAdapter`, `AgentInput`, `AgentEvent` (Task 5)
- 产出: `ClaudeAPIAdapter` 类，实现 `AgentAdapter`

- [ ] **Step 1: 安装 Anthropic SDK**

```bash
cd agent-adapter && npm install @anthropic-ai/sdk
```

- [ ] **Step 2: 创建 claude-api.ts**

```typescript
// agent-adapter/src/adapters/claude-api.ts

import Anthropic from '@anthropic-ai/sdk';
import type { AgentAdapter, AgentInput, AgentEvent, DeviceAction } from './types';

/**
 * Claude API 适配器 — 通过 Anthropic SDK 直接调用 Claude。
 * 支持 tool use、审批拦截、工具执行。
 */
export class ClaudeAPIAdapter implements AgentAdapter {
  readonly name = 'claude-api';
  readonly capabilities = ['file_ops', 'shell_exec', 'code_search', 'conversation'] as const;

  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private tools: Anthropic.Tool[] = [];

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
    this.tools = [
      {
        name: 'run_shell',
        description: '执行 shell 命令并返回输出结果',
        input_schema: {
          type: 'object' as const,
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            working_dir: { type: 'string', description: '工作目录' },
          },
          required: ['command'],
        },
      },
      {
        name: 'read_file',
        description: '读取文件内容',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: '文件的绝对路径' },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: '写入或覆盖文件',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: '写入目标路径' },
            content: { type: 'string', description: '文件内容' },
          },
          required: ['path', 'content'],
        },
      },
    ];
  }

  async connect(): Promise<void> {
    this.messages = [];
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    this.messages.push({
      role: 'user',
      content: input.text || (input.type === 'start_task' ? '开始执行任务' : '继续'),
    });

    while (true) {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: this.messages,
        tools: this.tools,
      });

      // 产出文本事件
      const textBlocks = response.content.filter(c => c.type === 'text');
      for (const block of textBlocks) {
        yield { type: 'text', content: block.text };
      }

      // 检查是否有工具调用
      const toolUses = response.content.filter(c => c.type === 'tool_use');
      if (toolUses.length === 0) {
        const summary = textBlocks.map(b => b.text).join('\n');
        yield { type: 'done', text: summary };
        return;
      }

      // 处理工具调用
      for (const tool of toolUses) {
        const risk = this.assessRisk(tool.name, tool.input as Record<string, unknown>);
        // 风险 >= 0.3 时暂停并请求用户审批
        if (risk >= 0.3) {
          yield { type: 'needs_approval', tool: tool.name, risk, taskId: tool.id };
          return; // 暂停执行，等待 handleUserAction 被调用
        }

        // 低风险工具直接执行
        yield { type: 'tool_call', tool: tool.name, args: tool.input };
        const result = await this.executeTool(tool.name, tool.input as Record<string, unknown>);

        this.messages.push({
          role: 'assistant',
          content: response.content,
        });
        this.messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: tool.id,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          }],
        });
      }
    }
  }

  async handleUserAction(action: DeviceAction): Promise<void> {
    if (action.type === 'approve') {
      this.messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: action.taskId || '',
          content: '用户已从设备端批准此操作，请继续执行。',
        }],
      });
    } else if (action.type === 'reject') {
      this.messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: action.taskId || '',
          content: '用户已从设备端拒绝此操作，请停止执行并提出替代方案。',
        }],
      });
    }
  }

  async disconnect(): Promise<void> {
    this.messages = [];
  }

  /** 评估工具调用的风险等级（0-1） */
  private assessRisk(toolName: string, _input: Record<string, unknown>): number {
    if (toolName === 'run_shell') return 0.3;
    if (toolName === 'write_file') return 0.2;
    return 0;
  }

  /** 在本地执行工具调用 */
  private async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<string> {
    switch (name) {
      case 'read_file': {
        const fs = await import('fs/promises');
        try {
          return await fs.readFile(String(input.path), 'utf-8');
        } catch (e) {
          return `读取文件失败: ${e}`;
        }
      }
      case 'write_file': {
        const fs = await import('fs/promises');
        try {
          await fs.writeFile(String(input.path), String(input.content));
          return `文件已写入: ${input.path}`;
        } catch (e) {
          return `写入文件失败: ${e}`;
        }
      }
      case 'run_shell': {
        const { exec } = await import('child_process');
        return new Promise((resolve) => {
          exec(String(input.command), { cwd: String(input.working_dir || '.') }, (err, stdout, stderr) => {
            resolve(err ? `执行错误: ${stderr}` : stdout);
          });
        });
      }
      default:
        return `未知工具: ${name}`;
    }
  }
}
```

- [ ] **Step 3: 验证编译**

```bash
cd agent-adapter && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add agent-adapter/src/adapters/claude-api.ts agent-adapter/package.json agent-adapter/package-lock.json
git commit -m "feat: Claude API 适配器 — tool use、审批拦截、工具执行"
```

---

### Task 7: Agent Hub 路由器 + 简化 Normalizer

**涉及文件:**
- 创建: `agent-adapter/src/hub.ts`
- 修改: `agent-adapter/src/normalizer.ts` — 删除正则分类规则，改为 AgentEvent 直接映射

**接口契约:**
- 消费: `AgentAdapter`, `AgentEvent` (Task 5), `ClaudeAPIAdapter` (Task 6)
- 产出: `AgentHub` 类, 简化后的 `EventNormalizer`

- [ ] **Step 1: 创建 hub.ts**

```typescript
// agent-adapter/src/hub.ts

import type { AgentAdapter, AgentInput, AgentEvent, DeviceAction } from './adapters/types';
import { ClaudeAPIAdapter } from './adapters/claude-api';

/**
 * Agent Hub — 多适配器路由器。
 * 按优先级选择适配器，支持降级链：claude-api → claude-cli。
 */
export class AgentHub {
  private adapters = new Map<string, AgentAdapter>();
  private active: AgentAdapter | null = null;

  constructor() {
    // 默认注册 Claude API 适配器
    this.register(new ClaudeAPIAdapter());
    // CLI fallback 由外部按需注册: hub.register(new ClaudeCodeAdapter({sessionId}))
  }

  /** 注册适配器 */
  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** 选择适配器：优先 claude-api，失败降级 claude-cli */
  async select(preferred?: string): Promise<AgentAdapter> {
    const order = preferred
      ? [preferred]
      : ['claude-api', 'claude-cli'];

    for (const name of order) {
      const adapter = this.adapters.get(name);
      if (adapter) {
        try {
          await adapter.connect();
          this.active = adapter;
          console.log(`[AgentHub] 当前适配器: ${adapter.name}`);
          return adapter;
        } catch (err) {
          console.warn(`[AgentHub] 适配器 ${name} 连接失败:`, err);
        }
      }
    }

    throw new Error('没有可用的 Agent 适配器');
  }

  /** 执行 Agent 任务，返回事件流 */
  async *execute(input: AgentInput): AsyncIterable<AgentEvent> {
    if (!this.active) throw new Error('尚未选择适配器');
    yield* this.active.send(input);
  }

  /** 将设备端的用户操作转发给当前适配器 */
  async handleUserAction(action: DeviceAction): Promise<void> {
    if (!this.active) throw new Error('尚未选择适配器');
    await this.active.handleUserAction(action);
  }

  /** 获取当前活跃适配器名称 */
  getActiveName(): string {
    return this.active?.name || '无';
  }

  /** 关闭当前适配器 */
  async shutdown(): Promise<void> {
    if (this.active) await this.active.disconnect();
  }
}
```

- [ ] **Step 2: 简化 normalizer.ts — 从正则分类改为直接映射**

删除原有的 `ClassificationRule[]` 数组（rules），替换为：

```typescript
// agent-adapter/src/normalizer.ts

import type { AgentEvent } from './adapters/types';
import { EventType, Severity, type UnifiedMessage } from './types';

/**
 * 事件规范化器 — 将 AgentEvent 直接映射为 UnifiedMessage。
 * V2 简化版：不再需要正则分类规则，Agent 适配器已产出结构化事件。
 */
export class EventNormalizer {
  constructor(private sessionId: string, private agentId = 'claude-code') {}

  /** 从 AgentEvent 直接映射为 UnifiedMessage */
  fromAgentEvent(event: AgentEvent): UnifiedMessage {
    const { eventType, title, body, severity } = this.mapEvent(event);

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      task_id: ('taskId' in event ? event.taskId : '') || this.sessionId,
      session_id: this.sessionId,
      event_type: eventType,
      title,
      body,
      severity,
      risk_score: 'risk' in event ? event.risk : 0,
      risk_blocked: false,
      available_actions: event.type === 'needs_approval'
        ? [
            { action_type: 'approve', label: '批准', confirmation_required: false },
            { action_type: 'reject', label: '拒绝', confirmation_required: false },
            { action_type: 'view_details', label: '查看详情', confirmation_required: false },
          ]
        : [],
      timestamp: new Date().toISOString(),
      agent_id: this.agentId,
    };
  }

  /** AgentEvent 类型 → UnifiedMessage 字段映射 */
  private mapEvent(event: AgentEvent): {
    eventType: EventType;
    title: string;
    body: string;
    severity: Severity;
  } {
    switch (event.type) {
      case 'task_started':
        return { eventType: 'task_started', title: event.taskId || '任务已启动',
          body: '任务开始执行', severity: 'info' };
      case 'tool_call':
        return { eventType: 'task_running', title: `执行: ${event.tool}`,
          body: JSON.stringify(event.args), severity: 'info' };
      case 'task_blocked':
        return { eventType: 'task_blocked', title: '任务阻塞',
          body: event.reason, severity: 'warning' };
      case 'needs_approval':
        return { eventType: 'needs_approval', title: `需要审批: ${event.tool}`,
          body: `风险评分: ${event.risk}`, severity: event.risk >= 0.7 ? 'critical' : 'warning' };
      case 'task_failed':
        return { eventType: 'task_failed', title: '任务失败',
          body: event.error, severity: 'critical' };
      case 'task_completed':
      case 'done':
        return { eventType: 'task_completed', title: '任务完成',
          body: event.type === 'done' ? event.text : event.summary, severity: 'info' };
      case 'text':
        return { eventType: 'task_running', title: 'Agent 输出',
          body: event.content.slice(0, 500), severity: 'info' };
    }
  }
}
```

- [ ] **Step 3: 验证编译**

```bash
cd agent-adapter && npx tsc --noEmit
```

- [ ] **Step 4: 提交**

```bash
git add agent-adapter/src/hub.ts agent-adapter/src/normalizer.ts
git commit -m "feat: AgentHub 多适配器路由器 + Normalizer 简化为直接映射"
```

---

### Task 8: 更新 index.ts 接入 Agent Hub

**涉及文件:**
- 修改: `agent-adapter/src/index.ts`

**接口契约:**
- 消费: `AgentHub` (Task 7), `ClaudeCodeAdapter`（保留作 fallback）

- [ ] **Step 1: 修改 index.ts 使用 AgentHub 替代直接 spawn**

```typescript
// agent-adapter/src/index.ts

import { AgentHub } from './hub';
import { ClaudeCodeAdapter } from './adapters/claude';
import { EventNormalizer } from './normalizer';
import { AgentBridgeClient } from './ws-client';
import type { DeviceAction } from './adapters/types';

async function main() {
  const sessionId = process.env.SESSION_ID || `session-${Date.now()}`;
  const hub = new AgentHub();

  // 注册 CLI fallback
  hub.register(new ClaudeCodeAdapter({ sessionId }));

  // 选择适配器（优先 claude-api，失败则降级 claude-cli）
  const adapter = await hub.select();

  // 初始化规范化器和 WS 客户端
  const normalizer = new EventNormalizer(sessionId, adapter.name);
  const wsClient = new AgentBridgeClient({
    serverUrl: process.env.CORE_URL || 'http://localhost:8080',
    sessionId,
  });

  // 监听设备回传的用户操作，转发给 Agent
  wsClient.on('user_action', async (action: DeviceAction) => {
    console.log(`[AgentHub] 收到用户操作: ${action.type} (来自 ${action.deviceType})`);
    await hub.handleUserAction(action);
    // 继续 Agent 执行
    for await (const event of hub.execute({ type: 'action_response', action })) {
      const msg = normalizer.fromAgentEvent(event);
      await wsClient.sendEvent(msg);
    }
  });

  wsClient.connect();

  // 主循环：发送初始任务，处理 Agent 事件流
  console.log(`[AgentHub] 启动任务，适配器: ${adapter.name}`);
  for await (const event of hub.execute({
    type: 'start_task',
    text: process.argv[2],
    sessionId,
  })) {
    const msg = normalizer.fromAgentEvent(event);
    await wsClient.sendEvent(msg);
  }

  console.log('[AgentHub] 任务执行完毕');
  await hub.shutdown();
  wsClient.close();
}

main().catch(err => {
  console.error('[AgentHub] 致命错误:', err);
  process.exit(1);
});
```

- [ ] **Step 2: 验证编译**

```bash
cd agent-adapter && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add agent-adapter/src/index.ts
git commit -m "feat: index.ts 接入 AgentHub，支持多适配器降级链"
```

---

### Task 9: 重连补发集成测试

**涉及文件:**
- 创建: `mock-device/reconnect-test.js`

**接口契约:**
- 消费: Core WS 端点，通过 `last_acked_seq` 查询参数触发补发

- [ ] **Step 1: 创建 reconnect-test.js**

```javascript
// mock-device/reconnect-test.js
// 测试场景：设备断连 → Core 持续收事件 → 设备重连带 last_acked_seq → 补发丢失事件

const WebSocket = require('ws');

const SERVER = process.env.SERVER || 'http://localhost:8080';
const WS_BASE = SERVER.replace(/^http/, 'ws');
const SESSION = 'reconnect-' + Date.now();
const DEVICE = 'ar_glasses';
const RECEIVE_TIMEOUT = 5000;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) { console.log(`  PASS: ${name}`); passed++; }
  else { console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

function postEvent(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL('/api/v1/events', SERVER);
    const http = require('http');
    const req = http.request({
      hostname: url.hostname, port: url.port || 8080, path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function waitForMessage(ws, predicate, timeoutMs = RECEIVE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg); }
      } catch (_) { /* 忽略解析错误 */ }
    };
    ws.on('message', handler);
  });
}

async function run() {
  console.log('\n  AgentBridge — 重连补发集成测试\n');
  console.log(`  会话: ${SESSION}`);

  // 1. 连接设备，发送前两条事件
  let ws = new WebSocket(`${WS_BASE}/ws/${SESSION}?device_type=${DEVICE}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('连接超时')), 3000);
  });
  console.log('  [1] 设备已连接');

  // 记录收到的 seq
  let lastSeq = 0;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.seq > 0) lastSeq = msg.seq;
    } catch (_) { /* 跳过 */ }
  });

  // 发送事件 1: task_started
  const msg1Promise = waitForMessage(ws, m => m.event?.event_type === 'task_started');
  await postEvent({
    id: 'rc-1', task_id: 'task-rc', session_id: SESSION,
    event_type: 'task_started', title: '构建开始', body: '正在启动构建流程',
    severity: 'info', risk_score: 0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'test',
  });
  const msg1 = await msg1Promise;
  check('收到 task_started', msg1?.event?.event_type === 'task_started');
  check('消息包含 seq 字段', typeof msg1.seq === 'number' && msg1.seq > 0,
    `seq=${msg1.seq}`);
  const ackedSeq = msg1.seq;

  // 发送事件 2: needs_approval（断连前发送）
  const msg2Promise = waitForMessage(ws, m => m.event?.event_type === 'needs_approval');
  await postEvent({
    id: 'rc-2', task_id: 'task-rc', session_id: SESSION,
    event_type: 'needs_approval', title: '审批: 部署到生产环境', body: '确认部署到生产服务器？',
    severity: 'warning', risk_score: 0.8, risk_blocked: false,
    available_actions: [{ action_type: 'approve', label: '批准', confirmation_required: false }],
    timestamp: new Date().toISOString(), agent_id: 'test',
  });
  const msg2 = await msg2Promise;
  check('收到 needs_approval（事件2）', msg2?.event?.event_type === 'needs_approval');

  // 2. 模拟设备断连
  ws.close();
  console.log('  [2] 设备已断开连接');

  // 等待 Core 感知断连
  await new Promise(r => setTimeout(r, 500));

  // 3. 在设备离线期间发送事件 3（应存入 DB）
  await postEvent({
    id: 'rc-3', task_id: 'task-rc', session_id: SESSION,
    event_type: 'task_completed', title: '构建完成', body: '构建成功',
    severity: 'info', risk_score: 0, risk_blocked: false, available_actions: [],
    timestamp: new Date().toISOString(), agent_id: 'test',
  });
  console.log('  [3] 设备离线期间已发送事件 #3（应入库）');

  // 等待入库完成
  await new Promise(r => setTimeout(r, 300));

  // 4. 设备重连，携带 last_acked_seq
  ws = new WebSocket(`${WS_BASE}/ws/${SESSION}?device_type=${DEVICE}&last_acked_seq=${ackedSeq}`);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('重连超时')), 3000);
  });
  console.log(`  [4] 设备已重连（last_acked_seq=${ackedSeq}）`);

  // 5. 验证收到补发事件
  const replayedIds = [];
  const replayedPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(replayedIds), 3000);
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.is_replay) {
          replayedIds.push(msg.event?.id);
          console.log(`  [补发] 收到重放事件: ${msg.event?.id} (${msg.event?.event_type})`);
          if (msg.event?.id === 'rc-3') {
            clearTimeout(timer);
            resolve(replayedIds);
          }
        }
      } catch (_) { /* 跳过 */ }
    });
  });
  await replayedPromise;

  check('补发了丢失的事件 (rc-3)', replayedIds.includes('rc-3'),
    `补发事件列表: [${replayedIds.join(', ')}]`);
  check('补发消息标记了 is_replay=true', replayedIds.length > 0);

  // 汇总
  console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('测试错误:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 运行集成测试**

```bash
# 终端 1: 启动 Core
cd middleware-core && go run cmd/server/main.go

# 终端 2: 运行重连测试
cd mock-device && node reconnect-test.js
```

期望结果: 6 项全部 PASS，关键验证点：
- `补发了丢失的事件 (rc-3)` — 确认 DB 存储 + 查询 + 补发链路完整
- `补发消息标记了 is_replay=true` — 确认设备可区分实时/补发消息
- `消息包含 seq 字段` — 确认 Seq 字段正确写入

- [ ] **Step 3: 提交**

```bash
git add mock-device/reconnect-test.js
git commit -m "test: 添加重连补发集成测试（断连→入库→重连→补发）"
```

---

### Task 10: approval.Manager 与 notify.Engine 回归测试

之前已修复这两个模块的并发安全 bug（Manager.NeedsRetry 写锁、Engine 冷却豁免），本任务补充回归测试防止问题复现。

**涉及文件:**
- 创建: `middleware-core/internal/approval/manager_test.go`
- 创建: `middleware-core/internal/notify/engine_test.go`

- [ ] **Step 1: 创建 approval/manager_test.go**

```go
// middleware-core/internal/approval/manager_test.go

package approval

import (
	"testing"
	"time"

	"agentbridge/internal/domain"
)

func TestNeedsRetry_Success(t *testing.T) {
	m := NewManager()
	record, err := m.Create("task-1", "sess-1", domain.DeviceGlass, 30*time.Second, 3)
	if err != nil {
		t.Fatalf("创建审批失败: %v", err)
	}

	// 第一次调用 NeedsRetry 应该允许重试
	ok, delay := m.NeedsRetry(record.ID)
	if !ok {
		t.Fatal("首次应允许重试")
	}
	if delay <= 0 {
		t.Errorf("重试延迟应 > 0，实际为 %v", delay)
	}

	// 确认重试计数已递增
	a, _ := m.GetByTask("task-1")
	if a.RetryCount != 1 {
		t.Errorf("重试次数应为 1，实际为 %d", a.RetryCount)
	}
}

func TestNeedsRetry_ExceedsMax(t *testing.T) {
	m := NewManager()
	record, _ := m.Create("task-2", "sess-1", domain.DeviceGlass, 30*time.Second, 2)

	// 用完所有重试次数
	m.NeedsRetry(record.ID)
	m.NeedsRetry(record.ID)

	// 第三次应拒绝
	ok, _ := m.NeedsRetry(record.ID)
	if ok {
		t.Error("超过最大重试次数后不应再允许重试")
	}
}

func TestResolveApproval(t *testing.T) {
	m := NewManager()
	record, _ := m.Create("task-3", "sess-1", domain.DeviceGlass, 30*time.Second, 3)

	// 批准审批
	resolved, err := m.Resolve(record.ID, true)
	if err != nil {
		t.Fatalf("处理审批失败: %v", err)
	}
	if resolved.Status != StatusApproved {
		t.Errorf("状态应为 approved，实际为 %s", resolved.Status)
	}
}

func TestResolveApproval_Reject(t *testing.T) {
	m := NewManager()
	record, _ := m.Create("task-4", "sess-1", domain.DeviceGlass, 30*time.Second, 3)

	resolved, err := m.Resolve(record.ID, false)
	if err != nil {
		t.Fatalf("处理审批失败: %v", err)
	}
	if resolved.Status != StatusRejected {
		t.Errorf("状态应为 rejected，实际为 %s", resolved.Status)
	}
}
```

- [ ] **Step 2: 创建 notify/engine_test.go**

```go
// middleware-core/internal/notify/engine_test.go

package notify

import (
	"testing"
	"time"

	"agentbridge/internal/domain"
)

func TestShouldSend_NeedsApprovalBypassesCooldown(t *testing.T) {
	policies := map[domain.DeviceType]*Policy{
		domain.DeviceGlass: {
			Mode:        ModeInstant,
			MinSeverity: domain.SeverityInfo,
			CoolDown:    10 * time.Second,
		},
	}
	eng := NewEngine(policies)

	// 先发送一条 task_started，触发冷却计时
	eng.MarkSent(domain.DeviceGlass, "sess-1", "task-1")

	// 立即发送 needs_approval — 必须在冷却期内也能通过
	msg := &domain.UnifiedMessage{
		EventType: domain.EventNeedsApproval,
		Title:     "需要审批", Body: "测试内容",
		Severity: domain.SeverityWarning,
	}
	if !eng.ShouldSend(domain.DeviceGlass, "sess-1", "task-1", msg) {
		t.Error("needs_approval 应绕过冷却期限制")
	}
}

func TestShouldSend_TaskBlockedBypassesCooldown(t *testing.T) {
	policies := map[domain.DeviceType]*Policy{
		domain.DeviceGlass: {Mode: ModeInstant, MinSeverity: domain.SeverityInfo, CoolDown: 10 * time.Second},
	}
	eng := NewEngine(policies)
	eng.MarkSent(domain.DeviceGlass, "sess-1", "task-1")

	msg := &domain.UnifiedMessage{
		EventType: domain.EventTaskBlocked,
		Title:     "任务阻塞", Body: "测试内容",
		Severity: domain.SeverityWarning,
	}
	if !eng.ShouldSend(domain.DeviceGlass, "sess-1", "task-1", msg) {
		t.Error("task_blocked 应绕过冷却期限制")
	}
}

func TestShouldSend_TaskRunningRespectsCooldown(t *testing.T) {
	policies := map[domain.DeviceType]*Policy{
		domain.DeviceGlass: {Mode: ModeInstant, MinSeverity: domain.SeverityInfo, CoolDown: 10 * time.Second},
	}
	eng := NewEngine(policies)
	eng.MarkSent(domain.DeviceGlass, "sess-1", "task-1")

	msg := &domain.UnifiedMessage{
		EventType: domain.EventTaskRunning,
		Title:     "正在执行", Body: "测试内容",
		Severity: domain.SeverityInfo,
	}
	if eng.ShouldSend(domain.DeviceGlass, "sess-1", "task-1", msg) {
		t.Error("task_running 应被冷却期拦截（同任务刚发过通知）")
	}
}

func TestShouldSend_DifferentTasksNoCooldown(t *testing.T) {
	policies := map[domain.DeviceType]*Policy{
		domain.DeviceGlass: {Mode: ModeInstant, MinSeverity: domain.SeverityInfo, CoolDown: 10 * time.Second},
	}
	eng := NewEngine(policies)
	eng.MarkSent(domain.DeviceGlass, "sess-1", "task-1")

	// 不同任务不受冷却限制
	msg := &domain.UnifiedMessage{
		EventType: domain.EventTaskRunning,
		Title:     "另一个任务", Body: "测试内容",
		Severity: domain.SeverityInfo,
	}
	if !eng.ShouldSend(domain.DeviceGlass, "sess-1", "task-2", msg) {
		t.Error("不同任务不应被冷却期拦截")
	}
}
```

- [ ] **Step 3: 运行测试**

```bash
cd middleware-core && go test ./internal/approval/ -v && go test ./internal/notify/ -v
```

期望结果全部 PASS:
- `TestNeedsRetry_Success` — 重试递增正常
- `TestNeedsRetry_ExceedsMax` — 超限拒绝正常
- `TestResolveApproval` / `TestResolveApproval_Reject` — 批准/拒绝状态切换正常
- `TestShouldSend_NeedsApprovalBypassesCooldown` — 审批事件豁免冷却
- `TestShouldSend_TaskBlockedBypassesCooldown` — 阻塞事件豁免冷却
- `TestShouldSend_TaskRunningRespectsCooldown` — 普通事件遵守冷却
- `TestShouldSend_DifferentTasksNoCooldown` — 不同任务不受冷却限制

- [ ] **Step 4: 提交**

```bash
git add middleware-core/internal/approval/manager_test.go middleware-core/internal/notify/engine_test.go
git commit -m "test: 补充 approval 重试逻辑和 notify 冷却豁免的回归测试"
```

---

### Task 11: 更新 CLAUDE.md 记录架构变更

**涉及文件:**
- 修改: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md 的当前状态部分**

在文件末尾的"数据库 / 认证 **待开发**"行之前，追加：

```markdown
### V2 架构更新 (2026-07-26)

| 改动 | 说明 |
|------|------|
| SQLite 持久化 | `middleware-core/internal/store/sqlite/` — 事件/ack/审批落盘，WAL 模式 |
| 消息补发 | Hub.Register 支持 last_acked_seq → 断连重连后自动补发未确认事件 |
| Agent 多适配器 | `agent-adapter/src/adapters/types.ts` — 统一 AgentAdapter 接口 |
| Claude API 适配器 | `agent-adapter/src/adapters/claude-api.ts` — 主用，tool use + 审批拦截 |
| Agent Hub | `agent-adapter/src/hub.ts` — 路由器，优先 API 降级 CLI |
| 协议向前兼容 | DeviceMessage.Seq/IsReplay, ClientMessage.LastAckedSeq, ClientAction.Text |
| 通知冷却修复 | needs_approval 和 task_blocked 事件不受冷却期压制 |
| 安全修复 | approval.Manager.NeedsRetry 并发写锁、risk 正则预编译、ID 生成改用 uuid |
| 测试覆盖 | dispatcher 27 cases, SQLite 3 cases, approval 4 cases, notify 4 cases |

### 降级链

```
首选: Claude API Adapter (@anthropic-ai/sdk, tool use 原生支持)
  ↓ API 不可用时
兜底: Claude Code CLI spawn（原方案保留，正则解析 stdout）
```

### 协议新增字段

| 字段 | 类型 | 方向 | 用途 |
|------|------|------|------|
| DeviceMessage.Seq | int64 | 服务端→设备 | 单调序列号，设备用于追踪确认进度 |
| DeviceMessage.IsReplay | bool | 服务端→设备 | 标记该消息为补发，设备可据此去重 |
| ClientMessage.LastAckedSeq | int64 | 设备→服务端 | 重连时告知最后确认的 seq，触发补发 |
| ClientAction.Text | string | 设备→服务端 | Layer 3/4 语音输入（预留） |
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 记录 V2 架构变更"
```

---

### Task 12: 全量验证

- [ ] **Step 1: 运行所有 Go 测试**

```bash
cd middleware-core && go test ./... -count=1
```
期望结果: 全部 PASS（包括新增的 store、approval、notify 测试）

- [ ] **Step 2: 端到端启动验证**

```bash
# 终端 1: 启动 Core
cd middleware-core && go run cmd/server/main.go
# 期望输出: "AgentBridge 中间层启动: :8080 (数据库=agentbridge.db)"

# 终端 2: 运行基础往返测试
cd mock-device && node roundtrip-test.js
# 期望: 8 PASS

# 终端 3: 运行重连补发测试
cd mock-device && node reconnect-test.js
# 期望: 6 PASS
```

- [ ] **Step 3: 验证 DB 文件生成**

```bash
ls -la middleware-core/agentbridge.db
```
期望结果: SQLite 文件存在且大小 > 0

- [ ] **Step 4: 验证 Agent Adapter 编译**

```bash
cd agent-adapter && npx tsc --noEmit
```
期望结果: 无类型错误

- [ ] **Step 5: 最终提交**

```bash
git add -A
git commit -m "chore: Phase 1 全量验证通过 — 所有测试 PASS，端到端往返+补发正常"
```

---

## 验证清单（Phase 1 完成标准）

- [ ] Core 编译通过 (`go build ./...`)
- [ ] Agent Adapter 编译通过 (`npx tsc --noEmit`)
- [ ] SQLite 单元测试 3/3 PASS
- [ ] Approval 回归测试 4/4 PASS
- [ ] Notify 回归测试 4/4 PASS
- [ ] Dispatcher 回归测试 27/27 PASS
- [ ] Roundtrip 集成测试 8/8 PASS
- [ ] Reconnect 集成测试 6/6 PASS
- [ ] agentbridge.db 文件正常生成
- [ ] CLAUDE.md 已更新
