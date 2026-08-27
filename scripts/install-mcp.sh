#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_SETUP=0
NO_REGISTER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-home) AGENTS_HOME="$(cd "$2" && pwd)"; shift 2 ;;
    --skip-setup) SKIP_SETUP=1; shift ;;
    --no-register) NO_REGISTER=1; shift ;;
    -h|--help)
      echo '用法: install-mcp.sh [--agents-home DIR] [--skip-setup] [--no-register]'
      exit 0 ;;
    *) echo "未知选项: $1" >&2; exit 2 ;;
  esac
done

export AGENTS_HOME SKIP_SETUP NO_REGISTER

node <<'NODE'
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const agentsHome = process.env.AGENTS_HOME;
const skipSetup = process.env.SKIP_SETUP === '1';
const noRegister = process.env.NO_REGISTER === '1';
const registryPath = path.join(agentsHome, 'mcp', 'registry.json');

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

function runShell(command, cwd) {
  console.log(`> [${cwd}] ${command}`);
  const result = cp.spawnSync(command, { stdio: 'inherit', shell: true, cwd });
  if (result.status !== 0) throw new Error(`Setup command 退出码为 ${result.status}: ${command}`);
}

if (!fs.existsSync(registryPath)) throw new Error(`未找到 MCP registry: ${registryPath}`);
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const servers = (registry.servers || []).filter((server) => server && server.enabled !== false);
const preparedSources = new Set();

for (const server of servers) {
  console.log(`\n== MCP server: ${server.name} ==`);

  if (server.repo) {
    const sourceDir = server.sourceDir ? expand(server.sourceDir) : path.join(agentsHome, 'mcp-sources', server.name);
    if (!preparedSources.has(sourceDir)) {
      if (!fs.existsSync(path.join(sourceDir, '.git'))) {
        fs.mkdirSync(path.dirname(sourceDir), { recursive: true });
        run('git', ['clone', String(server.repo), sourceDir]);
      } else {
        run('git', ['-C', sourceDir, 'fetch', '--all', '--prune']);
      }

      if (server.ref) {
        run('git', ['-C', sourceDir, 'checkout', String(server.ref)]);
        run('git', ['-C', sourceDir, 'pull', '--ff-only'], { ignoreFailure: true });
      }

      if (!skipSetup) {
        for (const command of server.setup || []) {
          if (command) runShell(String(command), sourceDir);
        }
      } else {
        console.log('已指定 --skip-setup，跳过 setup commands。');
      }

      preparedSources.add(sourceDir);
    }
  }

  if (noRegister) {
    console.log('已指定 --no-register，跳过 codex mcp registration。');
    continue;
  }

  const type = server.type || 'stdio';
  run('codex', ['mcp', 'remove', String(server.name)], { ignoreFailure: true });

  if (type === 'http') {
    if (!server.url) throw new Error(`HTTP MCP server ${server.name} 缺少 url`);
    const args = ['mcp', 'add', String(server.name), '--url', expand(server.url)];
    if (server.bearerTokenEnvVar) args.push('--bearer-token-env-var', String(server.bearerTokenEnvVar));
    run('codex', args);
    continue;
  }

  if (type !== 'stdio') throw new Error(`MCP server ${server.name} 使用了不支持的 type: '${type}'`);
  if (!server.command) throw new Error(`stdio MCP server ${server.name} 缺少 command`);

  const addArgs = ['mcp', 'add', String(server.name)];
  if (server.env) {
    for (const [key, value] of Object.entries(server.env)) {
      addArgs.push('--env', `${key}=${expand(value)}`);
    }
  }
  addArgs.push('--', expand(server.command));
  for (const rawArg of server.args || []) {
    const arg = expand(rawArg);
    if (arg.startsWith('--env-file=')) {
      const envFile = arg.slice('--env-file='.length);
      if (!fs.existsSync(envFile)) console.warn(`警告: env 文件尚不存在: ${envFile}`);
    }
    addArgs.push(arg);
  }
  run('codex', addArgs);
}

console.log('\nMCP 安装流程完成。');
NODE
