# 一键启动/关闭（线 B 语音会话全量环境）设计 spec

## 目标

用一条命令拉起「线 B 语音会话」所需的完整 PC 端环境，一条命令全部关闭，消除每次手动准备 Core / STT / watchdog / session.js 四类常驻进程的重复劳动。

## 背景与动机

当前每次使用眼镜语音会话（出门/回家接力）前，需要在 PC 上手动准备四样东西：

| 进程 | 作用 | 现状启动方式 |
|------|------|-------------|
| Core | WS 服务器（:8088），所有组件依赖 | `cd middleware-core && AGENTBRIDGE_ADDR=":8088" go run cmd/server/main.go` |
| STT | 语音转文字（:8790），faster_whisper | `$Python agent-adapter/stt/transcribe_server.py` |
| watchdog | ADB 隧道 + 眼镜 WiFi 保活（后台循环） | `Start-Process powershell -File scripts/tunnel-watchdog.ps1` |
| session.js | 线 B 语音会话 daemon | `scripts/start-session.ps1`（内部 `node dist/session.js`） |

其中 Core、STT、watchdog 是前台阻塞进程，session.js 也是。手动准备容易漏、顺序易错、关闭时后台进程难定位。

## 全局约束

- **不改 Core 协议**：Core 的 WS 消息格式、`device_type`、事件分发逻辑不动。
- **不改 AgentBridgeClient 消息协议**：眼镜端与 Core 之间的消息格式、降级链不动。
- **审批链路不变**：approve/reject/超时降级的审批流不动。
- **纯运维脚本层**：本功能只在 `scripts/` 下新增编排脚本，不触碰任何运行时组件源码。
- **兼容 Windows PowerShell 5.1**：脚本需在 PS 5.1 下运行，禁止使用 `&&`、`||`、`??`、`?.`、三元等 5.1 不支持的语法。

## 架构总览

新增一对编排脚本 + 一个共享库，用「PID 文件 + 端口健康检查」做幂等启动和精确关闭。

```
scripts/
  lib-agentbridge.ps1    # 共享库：环境变量、PID 读写、端口探测、健康检查、后台进程启动
  start-all.ps1          # 一键启动编排（Core → STT → watchdog → session.js）
  stop-all.ps1           # 一键关闭编排（session.js → watchdog → STT → Core）
  start-session.ps1      # 保留原职责：只起 session daemon（出门接力用），改为复用 lib
  resume-glasses.ps1     # 不动
  tunnel-watchdog.ps1    # 不动（被 start-all 后台拉起）
```

运行态目录（均加进 `.gitignore`）：

```
.run/                    # 进程 PID 文件：core.pid / stt.pid / watchdog.pid / session.pid
logs/                    # 后台进程日志：core.log / stt.log / watchdog.log
middleware-core/bin/     # go build 产物 core.exe（*.exe 已被 .gitignore 覆盖）
```

## 组件详设

### `scripts/lib-agentbridge.ps1`（共享库）

只放纯函数，供 `start-all.ps1`、`stop-all.ps1`、`start-session.ps1` 复用，避免环境变量组装和 PID 逻辑三处复制。全部函数可被 Pester 单测。

函数清单（签名与职责）：

```powershell
# 环境变量组装：返回哈希表，调用方自行 Set-Item
function Get-AgentBridgeEnv {
    param([string]$Cwd, [string]$Url, [string]$Session, [int]$AudioPort,
          [string]$Python, [string]$ResumeSession)
}
# PID 文件读写
function Write-Pid { param([string]$Name, [int]$Pid) }     # 写 .run/$Name.pid
function Read-Pid  { param([string]$Name) }                # 读 .run/$Name.pid，无则返回 $null
function Remove-Pid { param([string]$Name) }               # 删 .run/$Name.pid
# 进程存活判断
function Test-ProcessAlive { param([int]$Pid) }            # Get-Process -Id 不抛错且返回对象
# 端口监听探测（用 netstat -ano 匹配 LISTENING 状态）
function Test-PortListening { param([int]$Port) }
# 健康检查轮询
function Wait-Health {
    param([string]$Url, [int]$TimeoutSec, [int]$IntervalSec)
}                                                          # 轮询直到 200 或超时，返回 bool
# 后台进程启动（Start-Process 封装 + 日志重定向 + PID 落盘）
function Start-BackgroundProcess {
    param([string]$Name, [string]$FilePath, [string[]]$ArgumentList,
          [string]$WorkingDirectory, [string]$LogFile, [hashtable]$Env)
}
```

