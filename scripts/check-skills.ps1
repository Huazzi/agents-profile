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
  throw "缺少 checker 实现文件: $Script"
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  throw 'check-skills.ps1 需要 Node.js。请安装 Node.js 20+，并确认 node 已在 PATH 中。'
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
