$adb = "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$dev = "4EU0221B11003871"
$glassesDev = "1901092534002787"

Write-Host "1. Cleaning old cache..."
& $adb -s $dev shell "run-as com.rokid.renewcxrlsample rm -f files/cxrL.apk"

Write-Host "2. Fixing permissions..."
& $adb -s $dev shell "chmod 644 /sdcard/agentbridge.apk"

Write-Host "3. Copying to internal dir..."
& $adb -s $dev shell "cat /sdcard/agentbridge.apk | run-as com.rokid.renewcxrlsample sh -c 'cat > files/cxrL.apk'"

Write-Host "4. Verifying..."
& $adb -s $dev shell "run-as com.rokid.renewcxrlsample ls -la files/cxrL.apk"

Write-Host "5. Enable glasses WiFi..."
try {
    & $adb -s $glassesDev shell "svc wifi enable" 2>$null
    Start-Sleep -Seconds 2
    $ip = & $adb -s $glassesDev shell "ip addr show wlan0 | grep 'inet '" 2>$null
    if ($ip) {
        Write-Host "   WiFi OK: $($ip.Trim())"
    } else {
        Write-Host "   WiFi enabled (no IP yet — may connect shortly)"
    }
} catch {
    Write-Host "   Glasses not reachable (USB disconnected?) — skip WiFi enable"
}

Write-Host "Done."
