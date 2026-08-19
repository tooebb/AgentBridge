# mDNS 服务发现设计（眼镜无线自动寻址）

**日期：** 2026-08-19
**阶段：** Phase 3 — 无线连接正解（替代 LAN 直连硬编码 IP）
**状态：** 设计阶段
**前置：** Phase 2（ADB 隧道 ✅ 已验证）、lessons_learned #9（LAN 硬编码 IP 漂移失效）

---

## 1. 目标与背景

### 1.1 问题

眼镜 App 走 LAN 直连时硬编码 PC IP `192.168.31.209`（commit `33a291e`）。PC 无线网卡 DHCP 动态分配，IP 漂移（209→185）后眼镜 "WS: retry" 连不上。给 PC 加静态 IP/alias 会断网（`netsh add address` 丢 DNS；FlClash TUN 重连），走不通。

WiFi 传输本身没问题（spike 已验证：眼镜 ping PC 0% 丢包、`curl :8088/health` 返回 ok），**缺的是「眼镜自动知道 PC 的 IP」**——寻址，不是传输。

### 1.2 目标

眼镜无线**自动发现** PC 上 Core 的地址并直连，替代硬编码 IP。完整降级链：

```
mDNS 自动发现（首选） → 手动指定 IP → ADB 反向隧道（有线兜底）
```

### 1.3 非目标

- 不改 Core 协议、不改 `AgentBridgeClient` 的消息协议（只改「连哪个地址」）
- 不做通用服务发现生态 / 多设备路由 / 手机端中枢
- 不解决跨网段（眼镜与 PC 必须同一 WiFi 二层网络）

### 1.4 Spike 结论（2026-08-19）

| 风险 | 结果 | 证据 |
|---|---|---|
| R1: Rokid 精简 ROM 缺 NSD | ✅ 排除 | `/system/bin/mdnsd`(971KB 完整 AOSP 二进制) 在跑并监听 `0.0.0.0:5353`；`/dev/socket/mdns` 存在；`mdnsd.rc` 标准配置且 `disabled+oneshot`（说明是被框架 NsdService 按需拉起的） |
| R2: WiFi 屏蔽组播（AP 隔离） | ✅ 排除 | PC 网卡观测到来自 `192.168.31.206`（另一台设备）的 mDNS 查询流量 → 组播在客户端间自由流动 |
| PC mDNS 广播能力 | ✅ 通过 | Node `bonjour` 广播 `_agentbridge._tcp` 成功，自解析到 `192.168.31.185:8088` |

> 说明：`service list` / `dumpsys -l` 返回 "error: closed" 是 shell 命令被阉割，**不代表** mDNS 栈缺失；`mdnsd` 正在运行是栈可用的直接证据。

---

## 2. 架构

```
PC (Core, Go) ──mDNS 广播 _agentbridge._tcp (id/port/session)──▶ WiFi 组播 224.0.0.251:5353
                                                                      │
                                                         眼镜 (NsdManager 发现)
                                                                      │
                                                取 host+port → ws://<host>:<port> 直连 Core
```

- **Core 承担广播**：启动时广播自身服务，端口取自实际监听地址，地址自动跟随网卡，无需知道自己的 LAN IP。
- **眼镜承担发现**：`NsdManager.discoverServices("_agentbridge._tcp")`，解析 host/port 后直连。
- **多 PC 身份匹配**：Core 广播带稳定 `id`（默认主机名），眼镜配置 `preferred_pc_id`，优先连 id 匹配的实例，避免误连同一 WiFi 下其他 PC 的 Core。

---

## 3. 详细设计

### 3.1 Core 端 mDNS 广播

**新增文件：** `middleware-core/internal/mdns/broadcaster.go`

- 库：`github.com/grandcat/zeroconf`（纯 Go、跨平台、仅 advertise 即可，无需原生编译）。
- 服务类型：`_agentbridge._tcp`
- 实例名：`AgentBridge-<hostname>`（如 `AgentBridge-LAPTOP-6Q267J0S`）
- 端口：从 `AGENTBRIDGE_ADDR` 解析（默认 `:8080` → `8080`；本项目实际 `:8088`）
- TXT 记录：
  - `id=<hostname>`（默认 `os.Hostname()`，可用 `AGENTBRIDGE_INSTANCE_ID` 覆盖）
  - `session=default`
  - `version=1`
- 生命周期：`main()` 在 `http.ListenAndServe` 前启动广播；进程退出时 `Shutdown()` 发送 goodbye。

**接口（供 main 调用）：**

```go
package mdns

// Start broadcasts _agentbridge._tcp on all interfaces.
// Returns a shutdown func. port is the TCP port Core listens on.
func Start(port int, id, session string) (shutdown func(), err error)
```

### 3.2 眼镜端 mDNS 发现

**改造文件：** `MainViewModel.kt`（`startAgentBridge` 中替换硬编码 LAN 段，约 line 220-240）

**新增权限：** 眼镜 App 的 `AndroidManifest.xml` 增加
`<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />`
（缺失会导致 NsdManager 静默收不到组播）。

**发现流程（替换当前 `pcIp = "192.168.31.209"` 段）：**

1. 获取 `NsdManager`：`context.getSystemService(Context.NSD_SERVICE)`。
2. `discoverServices("_agentbridge._tcp", PROTOCOL_DNS_SD, listener)`。
3. `onServiceFound` → `resolveService` 拿 host/port/txt。
4. 按 id 匹配规则选出目标实例（见 3.3），取出 `host:port`。
5. 超时（默认 5s）内无匹配 → 走降级链（手动 IP → ADB 隧道）。
6. 连接前保留现有 TCP 探测（`Socket.connect` 5s）再 `createClient`。

