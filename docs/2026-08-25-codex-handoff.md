# Codex 交接总说明（2026-08-25）

本文汇总当前所有「已出 spec/plan 但未实现」以及「已登记未修」的工作，按优先级排序。

**本轮范围：Codex 只实现第 1 节（一键启动分层）。第 2–5 节留后续批次。**

## 0. 工作区状态：已清理干净

线 B 语音收尾改动已提交（commit `21c6240`），调试残留文件已删除。Codex 开工时工作区应干净，直接进入第 1 节。

---

## 1. 一键启动/切换（分层）—— 全新，spec+plan 已就绪

这是本轮唯一的大块新功能。**spec 和 plan 都已写好，直接按 plan 实现即可**：

- spec: `docs/superpowers/specs/2026-08-25-one-click-startup-design.md`
- plan: `docs/superpowers/plans/2026-08-25-one-click-startup-plan.md`（10 个 TDD 任务）

**两个目标，一次完成：**

- **目标一：环境自动化。** 把线 B 语音会话每次启动要手动准备的四样东西（Core、STT、watchdog、session.js）自动化——冷启动一条命令 `start-all.ps1` 拉起全部，`stop-core.ps1` 对称关停。
- **目标二：项目切换。** 四样里前三个（Core/STT/watchdog）是 PC 全局服务、与项目无关；只有 session.js 随项目走。切项目时只切会话层、不动全局底座（旧方案换项目要全量重启 STT，浪费几十秒加载模型）。日常切项目：`cd 目标项目` 后 `.\scripts\start-session.ps1`，`-Cwd` 默认当前目录，免填路径。

架构即「全局底座」（Core/STT/watchdog）+「项目会话」（session.js）两层分离。

**关键约束（写代码前必读 plan 的 Global Constraints 小节）**：
- 不改 Core 协议、不改 AgentBridgeClient 消息协议、审批链路不变（纯运维脚本层）。
- 兼容 Windows PowerShell 5.1：禁用 `&&`、`||`、`??`、`?.`、三元。
- 日常命令零参数可用：冷启动 `.\scripts\start-all.ps1`；切项目 `cd 目标项目` 后 `.\scripts\start-session.ps1`。
- 工具根（脚本/`.run`/`logs`/Core 源码）与项目 cwd 分离；`-Cwd` 默认 `(Get-Location).Path`。
- 用 Pester 5 做纯函数单测（TDD，先写失败测试）。

交付 4 个新脚本 + 1 个共享库：`scripts/lib-agentbridge.ps1`、`start-core.ps1`、`stop-core.ps1`、`start-session.ps1`（改造现有）、`start-all.ps1`；`resume-glasses.ps1` 的 `-Cwd` 默认值改当前目录。运行态目录 `.run/`、`logs/`、`middleware-core/bin/core.exe` 都要进 `.gitignore`。

---

## 2. 服务自愈 bug ×2（无正式 spec，直接修）

来自 `memory/deferred_tasks.md`，均已在任务列表登记（#72/#73）。

### 2a. Bug A（#72）：Core mDNS 不随 IP 漂移重新注册

- 文件：`middleware-core/internal/mdns/broadcaster.go`
- 现状：`Start()` 只在启动时 `zeroconf.Register` 一次，返回 shutdown 就结束。PC 无线网卡 IP 漂移后，眼镜发现的仍是旧 IP，服务端不会重新广播。
- 修法：让 `Start()` 定期（或检测到本机 IP 变化时）重新 `Register`，旧 server `Shutdown` 后再注册新地址。可参考眼镜端已有的客户端重发现（`AgentBridgeClient.kt` 的 `ReconnectTracker` + 60s `onStale`），服务端做对称的「检测本机非回环 IPv4 变化 → 重注册」。
- 验收：手动改 PC 网卡 IP（或断网重连）后，眼镜无需手动操作即重新连上。

### 2b. Bug B（#73）：relay daemon 在 Core 重启时崩溃

