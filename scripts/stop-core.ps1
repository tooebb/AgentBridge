$ErrorActionPreference = "Continue"
. "$PSScriptRoot\lib-agentbridge.ps1"

$toolRoot = Resolve-ToolRoot
$order = @('watchdog', 'stt', 'core')

foreach ($name in $order) {
    $pidValue = Read-Pid -Root $toolRoot -Name $name
    if (-not $pidValue) {
        Write-Host "[stop-core] $name : no pid file"
        continue
    }

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
