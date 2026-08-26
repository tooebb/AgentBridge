# Tunnel Watchdog — ADB reverse tunnels + glasses WiFi keep-alive
# Run in background: Start-Process powershell -ArgumentList "-File scripts/tunnel-watchdog.ps1" -WindowStyle Hidden
#
# Architecture v2 (2026-08-11): Glasses connect to Core via LAN WiFi (ws://192.168.31.209:8088).
# ADB reverse tunnels are fallback; the primary role is keeping glasses WiFi alive
# because Android 10+ blocks setWifiEnabled() from non-system apps.

$adb = "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$devices = @("4EU0221B11003871", "1901092534002787")
$glassesDev = "1901092534002787"
$coreHealth = "http://127.0.0.1:8088/health"

while ($true) {
    Start-Sleep -Seconds 10

    # --- ADB daemon auto-restart ---
    # If adb daemon is dead or port-locked, restart it so WiFi keep-alive
    # and tunnel checks don't silently fail.
    try {
        $devList = & $adb devices 2>&1
        if ($LASTEXITCODE -ne 0 -or $devList -match "cannot connect|still not running") {
            Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') adb daemon dead, restarting..."
            & $adb kill-server 2>$null
            Start-Sleep -Seconds 2
            & $adb start-server 2>$null
        }
    } catch { }

    try {
        $health = Invoke-WebRequest -Uri $coreHealth -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        if ($health.StatusCode -ne 200) { continue }
    } catch {
        continue
    }

    # --- Glasses WiFi keep-alive ---
    # The glasses OS disables WiFi to save power; the app holds a WiFiLock once
    # running, but after reboot or crash WiFi is off.  This block re-enables it.
    try {
        $available = & $adb devices 2>$null | Select-String $glassesDev
        if ($available) {
            $wifiStatus = & $adb -s $glassesDev shell "dumpsys wifi | grep 'Wi-Fi is'" 2>$null
            if ($wifiStatus -match "disabled") {
                Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') glasses WiFi disabled, enabling..."
                & $adb -s $glassesDev shell "svc wifi enable" 2>$null
                Start-Sleep -Seconds 3
                $wifiCheck = & $adb -s $glassesDev shell "dumpsys wifi | grep 'Wi-Fi is'" 2>$null
                if ($wifiCheck -match "enabled") {
                    Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') glasses WiFi enabled OK"
                }
            }
        }
    } catch { }  # glasses may be offline — skip this cycle

    foreach ($device in $devices) {
        $available = & $adb devices 2>$null | Select-String $device
        if (-not $available) { continue }

        $tunnel = & $adb -s $device reverse --list 2>$null
        # `adb reverse` listens on the device, so the tunnel can't be health-checked
        # from the PC via 127.0.0.1:19090. Core health is already gated at the top of
        # the loop (http://127.0.0.1:8088/health); here we only verify the tunnel is
        # registered and recreate whichever one is missing — without --remove-all,
        # which used to flap the audio tunnel every cycle and break voice input.
        $needCore = -not ($tunnel -match "tcp:19090")
        $needAudio = ($device -eq $glassesDev) -and -not ($tunnel -match "tcp:8788")

        if ($needCore) {
            & $adb -s $device reverse tcp:19090 tcp:8088
            Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') $device tunnel recreated"
        }
        if ($needAudio) {
            & $adb -s $device reverse tcp:8788 tcp:8788
            Write-Host "[watchdog] $(Get-Date -Format 'HH:mm:ss') $device audio tunnel recreated"
        }
    }
}
