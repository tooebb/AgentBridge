# 一键启动/关闭（线 B 全量环境）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `start-all.ps1` / `stop-all.ps1` 一键拉起/关闭线 B 语音会话的 Core + STT + watchdog + session.js 四类进程。

**Architecture:** 新增共享库 `lib-agentbridge.ps1`（纯函数：PID 读写、进程/端口/健康探测、环境变量组装、后台进程启动），两个编排脚本调用它；用 PID 文件（`.run/*.pid`）+ 端口健康检查做幂等启动与精确关闭。

**Tech Stack:** Windows PowerShell 5.1、Pester 5（单测）、Go build（Core 二进制）、faster_whisper（STT，已被 transcribe_server.py 封装）。

## Global Constraints

- 不改 Core 协议、不改 AgentBridgeClient 消息协议、审批链路不变（纯运维脚本层）。
- 脚本兼容 Windows PowerShell 5.1：禁用 `&&`、`||`、`??`、`?.`、三元表达式。
- 日常使用命令必须零参数可用（`.\scripts\start-all.ps1` / `.\scripts\stop-all.ps1`）。
- PID 文件目录 `.run/`、日志目录 `logs/`、`middleware-core/bin/core.exe` 必须被 `.gitignore` 忽略。

---

### Task 1: Pester 基础设施 + lib PID 函数

**Files:**
- Create: `scripts/lib-agentbridge.ps1`
- Create: `scripts/tests/lib-agentbridge.Tests.ps1`

**Interfaces:**
- Produces: `Write-Pid -Root <string> -Name <string> -Pid <int>`、`Read-Pid -Root <string> -Name <string>`（返回 `[int]` 或 `$null`）、`Remove-Pid -Root <string> -Name <string>`。PID 文件位于 `<Root>\.run\<Name>.pid`。

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
Expected: FAIL，报 `The term 'Write-Pid' is not recognized`。

- [ ] **Step 4: 实现最小代码**

创建 `scripts/lib-agentbridge.ps1`：

```powershell
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
Expected: 5/5 PASS。

- [ ] **Step 6: Commit**

```bash
git add scripts/lib-agentbridge.ps1 scripts/tests/lib-agentbridge.Tests.ps1
git commit -m "feat(scripts): add PID helpers to lib-agentbridge with Pester tests"
```

---

### Task 2: 进程/端口/健康探测函数

**Files:**
- Modify: `scripts/lib-agentbridge.ps1`
- Modify: `scripts/tests/lib-agentbridge.Tests.ps1`

**Interfaces:**
- Produces: `Test-ProcessAlive -Pid <int>`（返回 `[bool]`）、`Test-PortListening -Port <int>`（返回 `[bool]`）、`Wait-Health -Url <string> -TimeoutSec <int> -IntervalSec <int>`（返回 `[bool]`）。
- Consumes: 无（独立函数）。

- [ ] **Step 1: 写失败测试**

在 `scripts/tests/lib-agentbridge.Tests.ps1` 追加：

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
Expected: 新增 7 个用例 FAIL，报函数未定义。

- [ ] **Step 3: 实现最小代码**

在 `scripts/lib-agentbridge.ps1` 追加：

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
Expected: 12/12 PASS。

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
- Produces: `Get-AgentBridgeEnv -Cwd <string> -Url <string> -Session <string> -AudioPort <int> -Python <string> [-ResumeSession <string>]`（返回 `[hashtable]`，key 为 `AGENTBRIDGE_CWD`/`AGENTBRIDGE_URL`/`AGENTBRIDGE_SESSION`/`AGENTBRIDGE_AUDIO_PORT`/`AGENTBRIDGE_PYTHON`，`-ResumeSession` 非空时额外含 `AGENTBRIDGE_RESUME_SESSION`）。

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
Expected: 15/15 PASS。

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
- Produces: `Start-BackgroundProcess -Root <string> -Name <string> -FilePath <string> -ArgumentList <string[]> -WorkingDirectory <string> [-Env <hashtable>] [-LogFile <string>]`（返回 `[System.Diagnostics.Process]`，内部写 `<Root>\.run\<Name>.pid`，创建 `<Root>\logs\` 目录；`-LogFile` 提供时用 `-RedirectStandardOutput` 到 `<LogFile>`、`-RedirectStandardError` 到 `<LogFile>.err`）。
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
Expected: 新增用例 FAIL，报函数未定义。

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
Expected: 16/16 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/lib-agentbridge.ps1 scripts/tests/lib-agentbridge.Tests.ps1
git commit -m "feat(scripts): add Start-BackgroundProcess helper"
```

