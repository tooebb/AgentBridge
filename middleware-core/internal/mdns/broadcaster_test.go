package mdns

import (
	"net"
	"testing"
)

func TestParsePort(t *testing.T) {
	cases := []struct {
		addr string
		want int
	}{
		{":8088", 8088},
		{"127.0.0.1:8088", 8088},
		{":8080", 8080},
		{"", 8080},
		{"0.0.0.0:19090", 19090},
	}
	for _, c := range cases {
		if got := ParsePort(c.addr); got != c.want {
			t.Errorf("ParsePort(%q) = %d, want %d", c.addr, got, c.want)
		}
	}
}

func TestIPv4SetEqual(t *testing.T) {
	if !(ipv4Set{"10.0.0.2", "192.168.1.5"}).equal(ipv4Set{"10.0.0.2", "192.168.1.5"}) {
		t.Fatal("expected identical sets to be equal")
	}
	if (ipv4Set{"10.0.0.2"}).equal(ipv4Set{"10.0.0.3"}) {
		t.Fatal("expected changed address to be unequal")
	}
	if (ipv4Set{"10.0.0.2"}).equal(ipv4Set{"10.0.0.2", "192.168.1.5"}) {
		t.Fatal("expected changed set length to be unequal")
	}
}

func TestIPv4FromAddr(t *testing.T) {
	cases := []struct {
		name string
		addr net.Addr
		want string
	}{
		{
			name: "ip net",
			addr: &net.IPNet{IP: net.ParseIP("192.168.1.5"), Mask: net.CIDRMask(24, 32)},
			want: "192.168.1.5",
		},
		{
			name: "ip addr",
			addr: &net.IPAddr{IP: net.ParseIP("10.0.0.2")},
			want: "10.0.0.2",
		},
		{
			name: "ipv6 ignored",
			addr: &net.IPNet{IP: net.ParseIP("fe80::1"), Mask: net.CIDRMask(64, 128)},
			want: "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ipv4FromAddr(c.addr); got != c.want {
				t.Fatalf("ipv4FromAddr() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestTrackIPv4s(t *testing.T) {
	wlanV4 := &net.IPNet{IP: net.ParseIP("192.168.10.7"), Mask: net.CIDRMask(24, 32)}
	tailscaleV4 := &net.IPNet{IP: net.ParseIP("100.117.117.37"), Mask: net.CIDRMask(32, 32)}
	linkLocal := &net.IPNet{IP: net.ParseIP("169.254.1.1"), Mask: net.CIDRMask(16, 32)}

	cases := []struct {
		name  string
		flags net.Flags
		addrs []net.Addr
		want  []string
	}{
		{
			name:  "wlan multicast includes its IPv4",
			flags: net.FlagUp | net.FlagMulticast,
			addrs: []net.Addr{wlanV4},
			want:  []string{"192.168.10.7"},
		},
		{
			name:  "virtual adapter up but not multicast is excluded",
			flags: net.FlagUp,
			addrs: []net.Addr{tailscaleV4},
			want:  nil,
		},
		{
			name:  "loopback excluded",
			flags: net.FlagUp | net.FlagMulticast | net.FlagLoopback,
			addrs: []net.Addr{&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)}},
			want:  nil,
		},
		{
			name:  "link-local on multicast interface is tracked",
			flags: net.FlagUp | net.FlagMulticast,
			addrs: []net.Addr{linkLocal},
			want:  []string{"169.254.1.1"},
		},
		{
			name:  "down interface excluded",
			flags: net.FlagMulticast,
			addrs: []net.Addr{wlanV4},
			want:  nil,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := trackIPv4s(c.flags, c.addrs)
			if len(got) != len(c.want) {
				t.Fatalf("trackIPv4s() = %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("trackIPv4s() = %v, want %v", got, c.want)
				}
			}
		})
	}
}
