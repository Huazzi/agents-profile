#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_PLUGINS=0
SKIP_MCP=0
SKIP_MCP_SETUP=0
NO_INSTALL_PLUGINS=0
NO_REGISTER_MCP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-home) AGENTS_HOME="$(cd "$2" && pwd)"; shift 2 ;;
    --skip-plugins) SKIP_PLUGINS=1; shift ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --skip-mcp-setup) SKIP_MCP_SETUP=1; shift ;;
    --no-install-plugins) NO_INSTALL_PLUGINS=1; shift ;;
    --no-register-mcp) NO_REGISTER_MCP=1; shift ;;
    -h|--help)
      cat <<'HELP'
用法: bootstrap.sh [options]

选项:
  --agents-home DIR       agents profile 目录；默认是本脚本目录的父目录。
  --skip-plugins          不安装/注册 plugins。
  --skip-mcp              不 clone/build/register MCP servers。
  --skip-mcp-setup        不运行 MCP setup commands，例如 npm install/build。
  --no-install-plugins    只准备 plugin marketplaces/sources，不运行 codex plugin add。
  --no-register-mcp       clone/build MCP sources，但不运行 codex mcp add。
HELP
      exit 0 ;;
    *) echo "未知选项: $1" >&2; exit 2 ;;
  esac
done

export AGENTS_HOME

echo "Agents profile: $AGENTS_HOME"

if [[ "$SKIP_PLUGINS" -eq 0 ]]; then
  args=(--agents-home "$AGENTS_HOME")
  [[ "$NO_INSTALL_PLUGINS" -eq 1 ]] && args+=(--no-install)
  bash "$SCRIPT_DIR/install-plugins.sh" "${args[@]}"
fi

if [[ "$SKIP_MCP" -eq 0 ]]; then
  args=(--agents-home "$AGENTS_HOME")
  [[ "$SKIP_MCP_SETUP" -eq 1 ]] && args+=(--skip-setup)
  [[ "$NO_REGISTER_MCP" -eq 1 ]] && args+=(--no-register)
  bash "$SCRIPT_DIR/install-mcp.sh" "${args[@]}"
fi

echo 'Bootstrap 完成。'
