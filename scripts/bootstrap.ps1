[CmdletBinding()]
param(
  [string]$AgentsHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$SkipPlugins,
  [switch]$SkipMcp,
  [switch]$SkipMcpSetup,
  [switch]$NoInstallPlugins,
  [switch]$NoRegisterMcp
)

$ErrorActionPreference = 'Stop'
$AgentsHome = (Resolve-Path -LiteralPath $AgentsHome).Path
$env:AGENTS_HOME = $AgentsHome

Write-Host "Agents profile: $AgentsHome"

if (-not $SkipPlugins) {
  & (Join-Path $PSScriptRoot 'install-plugins.ps1') -AgentsHome $AgentsHome -NoInstall:$NoInstallPlugins
}

if (-not $SkipMcp) {
  & (Join-Path $PSScriptRoot 'install-mcp.ps1') -AgentsHome $AgentsHome -SkipSetup:$SkipMcpSetup -NoRegister:$NoRegisterMcp
}

Write-Host 'Bootstrap 完成。'
