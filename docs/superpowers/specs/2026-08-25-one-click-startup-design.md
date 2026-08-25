# 分层启动/切换（全局底座 + 项目会话）设计 spec

## 目标

把「线 B 语音会话」的 PC 端环境按生命周期分成两层——**全局底座**（Core/STT/watchdog，跟项目无关，起一次长期跑）和**项目会话**（session.js，随项目切换）。切换项目时只切会话层、不动底座，且会话层默认用「当前目录」定位项目，免去填路径/UUID。

## 背景与动机

当前每次使用眼镜语音会话（出门/回家接力）前，需要在 PC 上手动准备四样东西：

| 进程 | 作用 | 与项目的关系 |
|------|------|-------------|
| Core | WS 服务器（:8088），所有组件依赖 | 全局，无关 |
| STT | 语音转文字（:8790），faster_whisper | 全局，无关 |
| watchdog | ADB 隧道 + 眼镜 WiFi 保活（后台循环） | 全局，无关 |
| session.js | 线 B 语音会话 daemon | **随项目**（resume 哪个 cwd 的会话） |

核心洞察：前三个是 PC 全局服务，切项目不需要重起它们；只有 session.js 是 per-project。旧方案把它们绑成一个 `start-all.ps1` 且 `-Cwd` 写死，导致「换项目」得全量重启（STT 加载模型要几十秒，浪费）。

## 全局约束

- **不改 Core 协议**、**不改 AgentBridgeClient 消息协议**、**审批链路不变**（纯运维脚本层）。
- 脚本兼容 Windows PowerShell 5.1：禁用 `&&`、`||`、`??`、`?.`、三元表达式。
- 日常使用命令必须零参数可用（冷启动 `.\scripts\start-all.ps1`；切换项目 `cd 目标项目` 后 `.\scripts\start-session.ps1`）。
- **换项目不重起全局底座**：Core/STT/watchdog 与项目 cwd 无关。
- **工具根与项目 cwd 分离**：脚本物理位置、Core 源码、`.run/`、`logs/` 都在「工具根」（AgentBridge 仓库）；仅 `.agentbridge-current-session` 属于「项目 cwd」。
- **`-Cwd` 默认当前目录 `(Get-Location).Path`**，不再写死某个项目；工具根从 `$PSScriptRoot` 推导，不写死绝对路径。
- PID 文件目录 `.run/`、日志目录 `logs/`、`middleware-core/bin/core.exe` 必须被 `.gitignore` 忽略。

## 架构总览

```
scripts/
  lib-agentbridge.ps1    # 共享库：环境变量、PID 读写、端口探测、健康检查、后台进程启动、工具根定位
  start-core.ps1         # 起全局底座：Core + STT + watchdog（无 cwd 概念）
  stop-core.ps1          # 停全局底座：watchdog + STT + Core
  start-session.ps1      # 起/切项目会话：session.js（-Cwd 默认当前目录）
  start-all.ps1          # 冷启动便捷包装：start-core + start-session（薄封装）
  resume-glasses.ps1     # PC 端 resume 眼镜刚用过的会话（-Cwd 默认当前目录）
  tunnel-watchdog.ps1    # 不动（被 start-core 后台拉起）
```

运行态目录（工具根下，均加进 `.gitignore`）：

```
<工具根>/.run/           # 全局底座 PID 文件：core.pid / stt.pid / watchdog.pid
<工具根>/logs/           # 后台进程日志：core.log / stt.log / watchdog.log
<工具根>/middleware-core/bin/  # go build 产物 core.exe（*.exe 已被 .gitignore 覆盖）
```

## 组件详设

### `scripts/lib-agentbridge.ps1`（共享库）

只放纯函数，供各脚本复用。函数清单（完整签名在 plan 中给出）：

