function Resolve-ToolRoot {
    return Split-Path $PSScriptRoot -Parent
}

function Write-Pid {
    param(
        [string]$Root,
        [string]$Name,
        [Alias('Pid')]
        [int]$ProcessId
    )

    $runDir = Join-Path $Root '.run'
    if (-not (Test-Path $runDir)) {
        New-Item -ItemType Directory -Path $runDir -Force | Out-Null
    }

    Set-Content -Path (Join-Path $runDir "$Name.pid") -Value "$ProcessId" -Encoding ASCII
}

function Read-Pid {
    param(
        [string]$Root,
        [string]$Name
    )

    $file = Join-Path $Root (Join-Path '.run' "$Name.pid")
    if (-not (Test-Path $file)) {
        return $null
    }

    $raw = (Get-Content $file -Raw).Trim()
    if ($raw -eq '') {
        return $null
    }

    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed)) {
        return $parsed
    }

    return $null
}

function Remove-Pid {
    param(
        [string]$Root,
        [string]$Name
    )

    $file = Join-Path $Root (Join-Path '.run' "$Name.pid")
    if (Test-Path $file) {
        Remove-Item $file -Force
    }
}

function Test-ProcessAlive {
    param(
        [Alias('Pid')]
        [int]$ProcessId
    )

    if ($ProcessId -le 0) {
        return $false
    }

    try {
        return $null -ne (Get-Process -Id $ProcessId -ErrorAction Stop)
    } catch {
        return $false
    }
}

function Test-PortListening {
    param([int]$Port)

    $line = netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING'
    return ($null -ne $line)
}

function Wait-Health {
    param(
        [string]$Url,
        [int]$TimeoutSec = 30,
        [int]$IntervalSec = 1
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                return $true
            }
        } catch {
        }
        Start-Sleep -Seconds $IntervalSec
    }

    return $false
}

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
        AGENTBRIDGE_CWD        = $Cwd
        AGENTBRIDGE_URL        = $Url
        AGENTBRIDGE_SESSION    = $Session
        AGENTBRIDGE_AUDIO_PORT = "$AudioPort"
        AGENTBRIDGE_PYTHON     = $Python
    }

    if ($ResumeSession -ne '') {
        $env.AGENTBRIDGE_RESUME_SESSION = $ResumeSession
    }

    return $env
}

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
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    $oldEnv = @{}
    foreach ($k in $Env.Keys) {
        $oldEnv[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        Set-Item "Env:\$k" $Env[$k]
    }

    try {
        $psi = @{
            FilePath = $FilePath
            WorkingDirectory = $WorkingDirectory
            PassThru = $true
            WindowStyle = 'Hidden'
        }

        if ($ArgumentList.Count -gt 0) {
            $psi.ArgumentList = $ArgumentList
        }

        if ($LogFile) {
            $psi.RedirectStandardOutput = $LogFile
            $psi.RedirectStandardError = "$LogFile.err"
        }

        $proc = Start-Process @psi
    } finally {
        foreach ($k in $Env.Keys) {
            if ($null -eq $oldEnv[$k]) {
                Remove-Item "Env:\$k" -ErrorAction SilentlyContinue
            } else {
                Set-Item "Env:\$k" $oldEnv[$k]
            }
        }
    }

    Write-Pid -Root $Root -Name $Name -Pid $proc.Id
    return $proc
}