- 文件：`agent-adapter/src/relay.ts`（`main()`，约 165-196 行）
- 现状：`main()` 里 `wsClient.connect()` 但**没有** `wsClient.on('error', ...)`。当 Core 重启，WS 反复 error，重连次数耗尽后 `AgentBridgeClient.reconnect()` 会 `emit('error', new Error('Max reconnect attempts reached'))`（见 `ws-client.ts:125`）。EventEmitter 无 error 监听 → 未捕获异常 → 进程崩溃。
- 参照：`agent-adapter/src/session.ts:118` 已经有 `wsClient.on('error', (err) => console.error(...))`，relay.ts 照抄一行即可。
- 验收：Core 重启后 relay 不崩，Core 恢复后自动重连继续工作。

---

## 3. 健壮性 bug ×2（任务 #88/#89）

### 3a. #88：Core hub 同名设备重复连接覆盖

- 文件：`middleware-core/internal/ws/hub.go`（`Register`，约 35-54 行）
- 现状：`s.Devices[deviceType] = ch` 直接用新 channel 覆盖旧的，旧 channel 不 close、不告警。同名（同 deviceType）第二个连接会悄悄顶掉第一个。
- 修法：覆盖前若 `s.Devices[deviceType]` 已存在，先 `close` 旧 channel 并打日志；或拒绝重复注册。需配 `hub` 的测试。

### 3b. #89：眼镜端 onFailure + onClosed 双重连

- 文件：`rokid-sdk/.../agent/AgentBridgeClient.kt` + `activities/main/MainViewModel.kt`
- 现状：连接失败时失败回调与关闭回调可能都触发，导致 `MainViewModel` 重复发起连接（`startDiscovery`/`createClient` 各走一遍）。
- 修法：在 client 内做幂等/去重（连接失败只走一次回调，用状态标志或 `connectionStarted` 门），确保单次失败只触发一次重连。
- 验收：断开 WiFi 再恢复，眼镜只建立一条连接，Core 侧 `ConnectedDevices` 只出现一个眼镜设备。

---

## 4. middleware-core 测试补全（#29，只差并发安全）

任务 #29 要求「dispatcher 6 种事件类型 × 边缘情况 + approval manager 并发安全」。现状：

- ✅ `internal/device/dispatcher_test.go`：已覆盖全部 6 种事件类型 + 边缘（路由、fallback actions、风险分显示、CardDetails、summary 截断、severity 前缀、caps 等），**已满足**。
- ⚠️ `internal/approval/manager_test.go`：只有 4 个测试（默认超时 / 配置超时 / expire / 已终结 resolve），**缺并发安全测试**。

补一条 Go 并发测试：多 goroutine 同时 `Create` + `Resolve` + `Expire` 同一/不同 task，跑 `go test -race ./internal/approval/` 验证无竞态。用 `sync.WaitGroup` + 表驱动即可。

---

## 5. 条件 WakeLock（低优先级，无 spec，可缓）

来自 `memory/deferred_tasks.md`，未在任务列表登记。目标：只有处于「可审批卡片 / 执行中」状态时保持屏幕常亮，其余状态允许熄屏（当前是全局 WiFiLock，管的是 WiFi 不是屏幕）。

- 修法：`CardStateMachine.kt` 加 `shouldKeepScreenOn(state: AgentCardState): Boolean`（`renderHint` 为 `actionable_card`/`executing_card` 时返回 true）；`MainActivity.kt` 用 `lifecycleScope` collect `agentCard` 状态流，按返回值设置/清除 `window` 的 `FLAG_KEEP_SCREEN_ON`（或 `PowerManager` wake lock）。
- 依赖眼镜真机验证，可最后做。

---

## 建议顺序

1. 先提交第 0 节未提交改动（或至少确认保留）。
2. 实现第 1 节一键启动（10 个 TDD 任务，最大块，有完整 plan）。
3. 修第 2 节两个服务自愈 bug（小、独立）。
4. 修第 3 节两个健壮性 bug（小、独立，配测试）。
5. 补第 4 节 approval 并发测试（一条测试）。
6. 第 5 节条件 WakeLock 视时间而定。

每一块独立可测、独立可提交，互不阻塞。
