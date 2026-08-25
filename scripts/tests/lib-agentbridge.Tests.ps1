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
        try {
            Test-PortListening -Port $port | Should -Be $true
        } finally {
            $l.Stop()
        }
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
