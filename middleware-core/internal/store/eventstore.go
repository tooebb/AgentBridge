package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"agentbridge/internal/domain"

	_ "modernc.org/sqlite"
)

// EventStore keeps a sliding window of recent DeviceMessages per session.
type EventStore struct {
	mu        sync.RWMutex
	maxEvents int
	events    map[string][]*domain.DeviceMessage // sessionID → ordered events
	nextSeq   map[string]int64
	acks      map[string]map[domain.DeviceType]int64
	db        *sql.DB
}

// NewEventStore creates a store with max events per session.
func NewEventStore(maxEvents int) *EventStore {
	return &EventStore{
		maxEvents: maxEvents,
		events:    make(map[string][]*domain.DeviceMessage),
		nextSeq:   make(map[string]int64),
		acks:      make(map[string]map[domain.DeviceType]int64),
	}
}

// NewSQLiteEventStore creates an event store backed by SQLite.
func NewSQLiteEventStore(path string, maxEvents int) (*EventStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite event store: %w", err)
	}
	db.SetMaxOpenConns(1)

	es := NewEventStore(maxEvents)
	es.db = db
	if err := es.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	if err := es.loadSeqs(); err != nil {
		db.Close()
		return nil, err
	}
	return es, nil
}

// Close releases the underlying SQLite handle when one is configured.
func (es *EventStore) Close() error {
	if es.db == nil {
		return nil
	}
	return es.db.Close()
}

// Append adds an event to the session's ring buffer and returns its seq.
func (es *EventStore) Append(sessionID string, msg *domain.DeviceMessage) (int64, error) {
	es.mu.Lock()
	defer es.mu.Unlock()

	seq := msg.Seq
	if seq <= 0 {
		seq = es.nextSeq[sessionID] + 1
	}
	msg.Seq = seq
	msg.IsReplay = false
	es.nextSeq[sessionID] = seq

	buf := es.events[sessionID]
	buf = append(buf, msg)
	if len(buf) > es.maxEvents {
		buf = buf[len(buf)-es.maxEvents:]
	}
	es.events[sessionID] = buf

	if es.db != nil {
		if err := es.insertEventLocked(sessionID, msg); err != nil {
			return seq, err
		}
	}
	return seq, nil
}

// Recent returns the most recent events for a session (newest last).
func (es *EventStore) Recent(sessionID string) []*domain.DeviceMessage {
	es.mu.RLock()
	db := es.db
	defer es.mu.RUnlock()

	buf := es.events[sessionID]
	if len(buf) == 0 && db != nil {
		return es.recentDB(sessionID)
	}
	out := make([]*domain.DeviceMessage, len(buf))
	copy(out, buf)
	return out
}

// ReplaySince returns messages with seq greater than lastAckedSeq.
func (es *EventStore) ReplaySince(sessionID string, lastAckedSeq int64) ([]*domain.DeviceMessage, error) {
	es.mu.RLock()
	db := es.db
	es.mu.RUnlock()

	if db != nil {
		return es.replaySinceDB(sessionID, lastAckedSeq)
	}

	es.mu.RLock()
	defer es.mu.RUnlock()

	buf := es.events[sessionID]
	out := make([]*domain.DeviceMessage, 0, len(buf))
	for _, msg := range buf {
		if msg.Seq > lastAckedSeq {
			out = append(out, cloneForReplay(msg))
		}
	}
	return out, nil
}

// UpdateDeviceAck stores the last seq acknowledged by a device.
func (es *EventStore) UpdateDeviceAck(sessionID string, deviceType domain.DeviceType, seq int64) error {
	es.mu.Lock()
	defer es.mu.Unlock()

	if es.acks[sessionID] == nil {
		es.acks[sessionID] = make(map[domain.DeviceType]int64)
	}
	es.acks[sessionID][deviceType] = seq

	if es.db == nil {
		return nil
	}
	_, err := es.db.Exec(
		`INSERT INTO device_acks (session_id, device_type, last_acked_seq, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_id, device_type)
		 DO UPDATE SET last_acked_seq=excluded.last_acked_seq, updated_at=excluded.updated_at`,
		sessionID, string(deviceType), seq, time.Now().UnixMilli(),
	)
	return err
}

