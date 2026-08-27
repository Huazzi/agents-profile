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
      echo 'Usage: install-mcp.sh [--agents-home DIR] [--skip-setup] [--no-register]'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
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
    const message = `${file} exited with code ${result.status}`;
    if (options.ignoreFailure) console.warn(`WARNING: ${message}`);
    else throw new Error(message);
  }
}

function runShell(command, cwd) {
  console.log(`> [${cwd}] ${command}`);
  const result = cp.spawnSync(command, { stdio: 'inherit', shell: true, cwd });
  if (result.status !== 0) throw new Error(`Setup command exited with code ${result.status}: ${command}`);
}

if (!fs.existsSync(registryPath)) throw new Error(`MCP registry not found: ${registryPath}`);
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
        console.log('Skipping setup because --skip-setup was provided.');
      }

      preparedSources.add(sourceDir);
    }
  }

  if (noRegister) {
    console.log('Skipping codex mcp registration because --no-register was provided.');
    continue;
  }

  const type = server.type || 'stdio';
  run('codex', ['mcp', 'remove', String(server.name)], { ignoreFailure: true });

  if (type === 'http') {
    if (!server.url) throw new Error(`HTTP MCP server ${server.name} is missing url`);
    const args = ['mcp', 'add', String(server.name), '--url', expand(server.url)];
    if (server.bearerTokenEnvVar) args.push('--bearer-token-env-var', String(server.bearerTokenEnvVar));
    run('codex', args);
    continue;
  }

  if (type !== 'stdio') throw new Error(`Unsupported MCP server type '${type}' for ${server.name}`);
  if (!server.command) throw new Error(`stdio MCP server ${server.name} is missing command`);

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
      if (!fs.existsSync(envFile)) console.warn(`WARNING: Environment file does not exist yet: ${envFile}`);
    }
    addArgs.push(arg);
  }
  run('codex', addArgs);
}

console.log('\nMCP installation pass complete.');
NODE