---

### Task 5: `start-all.ps1` 编排（真机冒烟）

**Files:**
- Create: `scripts/start-all.ps1`

**Interfaces:**
- Consumes: 所有 lib 函数（Task 1–4）。
- Produces: 顶层脚本，参数 `-Cwd`/`-Python`/`-CorePort`/`-SttPort`/`-Session`/`-AudioPort`/`-ResumeSession`/`-SkipWatchdog`（默认值见 spec）。

- [ ] **Step 1: 写脚本**

创建 `scripts/start-all.ps1`：

```powershell
param(
    [string]$Cwd = "D:\project\5project\AgentBridge-master",
    [string]$Python = "D:\environment\Python 3.13.7\python.exe",
    [int]$CorePort = 8088,
    [int]$SttPort = 8790,
    [string]$Session = "default",
    [int]$AudioPort = 8788,
    [string]$ResumeSession = "",
    [switch]$SkipWatchdog
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib-agentbridge.ps1"

$coreDir    = Join-Path $Cwd 'middleware-core'
$adapterDir = Join-Path $Cwd 'agent-adapter'
$coreExe    = Join-Path $coreDir 'bin\core.exe'
$coreUrl    = "http://localhost:$CorePort"
$sttUrl     = "http://localhost:$SttPort"

# 1. Core
$corePid = Read-Pid -Root $Cwd -Name 'core'
if ($corePid -and (Test-ProcessAlive -Pid $corePid) -and (Test-PortListening -Port $CorePort)) {
    Write-Host "[start-all] Core: skip (pid=$corePid)"
} else {
    Write-Host "[start-all] Core: go build..."
    Push-Location $coreDir
    try {
        go build -o bin\core.exe ./cmd/server
        if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
    } finally { Pop-Location }
    Start-BackgroundProcess -Root $Cwd -Name 'core' -FilePath $coreExe -WorkingDirectory $coreDir `
        -Env @{ AGENTBRIDGE_ADDR = ":$CorePort" } -LogFile (Join-Path $Cwd 'logs\core.log')
    if (-not (Wait-Health -Url "$coreUrl/health" -TimeoutSec 30)) { throw "Core unhealthy on :$CorePort" }
    Write-Host "[start-all] Core: running"
}

# 2. STT
$sttPid = Read-Pid -Root $Cwd -Name 'stt'
if ($sttPid -and (Test-ProcessAlive -Pid $sttPid) -and (Test-PortListening -Port $SttPort)) {
    Write-Host "[start-all] STT: skip (pid=$sttPid)"
} else {
    $sttScript = Join-Path $adapterDir 'stt\transcribe_server.py'
    Start-BackgroundProcess -Root $Cwd -Name 'stt' -FilePath $Python -ArgumentList @($sttScript) `
        -WorkingDirectory $adapterDir -Env @{ AGENTBRIDGE_STT_PORT = "$SttPort" } `
        -LogFile (Join-Path $Cwd 'logs\stt.log')
    if (-not (Wait-Health -Url "$sttUrl/health" -TimeoutSec 60)) { throw "STT unhealthy on :$SttPort" }
    Write-Host "[start-all] STT: running"
}

