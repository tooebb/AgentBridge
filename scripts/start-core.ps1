param(
    [int]$CorePort = 8088,
    [int]$SttPort = 8790,
    [string]$Python = "D:\environment\Python 3.13.7\python.exe",
    [switch]$SkipWatchdog
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib-agentbridge.ps1"

$toolRoot = Resolve-ToolRoot
$coreDir = Join-Path $toolRoot 'middleware-core'
$adapterDir = Join-Path $toolRoot 'agent-adapter'
$coreExe = Join-Path $coreDir 'bin\core.exe'
$coreUrl = "http://localhost:$CorePort"
$sttUrl = "http://127.0.0.1:$SttPort"

$corePid = Read-Pid -Root $toolRoot -Name 'core'
if ($corePid -and (Test-ProcessAlive -Pid $corePid) -and (Test-PortListening -Port $CorePort)) {
    Write-Host "[start-core] Core: skip (pid=$corePid)"
} else {
    if ($corePid) {
        Remove-Pid -Root $toolRoot -Name 'core'
    }

    Write-Host "[start-core] Core: go build..."
    Push-Location $coreDir
    try {
        go build -o bin\core.exe ./cmd/server
        if ($LASTEXITCODE -ne 0) {
            throw 'go build failed'
        }
    } finally {
        Pop-Location
    }

    Start-BackgroundProcess -Root $toolRoot -Name 'core' -FilePath $coreExe -WorkingDirectory $coreDir `
        -Env @{ AGENTBRIDGE_ADDR = ":$CorePort" } -LogFile (Join-Path $toolRoot 'logs\core.log') | Out-Null

    if (-not (Wait-Health -Url "$coreUrl/health" -TimeoutSec 30 -IntervalSec 1)) {
        Get-Content (Join-Path $toolRoot 'logs\core.log') -Tail 40 -ErrorAction SilentlyContinue
        Get-Content (Join-Path $toolRoot 'logs\core.log.err') -Tail 40 -ErrorAction SilentlyContinue
        throw "Core unhealthy on :$CorePort"
    }

    Write-Host "[start-core] Core: running"
}

$sttPid = Read-Pid -Root $toolRoot -Name 'stt'
if ($sttPid -and (Test-ProcessAlive -Pid $sttPid) -and (Test-PortListening -Port $SttPort)) {
    Write-Host "[start-core] STT: skip (pid=$sttPid)"
} else {
    if ($sttPid) {
        Remove-Pid -Root $toolRoot -Name 'stt'
    }

    $sttScript = Join-Path $adapterDir 'stt\transcribe_server.py'
    Start-BackgroundProcess -Root $toolRoot -Name 'stt' -FilePath $Python -ArgumentList @($sttScript) `
        -WorkingDirectory $adapterDir -Env @{ AGENTBRIDGE_STT_PORT = "$SttPort" } `
        -LogFile (Join-Path $toolRoot 'logs\stt.log') | Out-Null

    if (-not (Wait-Health -Url "$sttUrl/health" -TimeoutSec 180 -IntervalSec 1)) {
        Get-Content (Join-Path $toolRoot 'logs\stt.log') -Tail 40 -ErrorAction SilentlyContinue
        Get-Content (Join-Path $toolRoot 'logs\stt.log.err') -Tail 40 -ErrorAction SilentlyContinue
        throw "STT unhealthy on :$SttPort"
    }

    Write-Host "[start-core] STT: running"
}

$wdPid = Read-Pid -Root $toolRoot -Name 'watchdog'
if ($wdPid -and (Test-ProcessAlive -Pid $wdPid)) {
    Write-Host "[start-core] watchdog: skip (pid=$wdPid)"
} elseif ($SkipWatchdog) {
    if ($wdPid) {
        Remove-Pid -Root $toolRoot -Name 'watchdog'
    }
    Write-Host "[start-core] watchdog: skipped (-SkipWatchdog)"
} else {
    if ($wdPid) {
        Remove-Pid -Root $toolRoot -Name 'watchdog'
    }

    $wdScript = Join-Path $toolRoot 'scripts\tunnel-watchdog.ps1'
    Start-BackgroundProcess -Root $toolRoot -Name 'watchdog' -FilePath 'powershell' `
        -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$wdScript) `
        -WorkingDirectory $toolRoot -LogFile (Join-Path $toolRoot 'logs\watchdog.log') | Out-Null
    Write-Host "[start-core] watchdog: running"
}

Write-Host "[start-core] done: Core=$CorePort STT=$SttPort"
