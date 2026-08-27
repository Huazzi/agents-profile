#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
NO_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-home) AGENTS_HOME="$(cd "$2" && pwd)"; shift 2 ;;
    --no-install) NO_INSTALL=1; shift ;;
    -h|--help)
      echo '用法: install-plugins.sh [--agents-home DIR] [--no-install]'
      exit 0 ;;
    *) echo "未知选项: $1" >&2; exit 2 ;;
  esac
done

export AGENTS_HOME NO_INSTALL

node <<'NODE'
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const agentsHome = process.env.AGENTS_HOME;
const noInstall = process.env.NO_INSTALL === '1';
const registryPath = path.join(agentsHome, 'plugins', 'registry.json');

function expand(value) {
  if (value == null) return value;
  const home = os.homedir();
  return String(value)
    .replaceAll('${AGENTS_HOME}', agentsHome)
    .replaceAll('${HOME}', home)
    .replaceAll('${USERPROFILE}', home);
}

function run(file, args, options = {}) {
  console.log(`> ${file} ${args.join(' ')}`);
  const result = cp.spawnSync(file, args, { stdio: 'inherit', shell: false, cwd: options.cwd || process.cwd() });
  if (result.status !== 0) {
    const message = `${file} 退出码为 ${result.status}`;
    if (options.ignoreFailure) console.warn(`警告: ${message}`);
    else throw new Error(message);
  }
}

if (!fs.existsSync(registryPath)) throw new Error(`未找到 plugin registry: ${registryPath}`);
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const plugins = (registry.plugins || []).filter((plugin) => plugin && plugin.enabled !== false);

for (const plugin of plugins) {
  const type = plugin.type || 'codex-marketplace-repo';
  console.log(`\n== Plugin: ${plugin.name} [${type}] ==`);

  if (type === 'codex-marketplace-repo') {
    if (!plugin.repo) throw new Error(`Plugin ${plugin.name} 缺少 repo`);
    const args = ['plugin', 'marketplace', 'add', String(plugin.repo)];
    if (plugin.ref) args.push('--ref', String(plugin.ref));
    run('codex', args, { ignoreFailure: true });
  } else if (type === 'standalone-plugin-repo') {
    if (!plugin.repo) throw new Error(`Plugin ${plugin.name} 缺少 repo`);
    const sourceDir = plugin.sourceDir ? expand(plugin.sourceDir) : path.join(agentsHome, 'plugin-sources', plugin.name);
    if (!fs.existsSync(path.join(sourceDir, '.git'))) {
      fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
      run('git', ['clone', String(plugin.repo), sourceDir]);
    } else {
      run('git', ['-C', sourceDir, 'fetch', '--all', '--prune']);
    }
    if (plugin.ref) {
      run('git', ['-C', sourceDir, 'checkout', String(plugin.ref)]);
      run('git', ['-C', sourceDir, 'pull', '--ff-only'], { ignoreFailure: true });
    }
    console.warn(`警告: Standalone plugin '${plugin.name}' 已下载到 ${sourceDir}。安装前请把它加入 ~/.agents/plugins/marketplace.json，或生成个人 marketplace。`);
  } else {
    throw new Error(`Plugin ${plugin.name} 使用了不支持的 type: '${type}'`);
  }

  if (!noInstall) {
    const selector = plugin.installSelector || (plugin.marketplaceName ? `${plugin.name}@${plugin.marketplaceName}` : plugin.name);
    run('codex', ['plugin', 'add', String(selector)]);
  } else {
    console.log('已指定 --no-install，跳过 plugin install。');
  }
}

console.log('\nPlugin 安装流程完成。');
NODE
