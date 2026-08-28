# 手机中继（Tailscale 跨网络）设计

**Goal:** 让眼镜在跨网络场景（PC 在寝室、手机+眼镜出门）下，仍能连回 PC 上的 Core 完成审批闭环，通过在手机上跑一个「mDNS 广播 + WebSocket 透明转发」的中继 App，复用已验证的 Tailscale 通道。

**Architecture:** 三段链路 —— 眼镜连手机热点（与手机同网），手机中继广播 `_agentbridge._tcp` 让眼镜 mDNS 自动发现，中继把眼镜的 WebSocket 连接透明转发到 PC 的 Core（经 Tailscale 虚拟局域网）。眼镜与 Core **零改动**。

**Tech Stack:** Kotlin（Android），`NsdManager`（mDNS 广播）+ `ServerSocket`/`Socket`（TCP 透明转发）。手机侧 Tailscale 官方 App（已装、已验证）。

## 背景

MVP 已收敛为「同 WiFi 内闭环」。Tailscale 打通了手机↔PC 的跨网络通道（2026-08-29 已组网验证：账号 `2817839807@`，PC Tailscale IP `100.117.117.37`，手机 `100.80.81.105`，互相 ping 通，PC Core 经 Tailscale IP `/health` 返回 `{"status":"ok"}`）。

眼镜无法装 Tailscale（眼镜 ROM 禁 `adb install`，只能走 CXR-L `appUploadAndInstall` 且文档要求 APK 集成 CXR-S SDK；眼镜 ROM 是否支持 VpnService 未知），故眼镜跨网络走「手机中继」而非「眼镜装 Tailscale」。

## 拓扑

```
[PC Core :8088]           监听 0.0.0.0（含 Tailscale 网卡 100.117.117.37）
     ↑ ① Tailscale 虚拟局域网（手机↔PC，已验证 ✅）
[手机]
     - Tailscale 保持在线（连出门地点 WiFi / 流量）
     - 开「手机热点」，眼镜连热点（Rokid App 配 WiFi，已验证可行）
     - 跑「中继 App」：NsdManager 广播 + ServerSocket(8088) 转发
     ↑ ② 眼镜连手机热点（与手机同网，mDNS 可达）
[眼镜]                    现有 mDNS 发现逻辑自动找到手机，零改动
```

三段职责：
1. **手机 ↔ PC**：Tailscale（已完成）。
2. **眼镜 ↔ 手机**：手机热点（Rokid App 配 WiFi，已完成可行性确认）。
3. **眼镜 → PC 数据通路**：手机中继 App（本期新做）。

## 核心机制

### 1. mDNS 广播（伪装成 Core）

手机中继用 `NsdManager.registerService` 广播与 Core **完全一致**的服务，眼镜现有的 `startDiscovery` 无需改动即可发现并连接。

Core 当前广播协议（`middleware-core/internal/mdns/broadcaster.go`）：

- 服务类型：`_agentbridge._tcp`
- 服务名：`AgentBridge-<id>`
- 端口：`8088`
- TXT 记录：`["id=<id>", "session=<session>", "version=1"]`

眼镜解析逻辑（`MainViewModel.kt` `onServiceResolved`）：取 `resolved.host.hostAddress` + `resolved.port` + `resolved.attributes["id"]`，用 host:port 建 WebSocket。**眼镜不校验 id 是否匹配**（除非配置了 `preferredId`），所以手机中继广播任意 id 都能被连上。

手机中继广播：

- 服务名：`AgentBridge-phone-relay`
- 端口：`8088`
- TXT：`["id=phone-relay", "session=default", "version=1"]`

### 2. TCP 透明转发

手机中继 `ServerSocket(8088)` 监听。每个进来的连接（眼镜的 WebSocket）：
1. 新建 `Socket` 连 PC `100.117.117.37:8088`。
2. 双向转发字节流（两条线程：眼镜→PC、PC→眼镜）。
3. 任一端关闭，关闭另一端。

