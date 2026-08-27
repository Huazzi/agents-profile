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
Usage: bootstrap.sh [options]

Options:
  --agents-home DIR       Agents profile directory. Defaults to the parent of this script directory.
  --skip-plugins          Do not install/register plugins.
  --skip-mcp              Do not clone/build/register MCP servers.
  --skip-mcp-setup        Do not run MCP setup commands such as npm install/build.
  --no-install-plugins    Prepare plugin marketplaces/sources but do not run codex plugin add.
  --no-register-mcp       Clone/build MCP sources but do not run codex mcp add.
HELP
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
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

echo 'Bootstrap complete.'
