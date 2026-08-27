[CmdletBinding()]
param(
  [string]$AgentsHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'
$AgentsHome = (Resolve-Path -LiteralPath $AgentsHome).Path
$env:AGENTS_HOME = $AgentsHome
$RegistryPath = Join-Path (Join-Path $AgentsHome 'plugins') 'registry.json'

function Join-AgentPath {
  param([Parameter(Mandatory)][string[]]$Parts)
  $result = $Parts[0]
  for ($i = 1; $i -lt $Parts.Count; $i++) { $result = Join-Path $result $Parts[$i] }
  return $result
}

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

if (-not (Test-Path -LiteralPath $RegistryPath)) {
  throw "Plugin registry not found: $RegistryPath"
}

$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$plugins = @($registry.plugins) | Where-Object { $null -ne $_ -and $_.enabled -ne $false }

foreach ($plugin in $plugins) {
  $type = if ($plugin.type) { [string]$plugin.type } else { 'codex-marketplace-repo' }
  Write-Host "`n== Plugin: $($plugin.name) [$type] =="

  switch ($type) {
    'codex-marketplace-repo' {
      if (-not $plugin.repo) { throw "Plugin $($plugin.name) is missing repo" }
      $args = @('plugin', 'marketplace', 'add', [string]$plugin.repo)
      if ($plugin.ref) { $args += @('--ref', [string]$plugin.ref) }
      # This may fail when the marketplace already exists; continue so install can still verify/use it.
      Invoke-Native -FilePath 'codex' -Arguments $args -IgnoreFailure
    }

    'standalone-plugin-repo' {
      if (-not $plugin.repo) { throw "Plugin $($plugin.name) is missing repo" }
      $sourceDir = if ($plugin.sourceDir) { Expand-AgentValue ([string]$plugin.sourceDir) } else { Join-AgentPath @($AgentsHome, 'plugin-sources', [string]$plugin.name) }
      if (-not (Test-Path -LiteralPath (Join-Path $sourceDir '.git'))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sourceDir) | Out-Null
        Invoke-Native -FilePath 'git' -Arguments @('clone', [string]$plugin.repo, $sourceDir)
      } else {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $sourceDir, 'fetch', '--all', '--prune')
      }
      if ($plugin.ref) {
        Invoke-Native -FilePath 'git' -Arguments @('-C', $sourceDir, 'checkout', [string]$plugin.ref)
        Invoke-Native -FilePath 'git' -Arguments @('-C', $sourceDir, 'pull', '--ff-only') -IgnoreFailure
      }
      Write-Warning "Standalone plugin '$($plugin.name)' is downloaded to $sourceDir. Add it to ~/.agents/plugins/marketplace.json or generate a personal marketplace before installing."
    }

    default {
      throw "Unsupported plugin type '$type' for $($plugin.name)"
    }
  }

  if (-not $NoInstall) {
    $selector = if ($plugin.installSelector) { [string]$plugin.installSelector } elseif ($plugin.marketplaceName) { "$($plugin.name)@$($plugin.marketplaceName)" } else { [string]$plugin.name }
    Invoke-Native -FilePath 'codex' -Arguments @('plugin', 'add', $selector)
  } else {
    Write-Host 'Skipping plugin install because -NoInstall was provided.'
  }
}

Write-Host "`nPlugin installation pass complete."
