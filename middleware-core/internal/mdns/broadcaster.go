package mdns

import (
	"log"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

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
	var mu sync.Mutex
	var server *zeroconf.Server
	stopped := false

	register := func() error {
		srv, err := zeroconf.Register(
			"AgentBridge-"+id,
			"_agentbridge._tcp",
			"local.",
			port,
			[]string{"id=" + id, "session=" + session, "version=1"},
			nil,
		)
		if err != nil {
			return err
		}

		mu.Lock()
		defer mu.Unlock()
		if stopped {
			srv.Shutdown()
			return nil
		}
		if server != nil {
			server.Shutdown()
		}
		server = srv
		return nil
	}

	if err := register(); err != nil {
		return nil, err
	}

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()

		last := currentIPv4Set()
		for {
			select {
			case <-ticker.C:
				cur := currentIPv4Set()
				if !cur.equal(last) {
					if err := register(); err != nil {
						log.Printf("mdns: re-register after IP change failed: %v", err)
					} else {
						last = cur
					}
				}
			case <-done:
				return
			}
		}
	}()

	var shutdownOnce sync.Once
	return func() {
		shutdownOnce.Do(func() {
			close(done)
			mu.Lock()
			defer mu.Unlock()
			stopped = true
			if server != nil {
				server.Shutdown()
				server = nil
			}
		})
	}, nil
}

type ipv4Set []string

func currentIPv4Set() ipv4Set {
	addrs := make([]string, 0)
	ifaces, err := net.Interfaces()
	if err != nil {
		log.Printf("mdns: failed to list interfaces: %v", err)
		return nil
	}

	for _, iface := range ifaces {
		ifaceAddrs, err := iface.Addrs()
		if err != nil {
			log.Printf("mdns: failed to list addresses for %s: %v", iface.Name, err)
			continue
		}
		addrs = append(addrs, trackIPv4s(iface.Flags, ifaceAddrs)...)
	}

	sort.Strings(addrs)
	return ipv4Set(addrs)
}

// trackIPv4s returns the IPv4 addresses that should drive mDNS change
// detection for one interface. It mirrors zeroconf's listMulticastInterfaces:
// only UP + multicast-capable, non-loopback interfaces are broadcast, so only
// those IPs matter. Virtual adapters (Tailscale/FlClash TUN, link-local-only
// NICs) are UP but not multicast, so their address churn must not trigger
// spurious re-registers.
func trackIPv4s(flags net.Flags, addrs []net.Addr) []string {
	if flags&net.FlagUp == 0 || flags&net.FlagLoopback != 0 || flags&net.FlagMulticast == 0 {
		return nil
	}
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		ip := ipv4FromAddr(addr)
		if ip == "" || ip == "0.0.0.0" {
			continue
		}
		out = append(out, ip)
	}
	return out
}

func ipv4FromAddr(addr net.Addr) string {
	var ip net.IP
	switch v := addr.(type) {
	case *net.IPNet:
		ip = v.IP
	case *net.IPAddr:
		ip = v.IP
	default:
		return ""
	}
	if ip4 := ip.To4(); ip4 != nil {
		return ip4.String()
	}
	return ""
}

func (s ipv4Set) equal(other ipv4Set) bool {
	if len(s) != len(other) {
		return false
	}
	for i := range s {
		if s[i] != other[i] {
			return false
		}
	}
	return true
}
