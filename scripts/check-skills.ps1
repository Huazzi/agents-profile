[CmdletBinding()]
param(
  [string]$AgentsHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [ValidateSet('all', 'github', 'well-known')]
  [string]$SourceType = 'all',
  [string[]]$Skill = @(),
  [switch]$Json,
  [switch]$NoFetch,
  [string[]]$Register = @(),
  [switch]$RegisterMissing,
  [switch]$ForceRegister,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Script = Join-Path $PSScriptRoot 'check-skills.js'
if (-not (Test-Path -LiteralPath $Script)) {
  throw "Missing checker implementation: $Script"
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  throw 'Node.js is required for check-skills.ps1. Install Node.js 20+ and make sure node is on PATH.'
}

$ArgsList = @($Script, '--agents-home', $AgentsHome, '--source-type', $SourceType)
foreach ($Name in $Skill) {
  if ($Name) { $ArgsList += @('--skill', $Name) }
}
foreach ($Spec in $Register) {
  if ($Spec) { $ArgsList += @('--register', $Spec) }
}
if ($Json) { $ArgsList += '--json' }
if ($NoFetch) { $ArgsList += '--no-fetch' }
if ($RegisterMissing) { $ArgsList += '--register-missing' }
if ($ForceRegister) { $ArgsList += '--force-register' }
if ($Help) { $ArgsList += '--help' }

& node @ArgsList
exit $LASTEXITCODE