- `Resolve-ToolRoot`（无参数，返回 `$PSScriptRoot` 上一级，即 AgentBridge 仓库根）。
- `Write-Pid -Root <string> -Name <string> -Pid <int>` / `Read-Pid -Root <string> -Name <string>`（返回 `[int]` 或 `$null`）/ `Remove-Pid -Root <string> -Name <string>` —— PID 文件位于 `<Root>\.run\<Name>.pid`（调用方传 `Resolve-ToolRoot`）。
- `Test-ProcessAlive -Pid <int>`（返回 `[bool]`）。
- `Test-PortListening -Port <int>`（返回 `[bool]`，netstat 匹配 LISTENING）。
- `Wait-Health -Url <string> -TimeoutSec <int> -IntervalSec <int>`（返回 `[bool]`）。
- `Get-AgentBridgeEnv -Cwd -Url -Session -AudioPort -Python [-ResumeSession]`（返回 `[hashtable]`，`-ResumeSession` 非空才含 `AGENTBRIDGE_RESUME_SESSION`）。
- `Start-BackgroundProcess -Root -Name -FilePath -ArgumentList -WorkingDirectory [-Env] [-LogFile]`（返回 `[Process]`，内部写 PID 到 `<Root>\.run`、建 `<Root>\logs`、日志重定向）。

路径约定：

- **工具根** = `Resolve-ToolRoot`；`adapter 目录 = 工具根\agent-adapter`、`core 目录 = 工具根\middleware-core`、`.run` 与 `logs` 都在工具根下。
- **项目 cwd** `$Cwd` 由调用方传入，**默认 `(Get-Location).Path`**；仅用于 session.js 的 `AGENTBRIDGE_CWD` 与 `.agentbridge-current-session` 定位。
- Python 解释器默认 `D:\environment\Python 3.13.7\python.exe`。

### `scripts/start-core.ps1`（起全局底座）

