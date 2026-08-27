[CmdletBinding()]
param(
  [string]$AgentsHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$SkipSetup,
  [switch]$NoRegister
)

$ErrorActionPreference = 'Stop'
$AgentsHome = (Resolve-Path -LiteralPath $AgentsHome).Path
$env:AGENTS_HOME = $AgentsHome
$RegistryPath = Join-Path $AgentsHome 'mcp\registry.json'

function Expand-AgentValue {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value) { return $null }
  $homePath = [Environment]::GetFolderPath('UserProfile')
  return $Value.Replace('${AGENTS_HOME}', $AgentsHome).Replace('${HOME}', $homePath).Replace('${USERPROFILE}', $homePath)
}

function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$Arguments,
    [switch]$IgnoreFailure
  )
  Write-Host ("> {0} {1}" -f $FilePath, ($Arguments -join ' '))
  & $FilePath @Arguments
  $exit = $LASTEXITCODE
  if ($exit -ne 0) {
    $message = "$FilePath exited with code $exit"
    if ($IgnoreFailure) { Write-Warning $message } else { throw $message }
  }
}

function Invoke-SetupCommand {
  param(
    [Parameter(Mandatory)][string]$Command,
    [Parameter(Mandatory)][string]$WorkingDirectory
  )
  Write-Host ("> [{0}] {1}" -f $WorkingDirectory, $Command)
  Push-Location -LiteralPath $WorkingDirectory
  try {
    & pwsh -NoProfile -ExecutionPolicy Bypass -Command $Command
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { throw "Setup command exited with code ${exit}: $Command" }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $RegistryPath)) {
  throw "MCP registry not found: $RegistryPath"
}

$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$servers = @($registry.servers) | Where-Object { $null -ne $_ -and $_.enabled -ne $false }
$preparedSources = @{}

foreach ($server in $servers) {
  Write-Host "`n== MCP server: $($server.name) =="
  if ($server.repo) {
    $sourceDir = Expand-AgentValue ([string]$server.sourceDir)
    if (-not $sourceDir) { $sourceDir = Join-Path $AgentsHome ("mcp-sources\" + $server.name) }

    if (-not $preparedSources.ContainsKey($sourceDir)) {
      if (-not (Test-Path -LiteralPath (Join-Path $sourceDir '.git'))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sourceDir) | Out-Null
        Invoke-Native -FilePath 'git' -Arguments @('clone', [string]$server.repo, $sourceDir)
      } else {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $sourceDir, 'fetch', '--all', '--prune')
      }

      if ($server.ref) {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $sourceDir, 'checkout', [string]$server.ref)
        Invoke-Native -FilePath 'git' -Arguments @('-C', $sourceDir, 'pull', '--ff-only') -IgnoreFailure
      }

      if (-not $SkipSetup) {
        foreach ($cmd in @($server.setup)) {
          if ($cmd) { Invoke-SetupCommand -Command ([string]$cmd) -WorkingDirectory $sourceDir }
        }
      } else {
        Write-Host 'Skipping setup because -SkipSetup was provided.'
      }

      $preparedSources[$sourceDir] = $true
    }
  }

  if ($NoRegister) {
    Write-Host 'Skipping codex mcp registration because -NoRegister was provided.'
    continue
  }

  $type = if ($server.type) { [string]$server.type } else { 'stdio' }
  Invoke-Native -FilePath 'codex' -Arguments @('mcp', 'remove', [string]$server.name) -IgnoreFailure

  if ($type -eq 'http') {
    if (-not $server.url) { throw "HTTP MCP server $($server.name) is missing url" }
    $args = @('mcp', 'add', [string]$server.name, '--url', (Expand-AgentValue ([string]$server.url)))
    if ($server.bearerTokenEnvVar) { $args += @('--bearer-token-env-var', [string]$server.bearerTokenEnvVar) }
    Invoke-Native -FilePath 'codex' -Arguments $args
    continue
  }

  if ($type -ne 'stdio') { throw "Unsupported MCP server type '$type' for $($server.name)" }
  if (-not $server.command) { throw "stdio MCP server $($server.name) is missing command" }

  $addArgs = @('mcp', 'add', [string]$server.name)
  if ($server.env) {
    foreach ($prop in $server.env.PSObject.Properties) {
      $addArgs += @('--env', ("{0}={1}" -f $prop.Name, (Expand-AgentValue ([string]$prop.Value))))
    }
  }
  $addArgs += '--'
  $addArgs += (Expand-AgentValue ([string]$server.command))
  foreach ($arg in @($server.args)) {
    $expanded = Expand-AgentValue ([string]$arg)
    if ($expanded -like '--env-file=*') {
      $envFile = $expanded.Substring('--env-file='.Length)
      if (-not (Test-Path -LiteralPath $envFile)) {
        Write-Warning "Environment file does not exist yet: $envFile"
      }
    }
    $addArgs += $expanded
  }

  Invoke-Native -FilePath 'codex' -Arguments $addArgs
}

Write-Host "`nMCP installation pass complete."

