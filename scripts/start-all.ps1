param(
    [string]$Cwd = (Get-Location).Path,
    [string]$ResumeSession = "",
    [string]$Url = "http://localhost:8088",
    [string]$Session = "default",
    [int]$AudioPort = 8788,
    [string]$Python = "D:\environment\Python 3.13.7\python.exe",
    [int]$CorePort = 8088,
    [int]$SttPort = 8790,
    [switch]$SkipWatchdog
)

$ErrorActionPreference = "Stop"

$coreParams = @{
    CorePort = $CorePort
    SttPort  = $SttPort
    Python   = $Python
}
if ($SkipWatchdog) {
    $coreParams['SkipWatchdog'] = $true
}

& "$PSScriptRoot\start-core.ps1" @coreParams
& "$PSScriptRoot\start-session.ps1" -Cwd $Cwd -ResumeSession $ResumeSession -Url $Url -Session $Session -AudioPort $AudioPort -Python $Python