**无 `-Cwd` 参数**（全局服务与项目无关，PID/日志都在工具根）。参数仅限端口/工具路径：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-CorePort` | `8088` | Core 监听端口 |
| `-SttPort` | `8790` | STT 监听端口 |
| `-Python` | `D:\environment\Python 3.13.7\python.exe` | STT 解释器 |
| `-SkipWatchdog` | 开关 | 不连眼镜/无 adb 时跳过 watchdog |

顺序（每步幂等，已运行则 `[skip]`）：

1. **Core**：`go build -o bin/core.exe ./cmd/server`（在工具根 `middleware-core` 下，每次 build，靠 Go 缓存），`AGENTBRIDGE_ADDR=":<CorePort>"` 后台跑，`Wait-Health :<CorePort>/health`（超时 30s）。
2. **STT**：`$Python stt/transcribe_server.py`，`AGENTBRIDGE_STT_PORT="<SttPort>"` 后台跑，`Wait-Health :<SttPort>/health`（超时 60s）。
3. **watchdog**：后台跑 `tunnel-watchdog.ps1`，无 health；`-SkipWatchdog` 时跳过。

三者均后台隐藏，日志落 `logs/`，PID 落 `.run/`（均在工具根）。

### `scripts/stop-core.ps1`（停全局底座）

按 `watchdog → STT → Core` 逆序停（读工具根 `.run/*.pid` → `Test-ProcessAlive` → `Stop-Process` → `Remove-Pid`）。**无 `-Cwd` 参数**（读工具根 `.run`）。**不动 session.js**（session 由独立窗口 Ctrl+C 停）。

### `scripts/start-session.ps1`（起/切项目会话）

**参数**（`-Cwd` 默认当前目录，日常 `cd 目标项目` 后零参数跑）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-Cwd` | `(Get-Location).Path` | 要接入的项目目录 |
| `-Url` | `http://localhost:8088` | Core 地址 |
| `-Session` | `default` | 与眼镜同 session |
| `-AudioPort` | `8788` | 眼镜音频隧道端口 |
| `-Python` | `D:\environment\Python 3.13.7\python.exe` | STT 解释器 |
| `-ResumeSession` | `""` | 显式钉住会话 id；空则读 `<Cwd>\.agentbridge-current-session`，再回退该项目 mtime 最新会话 |

行为：读 `<Cwd>\.agentbridge-current-session` 兜底 resume → 用 `Get-AgentBridgeEnv` 组装环境变量 → `Set-Location` 到 adapter 目录（`Resolve-ToolRoot` 推导）→ **前台** `node dist/session.js`（占当前窗口，Ctrl+C 停）。**不写 PID**。

**切换项目流程**：停旧 session（Ctrl+C）→ `cd 目标项目` → `.\scripts\start-session.ps1`。底座不动。

### `scripts/start-all.ps1`（冷启动便捷包装）

薄封装：`& start-core.ps1` 然后 `& start-session.ps1`（参数透传，`-Cwd` 默认当前目录）。给「第一次冷启动」一条命令全起来用；之后切换项目直接用 `start-session.ps1`。

### `scripts/resume-glasses.ps1`（PC 端回家接力）

行为不变（读 `<Cwd>\.agentbridge-current-session` → `claude -r <id>`），仅 `-Cwd` 默认从写死改为 `(Get-Location).Path`。

## 幂等语义

统一规则：PID 文件存在 **且** 进程存活（+ 有端口者再验端口）→ `[skip]`；否则清理残留 PID 后重启。全局底座的 `.run/` 在工具根（固定、单实例）；会话的 `.agentbridge-current-session` 按 `-Cwd`（当前目录）定位，不同项目天然隔离。

## 错误处理

- 启动失败：某步 `Wait-Health` 超时或进程起不来 → 打印该进程日志尾部到控制台，`exit 1`，已启动进程不回滚。
- `go build` 失败 → 打印错误，`exit 1`。
- 停止时进程不存在 → 静默跳过；PID 复用导致 `Stop-Process` 失败 → 打印警告提示手动 `netstat` 排查。

## 与现有脚本的关系

- `start-session.ps1` **保留**，`-Cwd` 默认值改当前目录，环境变量组装复用 `Get-AgentBridgeEnv`，adapter 路径改用 `Resolve-ToolRoot` 推导。
- `resume-glasses.ps1` **保留**，`-Cwd` 默认值改当前目录。
- `start-core.ps1` / `stop-core.ps1` / `start-all.ps1` **新增**。
- `tunnel-watchdog.ps1`、`deploy-apk.ps1`、`set-glasses-config.ps1` 不动。

## 测试策略

- **单测（Pester）**：`lib-agentbridge.ps1` 纯函数——`Resolve-ToolRoot`（返回仓库根、路径存在）、`Write-Pid`/`Read-Pid`/`Remove-Pid`（读写删、目录不存在不抛错、畸形内容返回 `$null`）、`Test-ProcessAlive`（存活/已死/非法 PID）、`Test-PortListening`（监听/未监听）、`Wait-Health`（立即 200 / 超时 false）、`Get-AgentBridgeEnv`（含/不含 `-ResumeSession`）、`Start-BackgroundProcess`（起进程写 PID、进程存活）。
- **编排冒烟（真机/本机）**：`start-core.ps1` 起三样 → 再跑全 `[skip]` → `stop-core.ps1` 全停；`start-all.ps1` 冷启动四样 running；`cd` 到临时目录跑 `start-session.ps1` 能切会话且底座 PID 不变。
- 不引入 Go/TS 测试（本功能不碰运行时源码）。

## 验收标准

1. `.\scripts\start-all.ps1`（冷启动）一条命令拉起 Core + STT + watchdog + session.js。
2. `.\scripts\start-core.ps1` 重复执行三样全 `[skip]`；`.\scripts\stop-core.ps1` 停掉三样且工具根 `.run/` 清空。
3. `cd 项目B` 后 `.\scripts\start-session.ps1` 只切会话，Core/STT/watchdog 的 PID 不变。
4. `.\scripts\start-session.ps1 -ResumeSession <id>` 能钉住指定会话。
5. Pester 单测全绿；`git status` 中工具根 `.run/`、`logs/`、`core.exe` 均被忽略。

## 非目标（YAGNI）

- 不做 Core/STT 的 Windows 服务化、开机自启、守护重启。
- 不做线 A（relay）的编排（用户默认链路线 B；lib 已预留复用空间）。
- 不做 docker 容器化。
- 不做自定义「源码变了才 build」增量判断（Go 编译缓存已足够）。
- 不做多平台（仅 Windows PowerShell 5.1）。
- 不做「会话列表 + 免 UUID 切换」的交互选择器（会话本身以 UUID 标识，切换指定会话仍需 `-ResumeSession <id>`；本项目聚焦「换项目免路径」）。
