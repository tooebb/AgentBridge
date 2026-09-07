param(
    [string]$Cwd = (Get-Location).Path,
    [string]$ResumeSession = "",
    [string]$Url = "http://localhost:8088",
    [string]$Session = "default",
    [int]$AudioPort = 8788,
    [string]$Python = "D:\environment\Python 3.13.7\python.exe",
    [int]$CorePort = 8088,
    [int]$SttPort = 8790,
    [int]$RelayPort = 8787,
    [switch]$SkipWatchdog,
    [switch]$Relay,
    [switch]$Pick
)

$ErrorActionPreference = "Stop"

$coreParams = @{
    CorePort  = $CorePort
    SttPort   = $SttPort
    RelayPort = $RelayPort
    Session   = $Session
    Python    = $Python
}
if ($SkipWatchdog) {
    $coreParams['SkipWatchdog'] = $true
}
if ($Relay) {
    $coreParams['Relay'] = $true
}

& "$PSScriptRoot\start-core.ps1" @coreParams
& "$PSScriptRoot\start-session.ps1" -Cwd $Cwd -ResumeSession $ResumeSession -Url $Url -Session $Session -AudioPort $AudioPort -Python $Python -Pick:$Pick
