# Codex 交接：连接/自愈 3 个 PC 端 bug（2026-08-26）

本轮范围：**只修下面 3 个 PC 端 bug，全部无需真机**，单测 + PC 冒烟即可验收。眼镜端 #89 与条件 WakeLock 留到下一批（需重建 APK + 真机）。

工作区当前干净（分支 `agent/recovered`，已与 origin 同步）。开工前 `git status --short --branch` 应无输出。

---

## 0. 三个 bug 一句话概览

| # | 文件 | 一句话 |
|---|------|--------|
| Bug B | `agent-adapter/src/relay.ts` | relay 没订阅 wsClient 的 `error` 事件，Core 重启 → 未捕获异常崩溃 |
| #88 | `middleware-core/internal/ws/hub.go` | 同名设备重复注册覆盖旧 channel，且旧连接断开会误杀新连接 |
| Bug A | `middleware-core/internal/mdns/broadcaster.go` | mDNS 只在启动注册一次，IP 漂移后仍广播旧 IP |

---

## 1. Bug B：relay 在 Core 重启时崩溃

**文件**：`agent-adapter/src/relay.ts`（`main()`，约 178 行）

**根因**：`main()` 里只 `wsClient.on('user_action', ...)`，没订阅 `error`。当 Core 重启，`AgentBridgeClient`（`ws-client.ts:79-81`）把底层 WS 的 error 转发成 `this.emit('error', err)`；重连耗尽时 `ws-client.ts:125` 又 `emit('error', new Error('Max reconnect attempts reached'))`。Node 的 EventEmitter 对无监听的 `'error'` 抛 uncaught exception → 进程崩。

**修法**：在 `main()` 里 `wsClient.connect()` 之前加一行（参照 `agent-adapter/src/session.ts` 已有同款写法）：

```ts
wsClient.on('error', (err) => {
  console.error('[relay] ws error:', err instanceof Error ? err.message : err);
});
```

**验收**：Core 重启后 relay 进程不退出，Core 恢复后自动重连继续工作（`ws-client.ts` 已有指数退避 2s→30s、最多 10 次）。

---

## 2. #88：Core hub 同名设备重复连接覆盖

**文件**：`middleware-core/internal/ws/hub.go`（`Register` 35-54 行、`Unregister` 57-72 行）+ `handler.go`（readPump/writePump 的 defer 调用点，116、157 行）

**根因（两个后果）**：

`Register` 里 `s.Devices[deviceType] = ch` 直接覆盖，不 close 旧 channel：

```go
ch := make(chan []byte, 256)
s.Devices[deviceType] = ch   // 旧 channel 泄漏
return ch, nil
```

后果一：旧连接（已被覆盖）的 `writePump` 还在 `select` 读旧 channel，但 `SendToDevice` 只发到新 channel → 旧连接僵死（连着但收不到消息）。

后果二：`Unregister(sessionID, deviceType)` 不分 channel，直接 `close(s.Devices[deviceType])`。旧连接稍后断开时，会 close 掉**新连接**的 channel（因为 `Devices[deviceType]` 已经指向新 channel）→ 误杀活跃连接。

**修法**：让 `Unregister` 变成 channel 感知，且 `Register` 覆盖时先 close 旧 channel：

```go
// Register：覆盖前 close 旧 channel，触发旧连接退出
if old, ok := s.Devices[deviceType]; ok {
    close(old)
    log.Printf("hub: replacing existing device %s in session %s", deviceType, sessionID)
}
ch := make(chan []byte, 256)
s.Devices[deviceType] = ch
return ch, nil
```

```go
// Unregister：加 channel 参数，只有当前 channel 匹配才 close+delete
func (h *Hub) Unregister(sessionID string, deviceType domain.DeviceType, ch chan []byte) {
    h.mu.Lock()
    defer h.mu.Unlock()
    s, ok := h.sessions[sessionID]
    if !ok {
        return
    }
    if cur, ok2 := s.Devices[deviceType]; ok2 && cur == ch {
        close(cur)
        delete(s.Devices, deviceType)
    }
    if len(s.Devices) == 0 {
        delete(h.sessions, sessionID)
    }
}
```

