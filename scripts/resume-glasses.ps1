# Resume, in the PC terminal, the session the glasses daemon last recorded.
# The daemon writes the active session id to <Cwd>\.agentbridge-current-session
# every time it resumes, so this is the "回家接力" counter-part to start-session.ps1.
#
# Usage:
#   .\scripts\resume-glasses.ps1                        # resume recorded session in default project
#   .\scripts\resume-glasses.ps1 -Cwd D:\path\to\proj   # point at a specific project dir

param(
  [string]$Cwd = (Get-Location).Path
)

$ErrorActionPreference = "Stop"

$sessionFile = Join-Path $Cwd ".agentbridge-current-session"
if (-not (Test-Path $sessionFile)) {
  Write-Host "[resume] no recorded session at $sessionFile"
  Write-Host "[resume] start the glasses daemon (.\scripts\start-session.ps1) and speak once first"
  exit 1
}

$sessionId = (Get-Content $sessionFile -Raw).Trim()
if ($sessionId -eq "") {
  Write-Host "[resume] recorded session is empty"
  exit 1
}

Write-Host "[resume] session=$sessionId"
Set-Location $Cwd
claude -r $sessionId
