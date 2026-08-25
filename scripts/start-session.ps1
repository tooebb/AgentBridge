# Start the AgentBridge voice session daemon (agent-adapter/dist/session.js)
# with AGENTBRIDGE_CWD pinned, so Claude resumes the intended project session
# instead of agent-adapter's stale "latest" session.
#
# Usage:
#   .\scripts\start-session.ps1                          # resume last recorded session (or latest in cwd)
#   .\scripts\start-session.ps1 -Cwd D:\path\to\proj     # point at a specific project dir
#   .\scripts\start-session.ps1 -Cwd D:\path\to\empty    # start a fresh conversation
#   .\scripts\start-session.ps1 -ResumeSession <id>      # pin an explicit session id
#
# Note: -ResumeSession is optional. When omitted, the daemon resumes the session
# recorded in <Cwd>\.agentbridge-current-session (written by the adapter each time
# it resumes), falling back to the most recently modified project session — the
# "出门接力" mode. Pass -ResumeSession <id> to pin a specific session.

param(
  [string]$Cwd = (Get-Location).Path,
  [string]$ResumeSession = "",
  [string]$Url = "http://localhost:8088",
  [string]$Session = "default",
  [int]$AudioPort = 8788,
  [string]$Python = "D:\environment\Python 3.13.7\python.exe"
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\lib-agentbridge.ps1"

# If no explicit session is pinned, resume the session the daemon last
# recorded (written to .agentbridge-current-session by the adapter on resume).
$sessionFile = Join-Path $Cwd ".agentbridge-current-session"
if ($ResumeSession -eq "" -and (Test-Path $sessionFile)) {
  $ResumeSession = (Get-Content $sessionFile -Raw).Trim()
}

$adapterDir = Join-Path (Resolve-ToolRoot) 'agent-adapter'

$envMap = Get-AgentBridgeEnv -Cwd $Cwd -Url $Url -Session $Session -AudioPort $AudioPort -Python $Python -ResumeSession $ResumeSession
foreach ($k in $envMap.Keys) {
  Set-Item "Env:\$k" $envMap[$k]
}
if ($ResumeSession -eq "") {
  Remove-Item Env:\AGENTBRIDGE_RESUME_SESSION -ErrorAction SilentlyContinue
}

$resumeLabel = "(latest in cwd)"
if ($ResumeSession -ne "") { $resumeLabel = $ResumeSession }
Write-Host "[session] cwd=$Cwd url=$Url session=$Session audioPort=$AudioPort python=$Python resume=$resumeLabel"

Set-Location $adapterDir
node dist/session.js
