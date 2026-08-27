[CmdletBinding()]
param(
  [string]$AgentsHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string[]]$Skill = @(),
  [switch]$All,
  [ValidateSet('all', 'github', 'well-known')]
  [string]$SourceType = 'all',
  [switch]$DryRun,
  [switch]$NoFetch,
  [switch]$Json,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Script = Join-Path $PSScriptRoot 'update-skills.js'
if (-not (Test-Path -LiteralPath $Script)) {
  throw "缺少 updater 实现文件: $Script"
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  throw 'update-skills.ps1 需要 Node.js。请安装 Node.js 20+，并确认 node 已在 PATH 中。'
}

$ArgsList = @($Script, '--agents-home', $AgentsHome, '--source-type', $SourceType)
foreach ($Name in $Skill) {
  if ($Name) { $ArgsList += @('--skill', $Name) }
}
if ($All) { $ArgsList += '--all' }
if ($DryRun) { $ArgsList += '--dry-run' }
if ($NoFetch) { $ArgsList += '--no-fetch' }
if ($Json) { $ArgsList += '--json' }
if ($Help) { $ArgsList += '--help' }

& node @ArgsList
exit $LASTEXITCODE