# 3. watchdog
$wdPid = Read-Pid -Root $Cwd -Name 'watchdog'
if ($wdPid -and (Test-ProcessAlive -Pid $wdPid)) {
    Write-Host "[start-all] watchdog: skip (pid=$wdPid)"
} elseif ($SkipWatchdog) {
    Write-Host "[start-all] watchdog: skipped (-SkipWatchdog)"
} else {
    $wdScript = Join-Path $Cwd 'scripts\tunnel-watchdog.ps1'
    Start-BackgroundProcess -Root $Cwd -Name 'watchdog' -FilePath 'powershell' `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wdScript) `
        -WorkingDirectory $Cwd -LogFile (Join-Path $Cwd 'logs\watchdog.log')
    Write-Host "[start-all] watchdog: running"
}

# 4. session.js (independent visible window)
$sessPid = Read-Pid -Root $Cwd -Name 'session'
if ($sessPid -and (Test-ProcessAlive -Pid $sessPid)) {
    Write-Host "[start-all] session: skip (pid=$sessPid)"
} else {
    $envMap = Get-AgentBridgeEnv -Cwd $Cwd -Url $coreUrl -Session $Session -AudioPort $AudioPort -Python $Python -ResumeSession $ResumeSession
    foreach ($k in $envMap.Keys) { Set-Item "Env:\$k" $envMap[$k] }
    try {
        $proc = Start-Process -FilePath 'node' -ArgumentList 'dist/session.js' -WorkingDirectory $adapterDir -PassThru
    } finally {
        foreach ($k in $envMap.Keys) { Remove-Item "Env:\$k" -ErrorAction SilentlyContinue }
    }
    Write-Pid -Root $Cwd -Name 'session' -Pid $proc.Id
    Write-Host "[start-all] session: running (pid=$($proc.Id))"
}

Write-Host "[start-all] done: Core=$CorePort STT=$SttPort session=$Session"
```

- [ ] **Step 2: 冒烟——冷启动**

Run: `.\scripts\start-all.ps1`（在项目根，确保当前无 Core/STT/session 在跑）
Expected: 依次打印 Core go build → running、STT running、watchdog running、session running；`netstat -ano | findstr :8088` 和 `:8790` 均 LISTENING；`ls .run\` 出现 `core.pid` `stt.pid` `watchdog.pid` `session.pid`。

- [ ] **Step 3: 冒烟——幂等**

Run: 再次 `.\scripts\start-all.ps1`
Expected: 四行全部 `skip`，无新进程、无端口冲突。

- [ ] **Step 4: Commit**

```bash
git add scripts/start-all.ps1
git commit -m "feat(scripts): add start-all.ps1 one-click startup"
```

---

### Task 6: `stop-all.ps1`（真机冒烟）

**Files:**
- Create: `scripts/stop-all.ps1`

**Interfaces:**
- Consumes: `Read-Pid`、`Test-ProcessAlive`、`Remove-Pid`（Task 1–2）。
- Produces: 顶层脚本，参数 `-Cwd`（默认项目根）。

- [ ] **Step 1: 写脚本**

创建 `scripts/stop-all.ps1`：

```powershell
param([string]$Cwd = "D:\project\5project\AgentBridge-master")

$ErrorActionPreference = "Continue"
. "$PSScriptRoot\lib-agentbridge.ps1"