// DeviceAck returns the last seq acknowledged by a device.
func (es *EventStore) DeviceAck(sessionID string, deviceType domain.DeviceType) (int64, error) {
	es.mu.RLock()
	if byDevice := es.acks[sessionID]; byDevice != nil {
		seq, ok := byDevice[deviceType]
		if ok {
			es.mu.RUnlock()
			return seq, nil
		}
	}
	db := es.db
	es.mu.RUnlock()

	if db == nil {
		return 0, nil
	}
	var seq int64
	err := db.QueryRow(
		"SELECT last_acked_seq FROM device_acks WHERE session_id=? AND device_type=?",
		sessionID, string(deviceType),
	).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return seq, err
}

// Sessions returns all known session IDs.
func (es *EventStore) Sessions() []string {
	es.mu.RLock()
	defer es.mu.RUnlock()

	seen := make(map[string]bool, len(es.events))
	ids := make([]string, 0, len(es.events))
	for id := range es.events {
		seen[id] = true
		ids = append(ids, id)
	}
	if es.db != nil {
		rows, err := es.db.Query("SELECT DISTINCT session_id FROM events ORDER BY session_id")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var id string
				if rows.Scan(&id) == nil && !seen[id] {
					seen[id] = true
					ids = append(ids, id)
				}
			}
		}
	}
	return ids
}

func (es *EventStore) migrate() error {
	_, err := es.db.Exec(`
		CREATE TABLE IF NOT EXISTS events (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			message_id TEXT NOT NULL,
			raw_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, seq)
		);
		CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);

		CREATE TABLE IF NOT EXISTS device_acks (
			session_id TEXT NOT NULL,
			device_type TEXT NOT NULL,
			last_acked_seq INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, device_type)
		);
	`)
	return err
}

func (es *EventStore) loadSeqs() error {
	rows, err := es.db.Query("SELECT session_id, MAX(seq) FROM events GROUP BY session_id")
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var sessionID string
		var seq sql.NullInt64
		if err := rows.Scan(&sessionID, &seq); err != nil {
			return err
		}
		if seq.Valid {
			es.nextSeq[sessionID] = seq.Int64
		}
	}
	return rows.Err()
}

func (es *EventStore) insertEventLocked(sessionID string, msg *domain.DeviceMessage) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = es.db.Exec(
		`INSERT OR REPLACE INTO events (session_id, seq, message_id, raw_json, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		sessionID, msg.Seq, msg.MessageID, string(raw), time.Now().UnixMilli(),
	)
	return err
}

func (es *EventStore) replaySinceDB(sessionID string, lastAckedSeq int64) ([]*domain.DeviceMessage, error) {
	rows, err := es.db.Query(
		"SELECT raw_json FROM events WHERE session_id=? AND seq>? ORDER BY seq ASC",
		sessionID, lastAckedSeq,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*domain.DeviceMessage
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var msg domain.DeviceMessage
		if err := json.Unmarshal([]byte(raw), &msg); err != nil {
			return nil, err
		}
		out = append(out, cloneForReplay(&msg))
	}
	return out, rows.Err()
}

func (es *EventStore) recentDB(sessionID string) []*domain.DeviceMessage {
	rows, err := es.db.Query(
		`SELECT raw_json FROM (
			SELECT seq, raw_json FROM events WHERE session_id=? ORDER BY seq DESC LIMIT ?
		) ORDER BY seq ASC`,
		sessionID, es.maxEvents,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var out []*domain.DeviceMessage
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil
		}
		var msg domain.DeviceMessage
		if err := json.Unmarshal([]byte(raw), &msg); err != nil {
			return nil
		}
		out = append(out, &msg)
	}
	return out
}

func cloneForReplay(msg *domain.DeviceMessage) *domain.DeviceMessage {
	cp := *msg
	cp.IsReplay = true
	return &cp
}
