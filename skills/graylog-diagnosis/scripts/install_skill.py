#!/usr/bin/env python3
"""Install graylog-diagnosis into a known agent skill directory or an explicit target."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


SKILL_NAME = "graylog-diagnosis"
KNOWN_AGENTS = ("codex", "claude-code", "workbuddy")
IGNORED_NAMES = {"__pycache__", ".git", "使用说明.md"}


def skill_root() -> Path:
    return Path(__file__).resolve().parent.parent


def user_home() -> Path:
    return Path.home()


def agent_targets() -> dict[str, Path]:
    home = user_home()
    codex_home = Path(os.environ.get("CODEX_HOME", str(home / ".codex"))).expanduser()
    return {
        "codex": codex_home / "skills",
        "claude-code": home / ".claude" / "skills",
        "workbuddy": home / ".workbuddy" / "skills",
    }


def existing_agents(targets: dict[str, Path]) -> list[str]:
    return [agent for agent, target in targets.items() if target.parent.is_dir()]


def copy_ignore(_: str, names: list[str]) -> set[str]:
    return {name for name in names if name in IGNORED_NAMES or name.endswith(".zip")}


def write_workbuddy_metadata(destination: Path) -> None:
    metadata_path = destination / "_skillhub_meta.json"
    if metadata_path.exists():
        return
    metadata = {
        "name": "Graylog 排障检索",
        "installedAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "source": "local",
        "version": json.loads((skill_root() / "manifest.json").read_text(encoding="utf-8"))["version"],
        "description_zh": "按环境检索 Graylog 日志并结合源码定位问题。",
        "description_en": "Search Graylog logs by environment and trace service failures with local source code.",
        "iconSource": "letter:auto",
    }
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def install(agent: str, target_root: Path, force: bool) -> dict[str, str]:
    source = skill_root()
    target_root = target_root.expanduser().resolve()
    destination = target_root / SKILL_NAME
    if destination.exists() and destination.resolve() == source:
        return {"agent": agent, "status": "already-current", "path": str(destination)}
    if destination.exists() and not force:
        return {"agent": agent, "status": "skipped-existing", "path": str(destination)}
    target_root.mkdir(parents=True, exist_ok=True)
    backup = None
    if destination.exists():
        backup = target_root / f"{SKILL_NAME}.backup-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        destination.replace(backup)
    try:
        shutil.copytree(source, destination, ignore=copy_ignore)
        if agent == "workbuddy":
            write_workbuddy_metadata(destination)
    except Exception:
        if destination.exists():
            shutil.rmtree(destination)
        if backup and backup.exists():
            backup.replace(destination)
        raise
    result = {"agent": agent, "status": "installed", "path": str(destination)}
    if backup:
        result["backup"] = str(backup)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", choices=("auto", *KNOWN_AGENTS), default="auto", help="目标 Agent；默认安装到已发现的 Agent")
    parser.add_argument("--target-dir", help="未知 Agent 的 Skill 根目录；安装器会在其下创建 graylog-diagnosis")
    parser.add_argument("--force", action="store_true", help="备份后更新已有 Skill")
    parser.add_argument("--dry-run", action="store_true", help="仅展示自动发现结果，不写入文件")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.target_dir and args.agent != "auto":
        raise ValueError("--target-dir 只能与 --agent auto 一起使用")
    targets = agent_targets()
    if args.target_dir:
        selected = {"custom": Path(args.target_dir)}
    elif args.agent == "auto":
        selected = {agent: targets[agent] for agent in existing_agents(targets)}
        if not selected:
            raise ValueError("未发现已安装的 Codex、Claude Code 或 WorkBuddy；请传入 --target-dir")
    else:
        selected = {args.agent: targets[args.agent]}
    if args.dry_run:
        print(json.dumps({"status": "dry-run", "targets": {name: str(path) for name, path in selected.items()}}, ensure_ascii=False, indent=2))
        return 0
    results = [install(agent, target, args.force) for agent, target in selected.items()]
    print(json.dumps({"status": "completed", "results": results}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
