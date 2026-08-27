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
    $message = "$FilePath 退出码为 $exit"
    if ($IgnoreFailure) { Write-Warning $message } else { throw $message }
  }
}

if (-not (Test-Path -LiteralPath $RegistryPath)) {
  throw "未找到 plugin registry: $RegistryPath"
}

$registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
$plugins = @($registry.plugins) | Where-Object { $null -ne $_ -and $_.enabled -ne $false }

foreach ($plugin in $plugins) {
  $type = if ($plugin.type) { [string]$plugin.type } else { 'codex-marketplace-repo' }
  Write-Host "`n== Plugin: $($plugin.name) [$type] =="

  switch ($type) {
    'codex-marketplace-repo' {
      if (-not $plugin.repo) { throw "Plugin $($plugin.name) 缺少 repo" }
      $args = @('plugin', 'marketplace', 'add', [string]$plugin.repo)
      if ($plugin.ref) { $args += @('--ref', [string]$plugin.ref) }
      # marketplace 已存在时这里可能失败；继续执行，以便后续 install 仍可验证/使用它。
      Invoke-Native -FilePath 'codex' -Arguments $args -IgnoreFailure
    }

    'standalone-plugin-repo' {
      if (-not $plugin.repo) { throw "Plugin $($plugin.name) 缺少 repo" }
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
      Write-Warning "Standalone plugin '$($plugin.name)' 已下载到 $sourceDir。安装前请把它加入 ~/.agents/plugins/marketplace.json，或生成个人 marketplace。"
    }

    default {
      throw "Plugin $($plugin.name) 使用了不支持的 type: '$type'"
    }
  }

  if (-not $NoInstall) {
    $selector = if ($plugin.installSelector) { [string]$plugin.installSelector } elseif ($plugin.marketplaceName) { "$($plugin.name)@$($plugin.marketplaceName)" } else { [string]$plugin.name }
    Invoke-Native -FilePath 'codex' -Arguments @('plugin', 'add', $selector)
  } else {
    Write-Host '已指定 -NoInstall，跳过 plugin install。'
  }
}

Write-Host "`nPlugin 安装流程完成。"

