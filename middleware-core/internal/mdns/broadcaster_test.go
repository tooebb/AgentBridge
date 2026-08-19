package mdns

import "testing"

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