**发现保活：** NsdManager 有 ~5 分钟回调失效的已知坑。MVP 用定时器每 3 分钟 `stopServiceDiscovery` 后重新 `discoverServices`（发现阶段由后台协程/Handler 驱动，不阻塞主线程）。

### 3.3 连接优先级与多 PC 冲突

解析出服务后，按以下规则选目标：

1. **id 匹配优先**：若 `preferred_pc_id` 非空，且某实例的 `txt["id"] == preferred_pc_id` → 选它。
2. **兜底取第一个**：`preferred_pc_id` 为空，或没有实例匹配 → 取第一个发现的实例。
3. `onServiceLost` → 若正是当前连接的目标，断开并触发一次重发现。

### 3.4 降级链

| 优先级 | 方式 | 连接地址 | 触发条件 |
|---|---|---|---|
| 1 | mDNS 发现 | `ws://<发现的host>:<port>` | 发现到匹配实例 |
| 2 | 手动 IP | `ws://<manual_pc_ip>:<manual_pc_port>` | mDNS 超时且配置里有 IP |
| 3 | ADB 隧道 | `ws://127.0.0.1:19090` | 以上均无（有线兜底，Phase 2 已验证） |

### 3.5 手动 IP 配置（SharedPreferences）

配置存 `SharedPreferences("agent_bridge")`（`AgentBridgeClient` 已用同名 prefs，复用）：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `manual_pc_ip` | String | `""` | 手动指定的 PC IP（空 = 未设置） |
| `manual_pc_port` | Int | `8088` | 手动 IP 对应的端口 |
| `preferred_pc_id` | String | `""` | 优先连接的 Core id（空 = 取第一个） |

**写入方式：** debug build 下用 `run-as com.rokid.cxrswithcxrl` 写 shared_prefs XML；封装进 `scripts/deploy-apk.ps1` 或一个独立小脚本（如 `scripts/set-glasses-config.ps1`），一条命令设 IP / id。若 `run-as` 不可用，降级为 `/sdcard` 配置文件 + `chmod 644`（lessons_learned #5 已验证的路径）。

---

## 4. 数据流（真机端到端）

```
Core 启动 → mdns.Start(8088, "LAPTOP-...", "default")
眼镜启动 startAgentBridge → NsdManager.discoverServices
  → onServiceFound(resolve) → host=192.168.31.185 port=8088 txt.id=LAPTOP-...
  → preferred_pc_id 匹配（或取第一个）→ ws://192.168.31.185:8088
  → TCP 探测 OK → createClient → 后续审批链路不变
```

---

## 5. 技术选型

| 端 | 库/API | 理由 |
|---|---|---|
| Core (Go 1.26) | `grandcat/zeroconf` | 纯 Go、无 cgo、跨平台、API 简单（`Register` 一行广播） |
| 眼镜 (Kotlin, Android 12 SDK 32) | `android.net.nsd.NsdManager` | 系统 API，spike 已验证 ROM 支持 |

---

## 6. 测试策略

### Core（Go 表驱动，`internal/mdns/broadcaster_test.go`）

- `Start` 能注册并返回可调用的 shutdown（不 panic）。
- 端口解析：`AGENTBRIDGE_ADDR` 各形态（`:8088` / `127.0.0.1:8088` / 空）→ 正确端口。
- 不依赖真实网络：用 zeroconf 自带 `Register` 的注册/关闭语义，或注入 fake（若 Start 接口暴露足够信息）。

### 眼镜（真机，spike 已铺路）

- 场景 1：PC 广播 → 眼镜自动发现 → 直连成功（替代硬编码）。
- 场景 2：PC 不广播 → 配置了 `manual_pc_ip` → 连手动 IP。
- 场景 3：PC 不广播且无手动 IP → 回退 `ws://127.0.0.1:19090`（需 ADB 隧道）。
- 场景 4：两台 PC 同时广播 → `preferred_pc_id` 命中目标那台。
- 场景 5：连上后 PC 断网重连 → `onServiceLost` 触发重发现。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| NsdManager 在精简 ROM 上仍可能返回空 | 降级链兜底：手动 IP / ADB 隧道，不因 mDNS 失败而无法使用 |
| FlClash TUN 干扰组播 / 多网卡 | zeroconf 全接口广播，WiFi 网卡必在列；若 TUN 抢地址，用 `id` 匹配 + 手动 IP 兜底 |
| 眼镜端 MulticastLock 未持有导致收不到 | 发现阶段 `acquire MulticastLock`，`onCleared` 释放 |
| 多 PC 误连 | `preferred_pc_id` 匹配 + 取第一个兜底（单 PC 场景无歧义） |
| NsdManager 5 分钟回调失效 | 3 分钟周期重发现 |

---

## 8. 交付物清单

1. `middleware-core/internal/mdns/broadcaster.go` + 测试（新增）
2. `middleware-core/cmd/server/main.go`（`main()` 接入 `mdns.Start`）
3. `MainViewModel.kt`（发现流程 + 降级链替换硬编码）
4. 眼镜 `AndroidManifest.xml`（新增 `CHANGE_WIFI_MULTICAST_STATE`）
5. `scripts/set-glasses-config.ps1`（写 `manual_pc_ip` / `preferred_pc_id`，新增）
6. `CLAUDE.md` / 记忆（更新连接模式状态：LAN 直连 → mDNS）
