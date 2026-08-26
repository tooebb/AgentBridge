package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"agentbridge/internal/domain"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ClientHandler manages the lifecycle of a single WebSocket connection.
type ClientHandler struct {
	hub         *Hub
	conn        *websocket.Conn
	sessionID   string
	deviceType  domain.DeviceType
	sendCh      chan []byte
	onMessage   func(sessionID string, msg *domain.ClientMessage)
	isDashboard bool
	mu          sync.Mutex
	closeOnce   sync.Once
}

// OnMessageFunc is the callback for incoming client-to-server messages.
type OnMessageFunc func(sessionID string, msg *domain.ClientMessage)

// HandleDashboardUpgrade upgrades a dashboard WebSocket connection and
// subscribes it to all events across all sessions.
func HandleDashboardUpgrade(w http.ResponseWriter, r *http.Request, hub *Hub) error {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}

	sendCh := hub.SubscribeDashboard()
	handler := &ClientHandler{
		hub:         hub,
		conn:        conn,
		sessionID:   "dashboard",
		deviceType:  "dashboard",
		sendCh:      sendCh,
		isDashboard: true,
	}

	go handler.readPump()
	go handler.writePump()
	return nil
}

// HandleUpgrade upgrades an HTTP connection to WebSocket and spawns
// read/write goroutines.
func HandleUpgrade(
	w http.ResponseWriter,
	r *http.Request,
	hub *Hub,
	sessionID string,
	deviceType domain.DeviceType,
	replayMessages []*domain.DeviceMessage,
	onMessage OnMessageFunc,
) error {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}

	sendCh, err := hub.Register(sessionID, "", deviceType)
	if err != nil {
		conn.Close()
		return err
	}

	for _, msg := range replayMessages {
		data, err := json.Marshal(msg)
		if err != nil {
			conn.Close()
			hub.Unregister(sessionID, deviceType, sendCh)
			return err
		}
		select {
		case sendCh <- data:
		default:
			log.Printf("ws: replay queue full session=%s device=%s seq=%d", sessionID, deviceType, msg.Seq)
		}
	}

	handler := &ClientHandler{
		hub:        hub,
		conn:       conn,
		sessionID:  sessionID,
		deviceType: deviceType,
		sendCh:     sendCh,
		onMessage:  onMessage,
	}

	go handler.readPump()
	go handler.writePump()
	return nil
}

func (h *ClientHandler) readPump() {
	defer func() {
		h.closeOnce.Do(func() {
			if h.isDashboard {
				h.hub.UnsubscribeDashboard(h.sendCh)
			} else {
				h.hub.Unregister(h.sessionID, h.deviceType, h.sendCh)
			}
		})
	}()

	h.conn.SetReadLimit(4096)
	h.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	h.conn.SetPongHandler(func(string) error {
		h.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := h.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("ws: read error: %v", err)
			}
			break
		}

		var msg domain.ClientMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("ws: invalid message: %v", err)
			continue
		}

		if h.onMessage != nil {
			h.onMessage(h.sessionID, &msg)
		}
	}
}

func (h *ClientHandler) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		h.closeOnce.Do(func() {
			if h.isDashboard {
				h.hub.UnsubscribeDashboard(h.sendCh)
			} else {
				h.hub.Unregister(h.sessionID, h.deviceType, h.sendCh)
			}
		})
	}()

	for {
		select {
		case message, ok := <-h.sendCh:
			if !ok {
				h.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			h.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := h.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			h.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := h.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