路径约定（写死在库里或作为库参数）：
- 项目根 `$Cwd`（默认 `D:\project\5project\AgentBridge-master`，可参数覆盖）
- adapter 目录 `$Cwd\agent-adapter`
- core 目录 `$Cwd\middleware-core`
- PID 目录 `$Cwd\.run`、日志目录 `$Cwd\logs`（启动前 `New-Item -Force` 确保存在）
- Python 解释器默认 `D:\environment\Python 3.13.7\python.exe`

### `scripts/start-all.ps1`（一键启动）

**参数**（全部带默认值，日常直接 `.\scripts\start-all.ps1` 即可）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-Cwd` | `D:\project\5project\AgentBridge-master` | 项目根 |
| `-Python` | `D:\environment\Python 3.13.7\python.exe` | STT 解释器 |
| `-CorePort` | `8088` | Core 监听端口 |
| `-SttPort` | `8790` | STT 监听端口 |
| `-Session` | `default` | 与眼镜同 session |
| `-AudioPort` | `8788` | 眼镜音频隧道端口 |
| `-ResumeSession` | `""` | 显式钉住会话 id，空则读 `.agentbridge-current-session` |
| `-SkipWatchdog` | 开关 | 不连眼镜/无 adb 时跳过 watchdog |

**启动顺序**（每步先做幂等检测，已运行则打印 `[skip]` 并继续）：

1. **Core**
   - 幂等：`.run/core.pid` 存在且进程存活且 `:8088` 在监听 → skip。
   - 否则：`go build -o bin/core.exe ./cmd/server`（在 `middleware-core` 下，**每次启动都 build**，靠 Go 编译缓存提速，不做自定义增量判断）。
   - 以 `AGENTBRIDGE_ADDR=":<CorePort>"` 后台启动 `bin/core.exe`，日志 `logs/core.log`，写 PID。
   - `Wait-Health "http://127.0.0.1:<CorePort>/health"` 超时 30s（首次 build 慢），失败报错并停在原地（不回滚）。
2. **STT**
   - 幂等：`.run/stt.pid` 存活且 `:<SttPort>` 监听 → skip。
   - 以 `AGENTBRIDGE_STT_PORT="<SttPort>"`（`AGENTBRIDGE_STT_MODEL` 默认 `small`）后台启动 `$Python stt/transcribe_server.py`，日志 `logs/stt.log`，写 PID。
   - `Wait-Health "http://127.0.0.1:<SttPort>/health"` 超时 60s（whisper 加载模型慢）。
3. **watchdog**
   - 幂等：`.run/watchdog.pid` 存活 → skip。
   - 后台启动 `scripts/tunnel-watchdog.ps1`（PowerShell 后台），日志 `logs/watchdog.log`，写 PID。无 health，起完即成功。
   - `-SkipWatchdog` 时整步跳过。
4. **session.js**（独立窗口）
   - 幂等：`.run/session.pid` 存活 → skip。
   - `Start-Process node -ArgumentList "dist/session.js" -WorkingDirectory <adapterDir> -PassThru` 开**独立可见窗口**（日志直接显示，不重定向到文件），写 PID `.run/session.pid`。
   - 设置环境变量：`AGENTBRIDGE_CWD`、`AGENTBRIDGE_URL`（默认 `http://localhost:<CorePort>`，与 `-CorePort` 联动）、`AGENTBRIDGE_SESSION`、`AGENTBRIDGE_AUDIO_PORT`、`AGENTBRIDGE_PYTHON`、`AGENTBRIDGE_RESUME_SESSION`（若有）。复用 `Get-AgentBridgeEnv`。

**幂等判定统一规则**：PID 文件存在 **且** 进程存活（+ 有端口者再验端口）→ skip；否则视为未运行，清理残留 PID 后重新启动。