`handler.go` 里两处 `h.hub.Unregister(h.sessionID, h.deviceType)` 改为 `h.hub.Unregister(h.sessionID, h.deviceType, h.sendCh)`（readPump 116 行、writePump 157 行）。

**测试**：`hub.go` 当前无测试，新建 `middleware-core/internal/ws/hub_test.go`，至少覆盖：
- 同名 deviceType 第二次 Register → 旧 channel 被 close（`<-old` 返回 ok=false）
- 旧连接 Unregister（传旧 channel）后，新 channel 仍可用（`SendToDevice` 不报 `ErrDeviceNotFound`）
- 不同 session 互不影响

**验收**：`go test ./internal/ws/` 通过；`go test -race ./internal/ws/` 无竞态。

---

## 3. Bug A：Core mDNS 不随 IP 漂移重新注册

**文件**：`middleware-core/internal/mdns/broadcaster.go`（`Start` 26-39 行）

**根因**：`Start()` 只在启动时 `zeroconf.Register` 一次，返回 `server.Shutdown` 就结束。PC 无线网卡 DHCP 漂移后（两天内实测 209→185→186），Core 仍广播旧 IP；眼镜端重发现拿到的还是旧 IP（因为 Core 还在广播它）。

**修法**：`Start()` 内启动一个 goroutine，周期检测本机非回环 IPv4 集合变化，变了就 `Shutdown` 旧 server + 重新 `Register`。保持返回的 `shutdown` 语义不变（供 `main.go:83` 的 `defer shutdown()` 使用）：

```go
func Start(port int, id, session string) (shutdown func(), err error) {
    var mu sync.Mutex
    var server *zeroconf.Server

    register := func() error {
        srv, err := zeroconf.Register(
            "AgentBridge-"+id, "_agentbridge._tcp", "local.", port,
            []string{"id=" + id, "session=" + session, "version=1"}, nil,
        )
        if err != nil {
            return err
        }
        mu.Lock()
        if server != nil {
            server.Shutdown()
        }
        server = srv
        mu.Unlock()
        return nil
    }

    if err := register(); err != nil {
        return nil, err
    }

    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        last := currentIPv4Set()
        for range ticker.C {
            if cur := currentIPv4Set(); !cur.equal(last) {
                last = cur
                if err := register(); err != nil {
                    log.Printf("mdns: re-register after IP change failed: %v", err)
                }
            }
        }
    }()

    return func() {
        mu.Lock()
        if server != nil {
            server.Shutdown()
        }
        server = nil
        mu.Unlock()
    }, nil
}
```

其中 `currentIPv4Set()` 枚举 `net.Interfaces()` 的所有非回环、非 `0.0.0.0` 的 IPv4 地址，返回一个可比较的值（如排序后 join 的字符串，或 `map[string]struct{}` 配自定义 equal）。这个函数是纯函数，可单测。

**测试**：`broadcaster_test.go` 已有 `TestParsePort`，新增针对 `currentIPv4Set()` / 变化检测的纯函数测试（不依赖真实 zeroconf 网络）。真实 IP 漂移的重注册行为用真机验证（本轮可跳过，标为验收项）。

**验收**：`go test ./internal/mdns/` 通过；`go build ./...` 无编译错。真机验收（下一批）：改 PC 网卡 IP 后眼镜无需手动操作即重连。

---

## 4. 建议顺序与提交

每个 bug 独立可测、独立提交：

1. Bug B（1 行，`relay.ts`）→ `fix: relay 订阅 wsClient error 防止 Core 重启崩溃`
2. #88（hub.go + handler.go + 新测试）→ `fix: hub 同名设备重复注册覆盖旧连接`
3. Bug A（broadcaster.go + 新测试）→ `fix: core mDNS 随 IP 漂移周期重注册`

全部在 PC 端，改完 `go build ./...` / `npm run build`（agent-adapter 若需要）+ 各自单测通过即可。不需要真机。
