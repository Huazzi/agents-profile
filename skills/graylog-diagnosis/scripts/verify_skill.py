#!/usr/bin/env python3
"""Validate the MCP-first Graylog diagnosis skill package without querying Graylog."""

from __future__ import annotations

import json
import sys
from pathlib import Path


REQUIRED_FILES = (
    "SKILL.md",
    "manifest.json",
    "agents/openai.yaml",
    "references/mcp-integration.md",
)
REQUIRED_SKILL_TERMS = (
    "graylog43-query-mcp",
    "get_system_info",
    "list_allowed_streams",
    "search_stream",
    "search_stream_absolute",
    "不得使用旧脚本",
)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    missing = [item for item in REQUIRED_FILES if not (root / item).is_file()]
    skill = (root / "SKILL.md").read_text(encoding="utf-8") if not missing else ""
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8")) if not missing else {}
    missing_terms = [term for term in REQUIRED_SKILL_TERMS if term not in skill]
    valid_manifest = (
        manifest.get("runtime") == "mcp"
        and manifest.get("query_mcp") == "graylog43-query-mcp"
        and manifest.get("read_only") is True
    )
    result = {
        "valid": not missing and not missing_terms and valid_manifest,
        "missingFiles": missing,
        "missingSkillTerms": missing_terms,
        "manifest": manifest,
        "pythonVersion": ".".join(map(str, sys.version_info[:3])),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