**结束输出**：打印四行状态（`Core: running (pid=...)` / `STT: running` / `watchdog: running` / `session: running`），并提示「眼镜连上即可使用」。

### `scripts/stop-all.ps1`（一键关闭）

按**依赖逆序**停（先停依赖者，最后停被依赖的 Core）：

1. session.js（读 `.run/session.pid`）
2. watchdog（读 `.run/watchdog.pid`）
3. STT（读 `.run/stt.pid`）
4. Core（读 `.run/core.pid`）

每步：`Read-Pid` 得到 PID → `Test-ProcessAlive` 存活则 `Stop-Process -Id`（`-ErrorAction SilentlyContinue`），已死则打印 `[gone]` 跳过；停完 `Remove-Pid`。

参数：`-Cwd`（默认项目根），用于定位 `.run/`。

**残留处理**：若某 PID 文件指向已死/已复用 PID，`Stop-Process` 失败时打印警告（提示可能是 PID 复用，建议手动 `netstat` 排查），不强行 `kill`。

## 错误处理

- **启动失败**：某步 `Wait-Health` 超时或进程起不来 → 打印该进程的日志尾部若干行到控制台，`exit 1`，已启动的进程**不回滚**（留给用户观察或再跑一次走幂等 skip）。
- **go build 失败**：Core 起不来 → 打印 build 错误，`exit 1`。
- **停止时进程不存在**：静默跳过，不报错。
- **PID 文件丢失但进程在跑**：start 的幂等检测退化到「端口监听」兜底（对 Core/STT）；session/watchdog 无端口，缺 PID 文件时提示用户手动处理。

## 与现有脚本的关系

- `start-session.ps1` **保留**，职责收窄为「只起 session daemon」（出门接力：Core/STT/watchdog 已在跑，只需起 session）。其环境变量组装与 PID 逻辑改为调用 `lib-agentbridge.ps1`，删除内联重复代码。
- `start-all.ps1` 是 `start-session.ps1` 的**超集**：先起 Core/STT/watchdog，再起 session.js。
- `resume-glasses.ps1`、`tunnel-watchdog.ps1`、`deploy-apk.ps1`、`set-glasses-config.ps1` 不动。

## 测试策略

- **单测（Pester）**：针对 `lib-agentbridge.ps1` 的纯函数——`Write-Pid`/`Read-Pid`/`Remove-Pid`（读写删、目录不存在不抛错）、`Test-ProcessAlive`（存活/已死/非法 PID）、`Test-PortListening`（监听/未监听）、`Wait-Health`（立即 200 / 超时返回 false）、`Get-AgentBridgeEnv`（各参数组合下环境变量拼装正确、含/不含 `-ResumeSession`）。
- **编排冒烟（真机/本机）**：`start-all.ps1` 起一遍 → 四样全 running → 再跑一次确认四样全 `[skip]` → `stop-all.ps1` → 四样全停 → 再 `start-all.ps1` 能重新拉起。`-SkipWatchdog` 下 watchdog 不被拉起。
- 不引入 Go/TS 测试（本功能不碰运行时源码）。

## 验收标准

1. 干净环境下 `.\scripts\start-all.ps1` 一条命令拉起 Core + STT + watchdog + session.js，四样均 running。
2. 重复执行 `start-all.ps1` 四样全部 `[skip]`，不产生端口冲突或重复进程。
3. `.\scripts\stop-all.ps1` 一条命令停掉四样（含后台隐藏进程），`.run/` 清理干净。
4. `.\scripts\start-session.ps1`（出门接力）仍能独立工作，行为不回退。
5. Pester 单测全绿；`git status` 中 `.run/`、`logs/`、`middleware-core/bin/core.exe` 均被忽略。

## 非目标（YAGNI）

- 不做 Core/STT 的 Windows 服务化、开机自启、守护重启（超出「一键启动」诉求）。
- 不做线 A（relay）的一键编排（用户默认链路是线 B；线 A 后续有需要再扩展，`lib` 已预留复用空间）。
- 不做 docker 容器化（USB/adb/模型文件穿透成本高，开发期不划算）。
- 不做自定义的「源码变了才 build」增量判断（Go 编译缓存已足够，见背景说明）。
- 不做多平台（仅 Windows PowerShell 5.1）。
