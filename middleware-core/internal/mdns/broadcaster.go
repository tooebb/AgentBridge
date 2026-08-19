package mdns

import (
	"strconv"
	"strings"

	"github.com/grandcat/zeroconf"
)

// ParsePort extracts the TCP port from a listen address.
// Supports ":8088", "127.0.0.1:8088", and empty (defaults to 8080).
func ParsePort(addr string) int {
	if addr == "" {
		return 8080
	}
	if i := strings.LastIndex(addr, ":"); i >= 0 {
		if p, err := strconv.Atoi(addr[i+1:]); err == nil {
			return p
		}
	}
	return 8080
}

// Start broadcasts _agentbridge._tcp on all interfaces.
// Returns a shutdown func that sends the mDNS goodbye packet.
func Start(port int, id, session string) (shutdown func(), err error) {
	server, err := zeroconf.Register(
		"AgentBridge-"+id,
		"_agentbridge._tcp",
		"local.",
		port,
		[]string{"id=" + id, "session=" + session, "version=1"},
		nil,
	)
	if err != nil {
		return nil, err
	}
	return server.Shutdown, nil
}
