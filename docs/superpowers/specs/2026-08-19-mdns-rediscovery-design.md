# mDNS 重发现（运行中 IP 漂移恢复）设计

**状态：** 已评审，待实施
**日期：** 2026-08-19
**前置：** mDNS 服务发现已实现并真机验证（`docs/superpowers/specs/2026-08-19-mdns-service-discovery-design.md`）

## 目标

让眼镜 App 在**运行中**当 PC IP 漂移（DHCP 续租导致 IP 变化）或 Core 换址重启时，自动重新执行 mDNS 发现并恢复连接，替代当前「永远重连启动时解析出的旧 IP、直到手动重启 app」的行为。

## 问题

当前连接链路的缺陷（`AgentBridgeClient.kt` + `MainViewModel.kt`）：

1. `AgentBridgeClient.serverUrl` 是 `val`，在构造时写死（来自启动时 mDNS 解析结果）。
2. 断线重连 `onFailure`/`onClosed` → `scheduleReconnect` → `connect()`，指数退避 2s→30s，但**永远连同一个 `serverUrl`**。
3. mDNS 发现只在 app 启动时跑一次（`startDiscovery`）；`onServiceLost` 为空实现；`connectResolved` 的 `connectionStarted` guard 与 `createClient` 的 `if (agentClient != null) return` 主动阻止重建 client。

**后果**：启动后若 PC IP 从 `192.168.31.209` 漂移到 `192.168.31.185`，眼镜会对着旧 IP 无限重连，直到手动重启 app。

## 方案（Option A：重连失败阈值 → 重新发现）

在「旧地址确实已死」时才重新发现，瞬断仍走快重连，发现失败自然落回手动 IP / ADB 隧道（复用现有 resolve 降级链）。

### 阈值：连续重连失败 > 60s（时间基准）

- 语义清晰：「最多 60s 无连接就重新发现」，与退避参数解耦。
- 覆盖 Core 慢重启（同 IP，10-20s）与 WiFi 抖动，不误触发。
- 即便误触发也无害：重发现会解析出同一 IP，代价仅 5s 发现超时 + 重建 client。

### 组件改动

**`AgentBridgeClient.kt`**
- 新增 `private var reconnectStartedAt: Long = 0`。
- 第一次 `onFailure`/`onClosed` 时若为 0 则记 `System.currentTimeMillis()`；`onOpen` 成功时清零。
- `scheduleReconnect` 中判断 `now - reconnectStartedAt > STALE_MS`（`60_000`），超时通过 Listener 新增回调 `onStale()` 发出信号（不复用字符串 `onConnectionChanged`）。
- 阈值判断抽成纯函数（便于单测）：`fun shouldRediscover(firstFailureAt: Long, now: Long): Boolean`。

**`MainViewModel.kt`**
- `Listener` 实现新增 `onStale()` 处理：先拆旧 client（`old?.disconnect()`）→ 置空 `agentClient = null` → 重置 `connectionStarted = false` → 重跑 `startDiscovery`。
- **保留** `connectResolved` 的 `connectionStarted` guard 与 `createClient` 的 `if (agentClient != null) return`（它们防止启动时多个 mDNS 服务重复建连）；`onStale` 里先重置这两个状态再重发现，使重发现能通过 guard 建新 client。

## 边界情况

- **重发现解析出同一 IP**（Core 慢重启）：无碍，正常重连。
- **重发现为空**：`ConnectionResolver.resolve(emptyList(), config)` 落回手动 IP / ADB 隧道。
- **seq 状态**：重建 client 时 `connect()` 重置 seq（现有逻辑），与「Core 重启 seq 重置」语义一致。
- **并发**：`onStale` 触发重发现期间，旧 client 已 `disconnect`（`closedByUser = true` 阻止其重连循环继续），不会双连接。

## 测试

- **单测（TDD）**：`AgentBridgeClient.shouldRediscover(firstFailureAt, now)` 纯函数 —— 阈值内 false、超阈值 true、边界（`now - firstFailureAt == 60_000`）判定。
- **真机 E2E**：连接后拔网线/停 Core 改 IP 重启，观察眼镜 ~60s 内自动重发现并重连到新 IP（Core 日志 `from <新 IP>`）。

## 不改动

- Core 协议、`AgentBridgeClient` 消息协议、审批链路全部不变。
- `ConnectionResolver` 及其单测不变（只新增消费路径）。
