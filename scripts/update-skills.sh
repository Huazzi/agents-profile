#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_TYPE="all"
ALL=0
DRY_RUN=0
NO_FETCH=0
JSON=0
SKILLS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents-home) AGENTS_HOME="$(cd "$2" && pwd)"; shift 2 ;;
    --skill) SKILLS+=("$2"); shift 2 ;;
    --all) ALL=1; shift ;;
    --source-type) SOURCE_TYPE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-fetch) NO_FETCH=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help)
      node "$SCRIPT_DIR/update-skills.js" --help
      exit 0 ;;
    *) echo "未知选项: $1" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo 'update-skills.sh 需要 Node.js。请安装 Node.js 20+，并确认 node 已在 PATH 中。' >&2
  exit 1
fi

ARGS=("$SCRIPT_DIR/update-skills.js" --agents-home "$AGENTS_HOME" --source-type "$SOURCE_TYPE")
if ((${#SKILLS[@]})); then
  for skill in "${SKILLS[@]}"; do
    ARGS+=(--skill "$skill")
  done
fi
if [[ "$ALL" == "1" ]]; then ARGS+=(--all); fi
if [[ "$DRY_RUN" == "1" ]]; then ARGS+=(--dry-run); fi
if [[ "$NO_FETCH" == "1" ]]; then ARGS+=(--no-fetch); fi
if [[ "$JSON" == "1" ]]; then ARGS+=(--json); fi

node "${ARGS[@]}"
