package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"agentbridge/internal/approval"
	"agentbridge/internal/device"
	"agentbridge/internal/domain"
	"agentbridge/internal/notify"
	"agentbridge/internal/risk"
	"agentbridge/internal/statemachine"
	"agentbridge/internal/store"
	"agentbridge/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

// Server is the main middleware server, wiring all components together.
type Server struct {
	router      *chi.Mux
	hub         *ws.Hub
	stateMgr    *statemachine.Machine
	riskEng     *risk.Assessor
	dispatcher  *device.Dispatcher
	approvalMgr *approval.Manager
	notifyEng   *notify.Engine
	eventStore  *store.EventStore
}

func main() {
	srv := &Server{
		router:      chi.NewRouter(),
		hub:         ws.NewHub(),
		stateMgr:    statemachine.New(),
		riskEng:     risk.NewAssessor(risk.DefaultRules()),
		dispatcher:  device.NewDispatcher(),
		approvalMgr: approval.NewManager(),
		notifyEng:   notify.NewEngine(notify.DefaultPolicies()),
		eventStore:  store.NewEventStore(200),
	}

	srv.setupRoutes()

	addr := ":8080"
	log.Printf("AgentBridge Middleware Core starting on %s", addr)
	if err := http.ListenAndServe(addr, srv.router); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func (s *Server) setupRoutes() {
	s.router.Use(middleware.Logger)
	s.router.Use(middleware.Recoverer)
	s.router.Use(middleware.RequestID)
	s.router.Use(middleware.RealIP)

	// Health check.
	s.router.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Agent Adapter submits events (PC side).
	s.router.Post("/api/v1/events", s.handleAgentEvent)

	// WebSocket endpoint for devices (phone/watch/glass).
	s.router.Get("/ws/{sessionID}", s.handleWebSocket)

	// WebSocket endpoint for dashboard (receives all events).
	s.router.Get("/ws/dashboard", s.handleDashboardWS)

	// REST: list active sessions.
	s.router.Get("/api/v1/sessions", s.handleListSessions)

	// REST: recent events for a session.
	s.router.Get("/api/v1/events/{sessionID}", s.handleSessionEvents)
}

// ---------- REST handler for Agent Adapter ----------

func (s *Server) handleAgentEvent(w http.ResponseWriter, r *http.Request) {
	var msg domain.UnifiedMessage
	if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if msg.ID == "" {
		msg.ID = uuid.New().String()
	}
	if msg.Timestamp.IsZero() {
		msg.Timestamp = time.Now()
	}

	// 1. State machine transition.
	newState, err := s.stateMgr.Transition(msg.TaskID, msg.SessionID, msg.EventType)
	if err != nil {
		log.Printf("server: invalid state transition: %v (got event %s for task %s)",
			err, msg.EventType, msg.TaskID)
		// Don't reject the event; classify it as a state-less notification.
	}

	// 2. Risk assessment.
	riskScore, riskBlocked := s.riskEng.Evaluate(&msg)
	msg.RiskScore = riskScore
	msg.RiskBlocked = riskBlocked

	// 3. If needs_approval, create an approval record.
	if msg.EventType == domain.EventNeedsApproval {
		approvalRec := s.approvalMgr.Create(msg.TaskID, msg.SessionID, msg.ID, riskScore)
		log.Printf("server: created approval %s for task %s (risk=%.2f blocked=%v)",
			approvalRec.ID, msg.TaskID, riskScore, riskBlocked)
	}

	// 4. Device dispatch.
	overrides := s.dispatcher.Transform(&msg)

	deviceMsg := &domain.DeviceMessage{
		Direction: "server_to_client",
		MessageID: uuid.New().String(),
		SessionID: msg.SessionID,
		Timestamp: time.Now().UnixMilli(),
		Event:     &msg,
		Overrides: overrides,
	}

	// 5. Notification check + send.
	devices := s.hub.ConnectedDevices(msg.SessionID)
	for _, dt := range devices {
		if s.notifyEng.ShouldSend(dt, msg.SessionID, msg.TaskID, &msg) {
			if err := s.hub.SendToDevice(msg.SessionID, dt, deviceMsg); err != nil {
				log.Printf("server: send to %s failed: %v", dt, err)
			} else {
				s.notifyEng.MarkSent(dt, msg.SessionID, msg.TaskID)
			}
		}
	}

	// 6. Store event and broadcast to dashboards.
	s.eventStore.Append(msg.SessionID, deviceMsg)
	s.hub.BroadcastToDashboard(deviceMsg)

	log.Printf("server: event %s -> state %s (task=%s session=%s risk=%.2f devices=%d)",
		msg.EventType, newState, msg.TaskID, msg.SessionID, riskScore, len(devices))

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]any{
		"message_id":   deviceMsg.MessageID,
		"task_state":   newState,
		"risk_score":   riskScore,
		"risk_blocked": riskBlocked,
	})
}

