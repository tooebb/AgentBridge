$adb = "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$dev = "4EU0221B11003871"

Write-Host "1. Cleaning old cache..."
& $adb -s $dev shell "run-as com.rokid.renewcxrlsample rm -f files/cxrL.apk"

Write-Host "2. Fixing permissions..."
& $adb -s $dev shell "chmod 644 /sdcard/agentbridge.apk"

Write-Host "3. Copying to internal dir..."
& $adb -s $dev shell "cat /sdcard/agentbridge.apk | run-as com.rokid.renewcxrlsample sh -c 'cat > files/cxrL.apk'"

Write-Host "4. Verifying..."
& $adb -s $dev shell "run-as com.rokid.renewcxrlsample ls -la files/cxrL.apk"
