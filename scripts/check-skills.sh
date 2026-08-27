#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_TYPE="all"
JSON=0
NO_FETCH=0
REGISTER_MISSING=0
FORCE_REGISTER=0
SKILLS=()
REGISTERS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-home) AGENTS_HOME="$(cd "$2" && pwd)"; shift 2 ;;
    --source-type) SOURCE_TYPE="$2"; shift 2 ;;
    --skill) SKILLS+=("$2"); shift 2 ;;
    --register) REGISTERS+=("$2"); shift 2 ;;
    --register-missing) REGISTER_MISSING=1; shift ;;
    --force-register) FORCE_REGISTER=1; shift ;;
    --json) JSON=1; shift ;;
    --no-fetch) NO_FETCH=1; shift ;;
    -h|--help)
      node "$SCRIPT_DIR/check-skills.js" --help
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required for check-skills.sh. Install Node.js 20+ and make sure node is on PATH.' >&2
  exit 1
fi

ARGS=("$SCRIPT_DIR/check-skills.js" --agents-home "$AGENTS_HOME" --source-type "$SOURCE_TYPE")
for skill in "${SKILLS[@]}"; do
  ARGS+=(--skill "$skill")
done
for spec in "${REGISTERS[@]}"; do
  ARGS+=(--register "$spec")
done
if [[ "$JSON" == "1" ]]; then ARGS+=(--json); fi
if [[ "$NO_FETCH" == "1" ]]; then ARGS+=(--no-fetch); fi
if [[ "$REGISTER_MISSING" == "1" ]]; then ARGS+=(--register-missing); fi
if [[ "$FORCE_REGISTER" == "1" ]]; then ARGS+=(--force-register); fi

node "${ARGS[@]}"