WebSocket 握手与后续帧都是 TCP 字节流，中继**不解析协议**，纯字节转发，眼镜与 Core 对中继完全无感知。

### 3. PC 地址配置

- 存 `SharedPreferences`，键 `pc_host`（默认 `100.117.117.37`）、`pc_port`（默认 `8088`）。
- App 提供一个极简界面填 host/port，PC Tailscale IP 漂移时可改。
- 中继启动/配置变更时重读。

## 数据流（完整闭环）

1. 出门：手机连 WiFi/流量，Tailscale 连上；手机开热点；打开中继 App（填 PC 地址 `100.117.117.37:8088`）。
2. 眼镜经 Rokid App 连手机热点。
3. 眼镜 `startDiscovery` 发现手机广播的 `_agentbridge._tcp` → 解析出手机热点 IP + 8088 → 连 `ws://<手机热点IP>:8088`。
4. 手机中继接受连接 → 连 PC `100.117.117.37:8088` → 双向转发。
5. PC Core 收到来自手机 Tailscale IP 的 WebSocket 连接，正常走审批卡片流程。
6. 眼镜手势审批 → WebSocket 消息 → 手机中继转发 → PC Core → adapter → Claude Code 执行 → 结果回传，反向同理。

## 范围

### 本期（MVP 跨网络）

- 8088 端口的审批卡片核心链路（连接、卡片显示、手势审批、结果回传）。

### 后续（明确不做，记录原因）

- **语音输入 STT（8788 端口）**：眼镜语音走 `ws://<host>:8788`，而 STT 服务只监听 `127.0.0.1:8788`，跨网络还需改 STT 监听地址为 `0.0.0.0`；且跨网络语音经 DERP 中继本就偏卡。留 launch 阶段。

## 关键约束

- **眼镜零改动**：现有 mDNS 发现 + WebSocket 连接逻辑不变。
- **Core 零改动**：Core 已监听 `0.0.0.0:8088`（含 Tailscale 网卡），无需改。
- **不改消息协议**：中继不解析 AgentBridge 协议，纯字节转发。
- **不改审批链路**：审批逻辑全部在 PC 侧，中继透明。

## 边界情况

| 场景 | 处理 |
|------|------|
| 手机中继重启 | 眼镜重连时重新 mDNS 发现，中继重启并重新广播后自动恢复。跨网络下手动 IP（`run-as` 被封）/ ADB 隧道（无 USB）降级链均不可用，故只依赖 mDNS 重发现。 |
| PC Tailscale IP 漂移 | 用户在 App 改 host 重连。默认值 + 可配置覆盖。 |
| 眼镜断连重连 | 眼镜既有 `ReconnectTracker`/`ReconnectGuard` 机制，重连时重新 mDNS 发现手机，透明经过中继。 |
| 中继 PC 连接失败 | 转发线程报错 → 关闭眼镜侧连接，眼镜走重连。 |
| 多设备并发 | 每连接独立线程转发，互不影响。 |

## 测试

### 单元测试（JVM）

- 广播 TXT/服务名/端口与 Core 协议一致（常量断言）。
- 转发线程：mock Socket 双向字节流，验证两端互通、单端关闭时另一端关闭。

### 真机验证（手动）

1. 手机装中继 App，填 PC `100.117.117.37:8088`，开热点，启动中继。
2. 眼镜连手机热点。
3. 眼镜 mDNS 发现手机 → 连接成功。
4. PC Core 触发审批卡片 → 眼镜显示卡片 → 手势 approve → PC 工具执行 → 结果回传眼镜。
5. 反向：眼镜语音（本期不测，8788 后续）。

## 实现位置

- 新工程 `phone-relay/`（独立 Android App，不依赖 CXR-L SDK），`adb install` 直接装手机（华为 NOP-AN00 未禁 adb install）。
- 复用构建链：Android Studio / Gradle。