// ---------- WebSocket handler for devices ----------

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	deviceTypeStr := r.URL.Query().Get("device_type")
	if deviceTypeStr == "" {
		deviceTypeStr = "phone"
	}
	deviceType := domain.DeviceType(deviceTypeStr)

	log.Printf("ws: new connection session=%s device=%s", sessionID, deviceType)

	if err := ws.HandleUpgrade(w, r, s.hub, sessionID, deviceType, s.onDeviceMessage); err != nil {
		log.Printf("ws: upgrade failed: %v", err)
		http.Error(w, `{"error":"websocket upgrade failed"}`, http.StatusBadRequest)
		return
	}
}

// onDeviceMessage is called when a device sends an action back.
func (s *Server) onDeviceMessage(sessionID string, msg *domain.ClientMessage) {
	log.Printf("server: received action %s from device %s (session=%s task=%s)",
		msg.Action.Type, msg.Action.DeviceType, sessionID, msg.TaskID)

	switch msg.Action.Type {
	case domain.ActionApprove, domain.ActionReject:
		// Resolve the approval.
		approvalRec, err := s.approvalMgr.GetByTask(msg.TaskID)
		if err != nil {
			log.Printf("server: no active approval for task %s: %v", msg.TaskID, err)
			return
		}

		approved := msg.Action.Type == domain.ActionApprove
		resolved, err := s.approvalMgr.Resolve(approvalRec.ID, approved)
		if err != nil {
			log.Printf("server: approval resolve failed: %v", err)
			return
		}
		log.Printf("server: approval %s resolved as %s", resolved.ID, resolved.Status)

		// Transition state back to running.
		s.stateMgr.Transition(msg.TaskID, sessionID, domain.EventTaskRunning)

	case domain.ActionContinue:
		s.stateMgr.Transition(msg.TaskID, sessionID, domain.EventTaskRunning)

	case domain.ActionPause:
		s.stateMgr.ForceSet(msg.TaskID, sessionID, domain.TaskStatePaused)

	case domain.ActionViewDetails:
		// TODO: push a raw evidence payload back to the device.
		log.Printf("server: view_details requested for task %s by device %s",
			msg.TaskID, msg.Action.DeviceType)
	}
}

// ---------- Dashboard handlers ----------

func (s *Server) handleDashboardWS(w http.ResponseWriter, r *http.Request) {
	if err := ws.HandleDashboardUpgrade(w, r, s.hub); err != nil {
		log.Printf("ws: dashboard upgrade failed: %v", err)
		http.Error(w, `{"error":"websocket upgrade failed"}`, http.StatusBadRequest)
		return
	}
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	type sessionInfo struct {
		ID            string   `json:"id"`
		Devices       []string `json:"devices"`
		Created       int64    `json:"created"`
		EventCount    int      `json:"event_count"`
		LastEventType string   `json:"last_event_type,omitempty"`
	}

	// Merge hub sessions and event store sessions.
	seen := make(map[string]bool)
	var out []sessionInfo

	for _, sess := range s.hub.GetSessions() {
		devices := make([]string, 0, len(sess.Devices))
		for dt := range sess.Devices {
			devices = append(devices, string(dt))
		}
		events := s.eventStore.Recent(sess.ID)
		info := sessionInfo{
			ID:         sess.ID,
			Devices:    devices,
			Created:    sess.Created.UnixMilli(),
			EventCount: len(events),
		}
		if len(events) > 0 {
			info.LastEventType = string(events[len(events)-1].Event.EventType)
		}
		out = append(out, info)
		seen[sess.ID] = true
	}

	for _, sid := range s.eventStore.Sessions() {
		if seen[sid] {
			continue
		}
		events := s.eventStore.Recent(sid)
		info := sessionInfo{
			ID:         sid,
			EventCount: len(events),
		}
		if len(events) > 0 {
			info.LastEventType = string(events[len(events)-1].Event.EventType)
		}
		out = append(out, info)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	events := s.eventStore.Recent(sessionID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(events)
}
