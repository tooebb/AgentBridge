# Writes manual PC IP / preferred id into the glasses app's SharedPreferences.
# NOTE: This script relies on `adb run-as`, which the Rokid glasses ROM blocks
# (returns "error: closed", same as `pm`/`dumpsys`). It works on stock Android
# debug builds but is NOT usable on the current glasses device. Kept for
# reference and future ROMs that re-enable run-as.
param(
    [string]$Ip = "",
    [string]$Port = "8088",
    [string]$PreferredId = ""
)

$adb = "C:\Users\_\AppData\Local\Android\Sdk\platform-tools\adb.exe"
$glasses = "1901092534002787"
$pkg = "com.rokid.cxrswithcxrl"

$lines = @()
$lines += "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>"
$lines += "<map>"
if ($Ip) { $lines += "    <string name=`"manual_pc_ip`">$Ip</string>" }
$lines += "    <int name=`"manual_pc_port`" value=`"$Port`" />"
if ($PreferredId) { $lines += "    <string name=`"preferred_pc_id`">$PreferredId</string>" }
$lines += "</map>"
$xml = $lines -join "`n"

$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xml))

Write-Host "Writing agent_bridge config to glasses..."
& $adb -s $glasses shell "run-as $pkg sh -c 'mkdir -p shared_prefs && echo $b64 | base64 -d > shared_prefs/agent_bridge.xml'"

Write-Host "Force-stopping app so config takes effect on next launch..."
& $adb -s $glasses shell "am force-stop $pkg"

Write-Host "Done. Config: ip=$Ip port=$Port preferredId=$PreferredId"
