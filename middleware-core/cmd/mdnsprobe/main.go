package main

import (
	"context"
	"fmt"
	"time"

	"github.com/grandcat/zeroconf"
)

func main() {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		fmt.Println("resolver err:", err)
		return
	}
	entries := make(chan *zeroconf.ServiceEntry, 16)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := resolver.Lookup(ctx, "", "_agentbridge._tcp", "local.", entries); err != nil {
		fmt.Println("lookup err:", err)
		return
	}
	found := false
	for e := range entries {
		found = true
		fmt.Printf("FOUND Instance=%s Host=%s Port=%d IPs=%v\n", e.Instance, e.HostName, e.Port, e.AddrIPv4)
	}
	if !found {
		fmt.Println("NOT FOUND")
	}
}