$order = @('session', 'watchdog', 'stt', 'core')
foreach ($name in $order) {
    $pidValue = Read-Pid -Root $Cwd -Name $name
    if (-not $pidValue) { Write-Host "[stop-all] $name : no pid file"; continue }
    if (Test-ProcessAlive -Pid $pidValue) {
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
        if (Test-ProcessAlive -Pid $pidValue) {
            Write-Host "[stop-all] $name : WARN process $pidValue still alive (pid reuse?)"
        } else {
            Write-Host "[stop-all] $name : stopped (pid=$pidValue)"
        }
    } else {
        Write-Host "[stop-all] $name : already gone (pid=$pidValue)"
    }
    Remove-Pid -Root $Cwd -Name $name
}
Write-Host "[stop-all] done"
```

- [ ] **Step 2: 冒烟——全停**

Run: `.\scripts\stop-all.ps1`（紧接 Task 5 之后，四样都在跑）
Expected: session → watchdog → stt → core 依次 `stopped`；`netstat -ano | findstr :8088` 与 `:8790` 无 LISTENING；`ls .run\` 为空。

- [ ] **Step 3: 冒烟——再启动**

Run: `.\scripts\start-all.ps1` 然后 `.\scripts\stop-all.ps1`
Expected: 起得来、停得掉，无残留 PID 文件。

- [ ] **Step 4: Commit**

```bash
git add scripts/stop-all.ps1
git commit -m "feat(scripts): add stop-all.ps1 one-click shutdown"
```

---

### Task 7: `start-session.ps1` 复用 lib（验证不回退）

**Files:**
- Modify: `scripts/start-session.ps1`

**Interfaces:**
- Consumes: `Get-AgentBridgeEnv`（Task 3）。
- Produces: 行为不变（读 `.agentbridge-current-session` 兜底 resume + 设环境变量 + 前台 `node dist/session.js`），仅环境变量组装改为复用 lib。

- [ ] **Step 1: 重构环境变量组装**

将 `scripts/start-session.ps1` 中手工 `$env:AGENTBRIDGE_* = ...` 的 6 行替换为：

```powershell
. "$PSScriptRoot\lib-agentbridge.ps1"
$envMap = Get-AgentBridgeEnv -Cwd $Cwd -Url $Url -Session $Session -AudioPort $AudioPort -Python $Python -ResumeSession $ResumeSession
foreach ($k in $envMap.Keys) { Set-Item "Env:\$k" $envMap[$k] }
if ($ResumeSession -eq "") { Remove-Item Env:\AGENTBRIDGE_RESUME_SESSION -ErrorAction SilentlyContinue }
```

保留其余逻辑（读 `.agentbridge-current-session`、`Set-Location $adapterDir`、`node dist/session.js`）不动。

- [ ] **Step 2: 冒烟——出门接力不回退**

Run: 只保证 Core 在跑（`cd middleware-core && go run cmd/server/main.go`），不要用 `start-all.ps1`（它会同时起 session.js，与 start-session 冲突）；再在项目根跑 `.\scripts\start-session.ps1`。
Expected: 打印 `[session] ... resume=<id>`，`node dist/session.js` 前台跑起，与重构前一致；Ctrl+C 能停掉。

- [ ] **Step 3: Commit**

```bash
git add scripts/start-session.ps1
git commit -m "refactor(scripts): start-session reuses Get-AgentBridgeEnv"
```

---

### Task 8: `.gitignore` + 文档更新

**Files:**
- Modify: `.gitignore`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 全部（Task 1–7）。
- Produces: 忽略 `.run/`、`logs/`；CLAUDE.md「环境启动必查」改为指向一键脚本。

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
- 一键启动：`.\scripts\start-all.ps1`（拉起 Core + STT + watchdog + session.js）；`.\scripts\stop-all.ps1` 全部关闭。详见 `docs/superpowers/specs/2026-08-25-one-click-startup-design.md`。
- 手动清单（备查）：Core `AGENTBRIDGE_ADDR=":8088"` / Adapter `AGENTBRIDGE_SESSION=default` / 眼镜连接见「眼镜连接模式」/ 双设备 `4EU0221B11003871` + `1901092534002787` / watchdog `scripts\tunnel-watchdog.ps1`。
```

- [ ] **Step 3: 冒烟——git status 干净**

Run: `.\scripts\start-all.ps1` 后 `git status --short`
Expected: 不出现 `.run/`、`logs/`、`middleware-core/bin/core.exe` 相关条目。

- [ ] **Step 4: Commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs: wire one-click startup into gitignore and CLAUDE.md"
```

---

## 最终自检

- [ ] `Invoke-Pester -Path scripts/tests/ -Output Detailed` 全绿（16 用例）。
- [ ] 冷启动 `start-all.ps1` → 四样 running；重复跑全 skip；`stop-all.ps1` → 全停、`.run/` 清空。
- [ ] `start-session.ps1` 出门接力行为不回退。
- [ ] `git status` 中 `.run/`、`logs/`、`core.exe` 均被忽略。
