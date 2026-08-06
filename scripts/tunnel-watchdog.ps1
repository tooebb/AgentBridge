# Tunnel Watchdog — keeps ADB reverse tunnel alive
# Run in background: Start-Process powershell -ArgumentList "-File scripts/tunnel-watchdog.ps1" -WindowStyle Hidden

$adb = "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe"
# Both devices need tunnels — the CustomApp runs on the GLASSES (1901092534002787)
# and uses localhost:19090 to reach the PC via ADB reverse
$devices = @("4EU0221B11003871", "1901092534002787")
$coreHealth = "http://127.0.0.1:8088/health"

while ($true) {
    Start-Sleep -Seconds 10

    try {
        $health = Invoke-WebRequest -Uri $coreHealth -TimeoutSec 3 -ErrorAction Stop
        if ($health.StatusCode -ne 200) { continue }
    } catch {
        continue
    }

    foreach ($device in $devices) {
        $available = & $adb devices 2>$null | Select-String $device
        if (-not $available) { continue }

        $tunnel = & $adb -s $device reverse --list 2>$null
        if ($tunnel -match "tcp:19090") {
            try {
                $test = Invoke-WebRequest -Uri "http://127.0.0.1:19090/health" -TimeoutSec 3 -ErrorAction Stop
                if ($test.StatusCode -eq 200) { continue }
            } catch {
                Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') $device tunnel dead, recreating..."
            }
        } else {
            Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') $device tunnel missing, creating..."
        }

        & $adb -s $device reverse --remove-all 2>$null
        Start-Sleep -Seconds 1
        & $adb -s $device reverse tcp:19090 tcp:8088
        Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') $device tunnel recreated"
    }
}
