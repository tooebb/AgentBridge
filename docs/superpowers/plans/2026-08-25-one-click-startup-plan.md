# 分层启动/切换（全局底座 + 项目会话）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分层管理线 B 语音会话的 PC 端环境——`start-core.ps1` 起全局底座（Core+STT+watchdog，一次长期跑），`start-session.ps1` 起/切项目会话（默认当前目录，免填路径），切换项目不重起底座。

**Architecture:** 共享库 `lib-agentbridge.ps1`（纯函数：工具根定位、PID 读写、进程/端口/健康探测、环境变量组装、后台进程启动）+ 分层编排脚本。全局底座 PID/日志在「工具根」，项目会话落盘 `.agentbridge-current-session` 在「项目 cwd」，两者分离。

**Tech Stack:** Windows PowerShell 5.1、Pester 5（单测）、Go build（Core 二进制）、faster_whisper（STT，已被 transcribe_server.py 封装）。

## Global Constraints

- 不改 Core 协议、不改 AgentBridgeClient 消息协议、审批链路不变（纯运维脚本层）。
- 脚本兼容 Windows PowerShell 5.1：禁用 `&&`、`||`、`??`、`?.`、三元表达式。
- 日常使用命令零参数可用：冷启动 `.\scripts\start-all.ps1`；切换项目 `cd 目标项目` 后 `.\scripts\start-session.ps1`。
- 换项目不重起全局底座。
- 工具根从 `$PSScriptRoot` 推导，不写死绝对路径；`-Cwd` 默认 `(Get-Location).Path`。
- 工具根 `.run/`、`logs/`、`middleware-core/bin/core.exe` 必须被 `.gitignore` 忽略。

---

### Task 1: Pester 基础设施 + 工具根定位 + PID 函数

**Files:**
- Create: `scripts/lib-agentbridge.ps1`
- Create: `scripts/tests/lib-agentbridge.Tests.ps1`

**Interfaces:**
- Produces: `Resolve-ToolRoot`（无参数，返回 `[string]` = `$PSScriptRoot` 上一级）、`Write-Pid -Root <string> -Name <string> -Pid <int>`、`Read-Pid -Root <string> -Name <string>`（返回 `[int]` 或 `$null`）、`Remove-Pid -Root <string> -Name <string>`。PID 文件位于 `<Root>\.run\<Name>.pid`。

- [ ] **Step 1: 安装 Pester 5**

```powershell
Install-Module Pester -Scope CurrentUser -Force -SkipPublisherCheck
Get-Module Pester -ListAvailable | Select-Object Name, Version
```

Expected: 列出 Pester 5.x。

- [ ] **Step 2: 写失败测试**

创建 `scripts/tests/lib-agentbridge.Tests.ps1`：

```powershell
BeforeAll {
    . $PSScriptRoot/../lib-agentbridge.ps1
    $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("abr-pid-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
}
AfterAll {
    Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Describe 'Resolve-ToolRoot' {
    It 'returns repo root containing agent-adapter and middleware-core' {
        $root = Resolve-ToolRoot
        (Test-Path (Join-Path $root 'agent-adapter')) | Should -Be $true
        (Test-Path (Join-Path $root 'middleware-core')) | Should -Be $true
    }
}

Describe 'PID helpers' {
    It 'writes and reads back a pid' {
        Write-Pid -Root $testRoot -Name 'core' -Pid 1234
        Read-Pid -Root $testRoot -Name 'core' | Should -Be 1234
    }
    It 'returns null when pid file missing' {
        Read-Pid -Root $testRoot -Name 'nope' | Should -Be $null
    }
    It 'creates .run dir when missing' {
        $sub = Join-Path $testRoot 'sub'
        Write-Pid -Root $sub -Name 'core' -Pid 1
        (Test-Path (Join-Path $sub '.run\core.pid')) | Should -Be $true
    }
    It 'removes pid file' {
        Write-Pid -Root $testRoot -Name 'tmp' -Pid 2
        Remove-Pid -Root $testRoot -Name 'tmp'
        (Test-Path (Join-Path $testRoot '.run\tmp.pid')) | Should -Be $false
    }
    It 'read returns null for malformed pid content' {
        $f = Join-Path $testRoot '.run\bad.pid'
        New-Item -ItemType Directory -Path (Split-Path $f) -Force | Out-Null
        Set-Content -Path $f -Value 'not-a-number' -Encoding ASCII
        Read-Pid -Root $testRoot -Name 'bad' | Should -Be $null
    }
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: FAIL，报 `The term 'Resolve-ToolRoot' is not recognized`。

- [ ] **Step 4: 实现最小代码**

创建 `scripts/lib-agentbridge.ps1`：

```powershell
function Resolve-ToolRoot {
    return Split-Path $PSScriptRoot -Parent
}

function Write-Pid {
    param([string]$Root, [string]$Name, [int]$Pid)
    $runDir = Join-Path $Root '.run'
    if (-not (Test-Path $runDir)) { New-Item -ItemType Directory -Path $runDir -Force | Out-Null }
    Set-Content -Path (Join-Path $runDir "$Name.pid") -Value "$Pid" -Encoding ASCII
}

function Read-Pid {
    param([string]$Root, [string]$Name)
    $file = Join-Path $Root (Join-Path '.run' "$Name.pid")
    if (-not (Test-Path $file)) { return $null }
    $raw = (Get-Content $file -Raw).Trim()
    if ($raw -eq '') { return $null }
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed)) { return $parsed }
    return $null
}

function Remove-Pid {
    param([string]$Root, [string]$Name)
    $file = Join-Path $Root (Join-Path '.run' "$Name.pid")
    if (Test-Path $file) { Remove-Item $file -Force }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 6/6 PASS。

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-agentbridge.ps1 scripts/tests/lib-agentbridge.Tests.ps1
git commit -m "feat(scripts): add tool-root + PID helpers to lib-agentbridge"
```

---

### Task 2: 进程/端口/健康探测函数

**Files:**
- Modify: `scripts/lib-agentbridge.ps1`
- Modify: `scripts/tests/lib-agentbridge.Tests.ps1`

**Interfaces:**
- Produces: `Test-ProcessAlive -Pid <int>`（返回 `[bool]`）、`Test-PortListening -Port <int>`（返回 `[bool]`）、`Wait-Health -Url <string> -TimeoutSec <int> -IntervalSec <int>`（返回 `[bool]`）。

- [ ] **Step 1: 写失败测试**

追加：

```powershell
Describe 'probe helpers' {
    It 'Test-ProcessAlive true for current process' {
        Test-ProcessAlive -Pid $PID | Should -Be $true
    }
    It 'Test-ProcessAlive false for dead pid' {
        Test-ProcessAlive -Pid 99999999 | Should -Be $false
    }
    It 'Test-ProcessAlive false for zero' {
        Test-ProcessAlive -Pid 0 | Should -Be $false
    }
    It 'Test-PortListening true for a live listener' {
        $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
        $l.Start()
        $port = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port
        try { Test-PortListening -Port $port | Should -Be $true }
        finally { $l.Stop() }
    }
    It 'Test-PortListening false for a closed port' {
        Test-PortListening -Port 65534 | Should -Be $false
    }
    It 'Wait-Health returns true on 200' {
        Mock Invoke-WebRequest { [pscustomobject]@{ StatusCode = 200 } }
        Wait-Health -Url 'http://x/health' -TimeoutSec 2 -IntervalSec 1 | Should -Be $true
    }
    It 'Wait-Health returns false on timeout' {
        Mock Invoke-WebRequest { throw 'unreachable' }
        Wait-Health -Url 'http://x/health' -TimeoutSec 2 -IntervalSec 1 | Should -Be $false
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 新增 7 个用例 FAIL。

- [ ] **Step 3: 实现最小代码**

追加：

```powershell
function Test-ProcessAlive {
    param([int]$Pid)
    if ($Pid -le 0) { return $false }
    try { return $null -ne (Get-Process -Id $Pid -ErrorAction Stop) }
    catch { return $false }
}

function Test-PortListening {
    param([int]$Port)
    $line = netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING'
    return ($null -ne $line)
}

function Wait-Health {
    param([string]$Url, [int]$TimeoutSec = 30, [int]$IntervalSec = 1)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds $IntervalSec
    }
    return $false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 13/13 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/lib-agentbridge.ps1 scripts/tests/lib-agentbridge.Tests.ps1
git commit -m "feat(scripts): add process/port/health probe helpers"
```

---

### Task 3: 环境变量组装函数

**Files:**
- Modify: `scripts/lib-agentbridge.ps1`
- Modify: `scripts/tests/lib-agentbridge.Tests.ps1`

**Interfaces:**
- Produces: `Get-AgentBridgeEnv -Cwd <string> -Url <string> -Session <string> -AudioPort <int> -Python <string> [-ResumeSession <string>]`（返回 `[hashtable]`）。

- [ ] **Step 1: 写失败测试**

追加：

```powershell
Describe 'Get-AgentBridgeEnv' {
    It 'builds base env without resume' {
        $e = Get-AgentBridgeEnv -Cwd 'D:\p' -Url 'http://localhost:8088' -Session 'default' -AudioPort 8788 -Python 'C:\py\python.exe'
        $e.AGENTBRIDGE_CWD | Should -Be 'D:\p'
        $e.AGENTBRIDGE_URL | Should -Be 'http://localhost:8088'
        $e.AGENTBRIDGE_SESSION | Should -Be 'default'
        $e.AGENTBRIDGE_AUDIO_PORT | Should -Be '8788'
        $e.AGENTBRIDGE_PYTHON | Should -Be 'C:\py\python.exe'
        $e.ContainsKey('AGENTBRIDGE_RESUME_SESSION') | Should -Be $false
    }
    It 'adds resume key when provided' {
        $e = Get-AgentBridgeEnv -Cwd 'D:\p' -Url 'http://x' -Session 'default' -AudioPort 8788 -Python 'py' -ResumeSession 'abc'
        $e.AGENTBRIDGE_RESUME_SESSION | Should -Be 'abc'
    }
    It 'omits resume key when empty string' {
        $e = Get-AgentBridgeEnv -Cwd 'D:\p' -Url 'http://x' -Session 'default' -AudioPort 8788 -Python 'py' -ResumeSession ''
        $e.ContainsKey('AGENTBRIDGE_RESUME_SESSION') | Should -Be $false
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 新增 3 个用例 FAIL。

- [ ] **Step 3: 实现最小代码**

追加：

```powershell
function Get-AgentBridgeEnv {
    param(
        [string]$Cwd,
        [string]$Url,
        [string]$Session,
        [int]$AudioPort,
        [string]$Python,
        [string]$ResumeSession = ''
    )
    $env = @{
        AGENTBRIDGE_CWD         = $Cwd
        AGENTBRIDGE_URL         = $Url
        AGENTBRIDGE_SESSION     = $Session
        AGENTBRIDGE_AUDIO_PORT  = "$AudioPort"
        AGENTBRIDGE_PYTHON      = $Python
    }
    if ($ResumeSession -ne '') { $env.AGENTBRIDGE_RESUME_SESSION = $ResumeSession }
    return $env
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 16/16 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/lib-agentbridge.ps1 scripts/tests/lib-agentbridge.Tests.ps1
git commit -m "feat(scripts): add Get-AgentBridgeEnv helper"
```

---

### Task 4: 后台进程启动封装

**Files:**
- Modify: `scripts/lib-agentbridge.ps1`
- Modify: `scripts/tests/lib-agentbridge.Tests.ps1`

**Interfaces:**
- Produces: `Start-BackgroundProcess -Root <string> -Name <string> -FilePath <string> -ArgumentList <string[]> -WorkingDirectory <string> [-Env <hashtable>] [-LogFile <string>]`（返回 `[Process]`，写 `<Root>\.run\<Name>.pid`，建 `<Root>\logs\`）。
- Consumes: `Write-Pid`（Task 1）。

- [ ] **Step 1: 写失败测试**

追加：

```powershell
Describe 'Start-BackgroundProcess' {
    It 'starts a process, writes pid, process alive' {
        $proc = Start-BackgroundProcess -Root $testRoot -Name 'sleep' -FilePath 'powershell' `
            -ArgumentList @('-NoProfile','-Command','Start-Sleep 5') -WorkingDirectory $testRoot
        try {
            (Read-Pid -Root $testRoot -Name 'sleep') | Should -Be $proc.Id
            (Test-ProcessAlive -Pid $proc.Id) | Should -Be $true
        } finally {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现最小代码**

追加：

```powershell
function Start-BackgroundProcess {
    param(
        [string]$Root,
        [string]$Name,
        [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [string]$WorkingDirectory,
        [hashtable]$Env = @{},
        [string]$LogFile = $null
    )
    $logDir = Join-Path $Root 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

    foreach ($k in $Env.Keys) { Set-Item "Env:\$k" $Env[$k] }
    try {
        $psi = @{
            FilePath = $FilePath
            WorkingDirectory = $WorkingDirectory
            PassThru = $true
            WindowStyle = 'Hidden'
        }
        if ($ArgumentList.Count -gt 0) { $psi.ArgumentList = $ArgumentList }
        if ($LogFile) {
            $psi.RedirectStandardOutput = $LogFile
            $psi.RedirectStandardError = "$LogFile.err"
        }
        $proc = Start-Process @psi
    } finally {
        foreach ($k in $Env.Keys) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
    }
    Write-Pid -Root $Root -Name $Name -Pid $proc.Id
    return $proc
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `Invoke-Pester -Path scripts/tests/lib-agentbridge.Tests.ps1 -Output Detailed`
Expected: 17/17 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/lib-agentbridge.ps1 scripts/tests/lib-agentbridge.Tests.ps1
git commit -m "feat(scripts): add Start-BackgroundProcess helper"
```

---

### Task 5: `start-core.ps1` 起全局底座（冒烟）

**Files:**
- Create: `scripts/start-core.ps1`

**Interfaces:**
- Consumes: 所有 lib 函数（Task 1–4）。
- Produces: 顶层脚本，参数 `-CorePort`/`-SttPort`/`-Python`/`-SkipWatchdog`（默认值见 spec）。

- [ ] **Step 1: 写脚本**

创建 `scripts/start-core.ps1`：

```powershell
param(
    [int]$CorePort = 8088,
    [int]$SttPort = 8790,
    [string]$Python = "D:\environment\Python 3.13.7\python.exe",
    [switch]$SkipWatchdog
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib-agentbridge.ps1"

$toolRoot   = Resolve-ToolRoot
$coreDir    = Join-Path $toolRoot 'middleware-core'
$adapterDir = Join-Path $toolRoot 'agent-adapter'
$coreExe    = Join-Path $coreDir 'bin\core.exe'
$coreUrl    = "http://localhost:$CorePort"
$sttUrl     = "http://localhost:$SttPort"

# 1. Core
$corePid = Read-Pid -Root $toolRoot -Name 'core'
if ($corePid -and (Test-ProcessAlive -Pid $corePid) -and (Test-PortListening -Port $CorePort)) {
    Write-Host "[start-core] Core: skip (pid=$corePid)"
} else {
    Write-Host "[start-core] Core: go build..."
    Push-Location $coreDir
    try {
        go build -o bin\core.exe ./cmd/server
        if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
    } finally { Pop-Location }
    Start-BackgroundProcess -Root $toolRoot -Name 'core' -FilePath $coreExe -WorkingDirectory $coreDir `
        -Env @{ AGENTBRIDGE_ADDR = ":$CorePort" } -LogFile (Join-Path $toolRoot 'logs\core.log')
    if (-not (Wait-Health -Url "$coreUrl/health" -TimeoutSec 30)) { throw "Core unhealthy on :$CorePort" }
    Write-Host "[start-core] Core: running"
}

# 2. STT
$sttPid = Read-Pid -Root $toolRoot -Name 'stt'
if ($sttPid -and (Test-ProcessAlive -Pid $sttPid) -and (Test-PortListening -Port $SttPort)) {
    Write-Host "[start-core] STT: skip (pid=$sttPid)"
} else {
    $sttScript = Join-Path $adapterDir 'stt\transcribe_server.py'
    Start-BackgroundProcess -Root $toolRoot -Name 'stt' -FilePath $Python -ArgumentList @($sttScript) `
        -WorkingDirectory $adapterDir -Env @{ AGENTBRIDGE_STT_PORT = "$SttPort" } `
        -LogFile (Join-Path $toolRoot 'logs\stt.log')
    if (-not (Wait-Health -Url "$sttUrl/health" -TimeoutSec 60)) { throw "STT unhealthy on :$SttPort" }
    Write-Host "[start-core] STT: running"
}

# 3. watchdog
$wdPid = Read-Pid -Root $toolRoot -Name 'watchdog'
if ($wdPid -and (Test-ProcessAlive -Pid $wdPid)) {
    Write-Host "[start-core] watchdog: skip (pid=$wdPid)"
} elseif ($SkipWatchdog) {
    Write-Host "[start-core] watchdog: skipped (-SkipWatchdog)"
} else {
    $wdScript = Join-Path $toolRoot 'scripts\tunnel-watchdog.ps1'
    Start-BackgroundProcess -Root $toolRoot -Name 'watchdog' -FilePath 'powershell' `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wdScript) `
        -WorkingDirectory $toolRoot -LogFile (Join-Path $toolRoot 'logs\watchdog.log')
    Write-Host "[start-core] watchdog: running"
}

Write-Host "[start-core] done: Core=$CorePort STT=$SttPort"
```

- [ ] **Step 2: 冒烟——冷启动**

Run: `.\scripts\start-core.ps1`（确保当前无 Core/STT 在跑；若在跑先 `stop-core` 或手动停）
Expected: 依次 Core go build → running、STT running、watchdog running；`netstat -ano | findstr :8088` 与 `:8790` LISTENING；工具根 `.run\` 出现 `core.pid` `stt.pid` `watchdog.pid`。

- [ ] **Step 3: 冒烟——幂等**

Run: 再次 `.\scripts\start-core.ps1`
Expected: 三行全部 `skip`，无新进程、无端口冲突。

- [ ] **Step 4: Commit**

```bash
git add scripts/start-core.ps1
git commit -m "feat(scripts): add start-core.ps1 global base startup"
```

---

### Task 6: `stop-core.ps1`（冒烟）

**Files:**
- Create: `scripts/stop-core.ps1`

**Interfaces:**
- Consumes: `Resolve-ToolRoot`、`Read-Pid`、`Test-ProcessAlive`、`Remove-Pid`（Task 1–2）。

- [ ] **Step 1: 写脚本**

创建 `scripts/stop-core.ps1`：

```powershell
$ErrorActionPreference = "Continue"
. "$PSScriptRoot\lib-agentbridge.ps1"
$toolRoot = Resolve-ToolRoot

$order = @('watchdog', 'stt', 'core')
foreach ($name in $order) {
    $pidValue = Read-Pid -Root $toolRoot -Name $name
    if (-not $pidValue) { Write-Host "[stop-core] $name : no pid file"; continue }
    if (Test-ProcessAlive -Pid $pidValue) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        if (Test-ProcessAlive -Pid $pidValue) {
            Write-Host "[stop-core] $name : WARN process $pidValue still alive (pid reuse?)"
        } else {
            Write-Host "[stop-core] $name : stopped (pid=$pidValue)"
        }
    } else {
        Write-Host "[stop-core] $name : already gone (pid=$pidValue)"
    }
    Remove-Pid -Root $toolRoot -Name $name
}
Write-Host "[stop-core] done"
```

- [ ] **Step 2: 冒烟——全停**

Run: `.\scripts\stop-core.ps1`（紧接 Task 5，三样在跑）
Expected: watchdog → stt → core 依次 `stopped`；`netstat -ano | findstr :8088` 与 `:8790` 无 LISTENING；工具根 `.run\` 为空。

- [ ] **Step 3: 冒烟——再启动**

Run: `.\scripts\start-core.ps1` 然后 `.\scripts\stop-core.ps1`
Expected: 起得来、停得掉，无残留 PID。

- [ ] **Step 4: Commit**

```bash
git add scripts/stop-core.ps1
git commit -m "feat(scripts): add stop-core.ps1 global base shutdown"
```

---

### Task 7: `start-session.ps1` 改默认 cwd + 复用 lib（验证切换不回退）

**Files:**
- Modify: `scripts/start-session.ps1`

**Interfaces:**
- Consumes: `Resolve-ToolRoot`、`Get-AgentBridgeEnv`（Task 1、3）。
- Produces: `-Cwd` 默认 `(Get-Location).Path`；adapter 目录由 `Resolve-ToolRoot` 推导；前台 `node dist/session.js`；不写 PID。

- [ ] **Step 1: 改脚本**

将 `scripts/start-session.ps1` 整体替换为：

```powershell
param(
  [string]$Cwd = (Get-Location).Path,
  [string]$ResumeSession = "",
  [string]$Url = "http://localhost:8088",
  [string]$Session = "default",
  [int]$AudioPort = 8788,
  [string]$Python = "D:\environment\Python 3.13.7\python.exe"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib-agentbridge.ps1"

$sessionFile = Join-Path $Cwd ".agentbridge-current-session"
if ($ResumeSession -eq "" -and (Test-Path $sessionFile)) {
  $ResumeSession = (Get-Content $sessionFile -Raw).Trim()
}

$adapterDir = Join-Path (Resolve-ToolRoot) 'agent-adapter'

$envMap = Get-AgentBridgeEnv -Cwd $Cwd -Url $Url -Session $Session -AudioPort $AudioPort -Python $Python -ResumeSession $ResumeSession
foreach ($k in $envMap.Keys) { Set-Item "Env:\$k" $envMap[$k] }
if ($ResumeSession -eq "") { Remove-Item Env:\AGENTBRIDGE_RESUME_SESSION -ErrorAction SilentlyContinue }

$resumeLabel = "(latest in cwd)"
if ($ResumeSession -ne "") { $resumeLabel = $ResumeSession }
Write-Host "[session] cwd=$Cwd url=$Url session=$Session audioPort=$AudioPort python=$Python resume=$resumeLabel"

Set-Location $adapterDir
node dist/session.js
```

- [ ] **Step 2: 冒烟——切换项目不重起底座**

Run:
1. `.\scripts\start-core.ps1`（记下三个 PID）
2. 建临时项目目录：`New-Item -ItemType Directory -Force $env:TEMP\abr-projB`
3. `cd $env:TEMP\abr-projB` 后跑 `D:\project\5project\AgentBridge-master\scripts\start-session.ps1`
Expected: 打印 `[session] cwd=...abr-projB ... resume=(latest in cwd)`，`node` 前台跑起；`netstat` 确认 Core/STT 的 PID 与第 1 步一致（底座未重启）；Ctrl+C 停 session。

- [ ] **Step 3: Commit**

```bash
git add scripts/start-session.ps1
git commit -m "refactor(scripts): start-session default cwd + reuse lib"
```

---

### Task 8: `start-all.ps1` 冷启动便捷包装（冒烟）

**Files:**
- Create: `scripts/start-all.ps1`

**Interfaces:**
- Consumes: `start-core.ps1`（Task 5）、`start-session.ps1`（Task 7）。

- [ ] **Step 1: 写脚本**

创建 `scripts/start-all.ps1`：

```powershell
param(
    [string]$Cwd = (Get-Location).Path,
    [string]$ResumeSession = "",
    [string]$Url = "http://localhost:8088",
    [string]$Session = "default",
    [int]$AudioPort = 8788,
    [string]$Python = "D:\environment\Python 3.13.7\python.exe",
    [int]$CorePort = 8088,
    [int]$SttPort = 8790,
    [switch]$SkipWatchdog
)

$ErrorActionPreference = "Stop"

$coreArgs = @('-CorePort', "$CorePort", '-SttPort', "$SttPort", '-Python', $Python)
if ($SkipWatchdog) { $coreArgs += '-SkipWatchdog' }
& "$PSScriptRoot\start-core.ps1" @coreArgs

& "$PSScriptRoot\start-session.ps1" -Cwd $Cwd -ResumeSession $ResumeSession -Url $Url -Session $Session -AudioPort $AudioPort -Python $Python
```

- [ ] **Step 2: 冒烟——冷启动全量**

Run: 干净环境（`stop-core.ps1` 后）跑 `.\scripts\start-all.ps1`
Expected: 先 start-core 三样 running，再 start-session 前台 `node` 跑起。

- [ ] **Step 3: Commit**

```bash
git add scripts/start-all.ps1
git commit -m "feat(scripts): add start-all.ps1 cold-start wrapper"
```

---

### Task 9: `resume-glasses.ps1` 改默认 cwd（冒烟）

**Files:**
- Modify: `scripts/resume-glasses.ps1`

**Interfaces:**
- Produces: `-Cwd` 默认 `(Get-Location).Path`，其余行为不变（读 `<Cwd>\.agentbridge-current-session` → `claude -r <id>`）。

- [ ] **Step 1: 改默认值**

将 `scripts/resume-glasses.ps1` 的 `param` 第一行 `[string]$Cwd = "D:\project\5project\AgentBridge-master"` 改为：

```powershell
[string]$Cwd = (Get-Location).Path
```

- [ ] **Step 2: 冒烟**

Run: 在项目根 `.\scripts\resume-glasses.ps1`（当前目录有 `.agentbridge-current-session`）
Expected: 打印 `[resume] session=<id>` 并 `claude -r` 续上，与改前一致。

- [ ] **Step 3: Commit**

```bash
git add scripts/resume-glasses.ps1
git commit -m "refactor(scripts): resume-glasses default cwd to current dir"
```

---

### Task 10: `.gitignore` + 文档更新

**Files:**
- Modify: `.gitignore`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `.gitignore` 增加条目**

在 `.gitignore` 的 `# AgentBridge session handoff` 段附近追加：

```gitignore
# AgentBridge one-click startup runtime
.run/
logs/
```

- [ ] **Step 2: CLAUDE.md 更新「环境启动必查」**

将「环境启动必查」段改为先给一键命令，再列手动清单：

```markdown
**环境启动必查（推荐一键）**：
- 冷启动：`.\scripts\start-all.ps1`（Core + STT + watchdog + session.js）；切换项目：`cd 目标项目` 后 `.\scripts\start-session.ps1`；关底座：`.\scripts\stop-core.ps1`。详见 `docs/superpowers/specs/2026-08-25-one-click-startup-design.md`。
- 手动清单（备查）：Core `AGENTBRIDGE_ADDR=":8088"` / Adapter `AGENTBRIDGE_SESSION=default` / 眼镜连接见「眼镜连接模式」/ 双设备 `4EU0221B11003871` + `1901092534002787` / watchdog `scripts\tunnel-watchdog.ps1`。
```

- [ ] **Step 3: 冒烟——git status 干净**

Run: `.\scripts\start-core.ps1` 后 `git status --short`
Expected: 不出现工具根 `.run/`、`logs/`、`middleware-core/bin/core.exe` 相关条目。

- [ ] **Step 4: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs: wire layered startup into gitignore and CLAUDE.md"
```

---

## 最终自检

- [ ] `Invoke-Pester -Path scripts/tests/ -Output Detailed` 全绿（17 用例）。
- [ ] `start-core.ps1` 起三样 → 再跑全 skip → `stop-core.ps1` 全停、`.run/` 清空。
- [ ] `start-all.ps1` 冷启动四样 running。
- [ ] `cd 临时目录` 跑 `start-session.ps1` 只切会话，底座 PID 不变。
- [ ] `start-session.ps1`/`resume-glasses.ps1` 默认当前目录行为不回退。
- [ ] `git status` 中工具根 `.run/`、`logs/`、`core.exe` 均被忽略。
