#!/usr/bin/env python3
"""Manage a PRD handling workspace deterministically."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen


INPUT_DIR = "00-产品输入"
UPLOAD_DIR = "上传文件"
DIALOGUE_DIR = "对话输入"
MANIFEST_FILE = "来源清单.md"
ASSESSMENT_DIR = "01-PRD处理评估"
CLARIFICATION_DIR = "02-需求澄清"
DRAFT_DIR = "03-需求文稿"
HISTORY_DIR = "历史版本"
LATEST_ASSESSMENT = "最新评估.md"
LATEST_QUESTIONS = "最新澄清问题包.md"
LATEST_CLARIFICATION = "最新澄清结论.md"
LATEST_DRAFT = "需求工作稿.md"
LATEST_FINAL = "需求文档最终版.md"
DEFAULT_MAX_BYTES = 100 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 30
SOURCE_ID_RE = re.compile(r"^S(\d{3,})-")
DIALOGUE_ROUND_RE = re.compile(r"-R(\d{2,})\.md$", re.IGNORECASE)
ASSESSMENT_ROUND_RE = re.compile(r"^PRD处理评估-R(\d{2,})\.md$")
QUESTIONS_ROUND_RE = re.compile(r"^需求澄清问题包-R(\d{2,})\.md$")
CLARIFICATION_ROUND_RE = re.compile(r"^需求澄清结论-R(\d{2,})\.md$")
DRAFT_ROUND_RE = re.compile(r"^需求工作稿-R(\d{2,})\.md$")
INVALID_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
MANIFEST_HEADER = """# 来源清单

| 记录时间 | 来源编号 | 类型 | 归档位置 | 原始名称 | 原始位置 | SHA-256 | 处理结果 |
|---|---|---|---|---|---|---|---|
"""


class WorkspaceError(RuntimeError):
    """A user-actionable workspace error."""


def json_print(payload: object, *, error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    print(json.dumps(payload, ensure_ascii=False, indent=2), file=stream)


def resolve_workspace(raw_value: str) -> Path:
    raw_path = Path(raw_value).expanduser()
    if not raw_path.is_absolute():
        raise WorkspaceError("--workspace 必须是用户明确指定的绝对路径")
    workspace = raw_path.resolve(strict=False)
    if workspace.parent == workspace:
        raise WorkspaceError("不能把文件系统根目录作为需求工作目录")
    return workspace


def workspace_paths(workspace: Path) -> dict[str, Path]:
    input_root = workspace / INPUT_DIR
    assessment_root = workspace / ASSESSMENT_DIR
    clarification_root = workspace / CLARIFICATION_DIR
    draft_root = workspace / DRAFT_DIR
    return {
        "workspace": workspace,
        "input": input_root,
        "upload": input_root / UPLOAD_DIR,
        "dialogue": input_root / DIALOGUE_DIR,
        "manifest": input_root / MANIFEST_FILE,
        "assessment": assessment_root,
        "assessment_history": assessment_root / HISTORY_DIR,
        "latest_assessment": assessment_root / LATEST_ASSESSMENT,
        "clarification": clarification_root,
        "clarification_history": clarification_root / HISTORY_DIR,
        "latest_questions": clarification_root / LATEST_QUESTIONS,
        "latest_clarification": clarification_root / LATEST_CLARIFICATION,
        "draft": draft_root,
        "draft_history": draft_root / HISTORY_DIR,
        "latest_draft": draft_root / LATEST_DRAFT,
        "latest_final": draft_root / LATEST_FINAL,
    }


def ensure_workspace(workspace: Path) -> dict[str, Path]:
    paths = workspace_paths(workspace)
    for key in (
        "upload",
        "dialogue",
        "assessment_history",
        "clarification_history",
        "draft_history",
    ):
        paths[key].mkdir(parents=True, exist_ok=True)
    if not paths["manifest"].exists():
        paths["manifest"].write_text(MANIFEST_HEADER, encoding="utf-8", newline="\n")
    elif not paths["manifest"].is_file():
        raise WorkspaceError(f"来源清单路径不是文件: {paths['manifest']}")
    return paths


@contextmanager
def workspace_lock(workspace: Path) -> Iterator[None]:
    lock_path = workspace / ".requirement-assessment.lock"
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        raise WorkspaceError(
            f"PRD 工作区正在被其他操作使用；确认没有任务运行后再处理锁文件: {lock_path}"
        ) from exc
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(f"pid={os.getpid()}\ntime={datetime.now().astimezone().isoformat()}\n")
        yield
    finally:
        lock_path.unlink(missing_ok=True)


def sanitize_name(raw_name: str, fallback: str = "未命名") -> str:
    name = INVALID_NAME_RE.sub("_", raw_name).strip().rstrip(". ")
    if not name:
        name = fallback
    path = Path(name)
    stem = path.stem[:150].rstrip(". ") or fallback
    suffix = path.suffix[:30]
    if stem.upper() in WINDOWS_RESERVED_NAMES:
        stem = f"_{stem}"
    return f"{stem}{suffix}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_no_symlinks(path: Path) -> None:
    if path.is_symlink():
        raise WorkspaceError(f"拒绝归档符号链接，请提供真实副本: {path}")
    if path.is_dir():
        for child in path.rglob("*"):
            if child.is_symlink():
                raise WorkspaceError(f"目录包含符号链接，请提供不含符号链接的副本: {child}")


def fingerprint_path(path: Path) -> str:
    ensure_no_symlinks(path)
    if path.is_file():
        return sha256_file(path)
    if not path.is_dir():
        raise WorkspaceError(f"来源既不是普通文件也不是目录: {path}")

    digest = hashlib.sha256()
    digest.update(b"directory\0")
    children = sorted(path.rglob("*"), key=lambda item: item.relative_to(path).as_posix())
    for child in children:
        relative = child.relative_to(path).as_posix().encode("utf-8")
        if child.is_dir():
            digest.update(b"D\0" + relative + b"\0")
        elif child.is_file():
            digest.update(b"F\0" + relative + b"\0")
            digest.update(str(child.stat().st_size).encode("ascii") + b"\0")
            digest.update(bytes.fromhex(sha256_file(child)))
        else:
            raise WorkspaceError(f"目录包含不支持的文件类型: {child}")
    return digest.hexdigest()


def is_relative_to(path: Path, possible_parent: Path) -> bool:
    try:
        path.relative_to(possible_parent)
        return True
    except ValueError:
        return False


def next_source_id(paths: dict[str, Path]) -> str:
    highest = 0
    for root_key in ("upload", "dialogue"):
        for child in paths[root_key].iterdir():
            match = SOURCE_ID_RE.match(child.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return f"S{highest + 1:03d}"


def next_dialogue_round(paths: dict[str, Path]) -> str:
    highest = 0
    for child in paths["dialogue"].iterdir():
        match = DIALOGUE_ROUND_RE.search(child.name)
        if match:
            highest = max(highest, int(match.group(1)))
    return f"R{highest + 1:02d}"


def next_round(paths: dict[str, Path], history_key: str, pattern: re.Pattern[str]) -> str:
    highest = 0
    for child in paths[history_key].iterdir():
        match = pattern.match(child.name)
        if match:
            highest = max(highest, int(match.group(1)))
    return f"R{highest + 1:02d}"


def markdown_cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ")


def append_manifest(
    paths: dict[str, Path],
    *,
    source_id: str,
    kind: str,
    archived_path: Path,
    original_name: str,
    original_location: str,
    fingerprint: str,
    result: str,
) -> None:
    try:
        relative_archive = archived_path.relative_to(paths["workspace"]).as_posix()
    except ValueError:
        relative_archive = str(archived_path)
    values = (
        datetime.now().astimezone().isoformat(timespec="seconds"),
        source_id,
        kind,
        relative_archive,
        original_name,
        original_location,
        fingerprint,
        result,
    )
    row = "| " + " | ".join(markdown_cell(value) for value in values) + " |\n"
    with paths["manifest"].open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(row)


def existing_upload_fingerprints(paths: dict[str, Path]) -> dict[str, tuple[str, Path]]:
    fingerprints: dict[str, tuple[str, Path]] = {}
    for child in sorted(paths["upload"].iterdir(), key=lambda item: item.name):
        match = SOURCE_ID_RE.match(child.name)
        if not match:
            continue
        fingerprints.setdefault(fingerprint_path(child), (f"S{int(match.group(1)):03d}", child))
    return fingerprints


def content_disposition_filename(headers: object) -> str | None:
    getter = getattr(headers, "get_filename", None)
    if callable(getter):
        filename = getter()
        if filename:
            return str(filename)
    return None


def download_url(
    url: str, temp_root: Path, *, max_bytes: int, timeout: int
) -> tuple[Path, dict[str, str]]:
    parsed = urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise WorkspaceError(f"只支持 HTTP/HTTPS URL: {url}")
    if parsed.username or parsed.password:
        raise WorkspaceError("URL 不得包含明文用户名或密码")

    request = Request(url, headers={"User-Agent": "Codex-PRD-Handler/1.0"})
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - user-authorized URL
        final_url = response.geturl()
        if urlsplit(final_url).scheme.lower() not in {"http", "https"}:
            raise WorkspaceError(f"重定向后的协议不受支持: {final_url}")
        length_header = response.headers.get("Content-Length")
        if length_header:
            try:
                declared_length = int(length_header)
            except ValueError:
                declared_length = 0
            if declared_length > max_bytes:
                raise WorkspaceError(
                    f"URL 内容声明大小 {declared_length} 字节，超过上限 {max_bytes} 字节"
                )

        content_type = response.headers.get_content_type() or "application/octet-stream"
        raw_name = content_disposition_filename(response.headers)
        if not raw_name:
            raw_name = unquote(Path(urlsplit(final_url).path).name)
        raw_name = raw_name or "下载内容"
        safe_name = sanitize_name(raw_name, "下载内容")
        if not Path(safe_name).suffix:
            guessed_suffix = mimetypes.guess_extension(content_type) or ""
            safe_name = sanitize_name(f"{safe_name}{guessed_suffix}", "下载内容")

        output_path = temp_root / safe_name
        received = 0
        with output_path.open("wb") as handle:
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > max_bytes:
                    raise WorkspaceError(f"URL 下载超过 {max_bytes} 字节上限")
                handle.write(chunk)

    return output_path, {
        "original_url": url,
        "final_url": final_url,
        "content_type": content_type,
        "bytes": str(received),
    }


def archive_source(
    paths: dict[str, Path], source_value: str, *, max_bytes: int, timeout: int
) -> dict[str, str]:
    is_url = urlsplit(source_value).scheme.lower() in {"http", "https"}
    with tempfile.TemporaryDirectory(prefix=".requirement-ingest-", dir=paths["workspace"]) as temp_name:
        temp_root = Path(temp_name)
        url_metadata: dict[str, str] = {}
        if is_url:
            source_path, url_metadata = download_url(
                source_value, temp_root, max_bytes=max_bytes, timeout=timeout
            )
            kind = "URL"
            original_location = source_value
            original_name = source_path.name
        else:
            source_path = Path(source_value).expanduser().resolve(strict=True)
            if source_path.is_dir() and is_relative_to(paths["workspace"], source_path):
                raise WorkspaceError(f"待归档目录包含需求工作目录，拒绝递归复制: {source_path}")
            ensure_no_symlinks(source_path)
            kind = "本地目录" if source_path.is_dir() else "本地文件"
            original_location = str(source_path)
            original_name = source_path.name

        fingerprint = fingerprint_path(source_path)
        duplicates = existing_upload_fingerprints(paths)
        if fingerprint in duplicates:
            source_id, archived_path = duplicates[fingerprint]
            details = "重复内容，未复制"
            if url_metadata:
                details += (
                    f"；最终URL={url_metadata['final_url']}；"
                    f"内容类型={url_metadata['content_type']}"
                )
            append_manifest(
                paths,
                source_id=source_id,
                kind=kind,
                archived_path=archived_path,
                original_name=original_name,
                original_location=original_location,
                fingerprint=fingerprint,
                result=details,
            )
            return {
                "source": source_value,
                "status": "duplicate",
                "source_id": source_id,
                "archived_path": str(archived_path),
                "sha256": fingerprint,
            }

        source_id = next_source_id(paths)
        safe_name = sanitize_name(original_name)
        archived_path = paths["upload"] / f"{source_id}-{safe_name}"
        if archived_path.exists():
            raise WorkspaceError(f"目标已存在，拒绝覆盖: {archived_path}")

        staged_path = temp_root / f"staged-{safe_name}"
        if source_path.is_dir():
            shutil.copytree(source_path, staged_path, copy_function=shutil.copy2)
        else:
            shutil.copy2(source_path, staged_path)
        staged_fingerprint = fingerprint_path(staged_path)
        if staged_fingerprint != fingerprint:
            raise WorkspaceError(f"复制后哈希不一致，未发布归档: {source_value}")
        staged_path.replace(archived_path)

        details = "已归档"
        if url_metadata:
            details += (
                f"；最终URL={url_metadata['final_url']}；"
                f"内容类型={url_metadata['content_type']}；字节数={url_metadata['bytes']}"
            )
        append_manifest(
            paths,
            source_id=source_id,
            kind=kind,
            archived_path=archived_path,
            original_name=original_name,
            original_location=original_location,
            fingerprint=fingerprint,
            result=details,
        )
        return {
            "source": source_value,
            "status": "archived",
            "source_id": source_id,
            "archived_path": str(archived_path),
            "sha256": fingerprint,
        }


def command_init(workspace: Path) -> dict[str, object]:
    paths = ensure_workspace(workspace)
    return {
        "status": "initialized",
        "workspace": str(workspace),
        "created_or_verified": [
            str(paths["upload"]),
            str(paths["dialogue"]),
            str(paths["manifest"]),
            str(paths["assessment_history"]),
            str(paths["clarification_history"]),
            str(paths["draft_history"]),
        ],
    }


def command_ingest(
    workspace: Path, sources: list[str], *, max_bytes: int, timeout: int
) -> dict[str, object]:
    if max_bytes <= 0:
        raise WorkspaceError("--max-bytes 必须大于 0")
    if timeout <= 0:
        raise WorkspaceError("--timeout 必须大于 0")
    paths = ensure_workspace(workspace)
    results: list[dict[str, str]] = []
    with workspace_lock(workspace):
        for source in sources:
            try:
                results.append(
                    archive_source(paths, source, max_bytes=max_bytes, timeout=timeout)
                )
            except (OSError, HTTPError, URLError, WorkspaceError) as exc:
                results.append({"source": source, "status": "failed", "error": str(exc)})
    return {
        "status": "completed_with_errors"
        if any(result["status"] == "failed" for result in results)
        else "completed",
        "workspace": str(workspace),
        "results": results,
    }


def require_regular_input_file(raw_value: str) -> Path:
    input_path = Path(raw_value).expanduser().resolve(strict=True)
    ensure_no_symlinks(input_path)
    if not input_path.is_file():
        raise WorkspaceError(f"输入必须是普通文件: {input_path}")
    return input_path


def command_record_dialogue(workspace: Path, input_value: str, title: str) -> dict[str, object]:
    paths = ensure_workspace(workspace)
    input_path = require_regular_input_file(input_value)
    if input_path.stat().st_size == 0:
        raise WorkspaceError("澄清结论文件不能为空")
    with workspace_lock(workspace):
        source_id = next_source_id(paths)
        round_id = next_dialogue_round(paths)
        safe_title = sanitize_name(title, "对话输入")
        if Path(safe_title).suffix.lower() == ".md":
            safe_title = Path(safe_title).stem
        destination = paths["dialogue"] / f"{source_id}-{safe_title}-{round_id}.md"
        data = input_path.read_bytes()
        destination.write_bytes(data)
        fingerprint = sha256_file(destination)
        append_manifest(
            paths,
            source_id=source_id,
            kind="对话输入",
            archived_path=destination,
            original_name=input_path.name,
            original_location=str(input_path),
            fingerprint=fingerprint,
            result=f"已归档；澄清轮次 {round_id}",
        )
    return {
        "status": "archived",
        "workspace": str(workspace),
        "source_id": source_id,
        "round": round_id,
        "archived_path": str(destination),
        "sha256": fingerprint,
    }


def atomic_write(path: Path, data: bytes) -> None:
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def publish_versioned_document(
    workspace: Path,
    input_value: str,
    *,
    history_key: str,
    latest_key: str,
    filename_prefix: str,
    round_pattern: re.Pattern[str],
    empty_error: str,
) -> dict[str, object]:
    paths = ensure_workspace(workspace)
    input_path = require_regular_input_file(input_value)
    data = input_path.read_bytes()
    if not data.strip():
        raise WorkspaceError(empty_error)
    with workspace_lock(workspace):
        round_id = next_round(paths, history_key, round_pattern)
        history_path = paths[history_key] / f"{filename_prefix}-{round_id}.md"
        if history_path.exists():
            raise WorkspaceError(f"历史版本已存在，拒绝覆盖: {history_path}")
        atomic_write(history_path, data)
        atomic_write(paths[latest_key], data)
    return {
        "status": "published",
        "workspace": str(workspace),
        "round": round_id,
        "history_path": str(history_path),
        "latest_path": str(paths[latest_key]),
        "sha256": sha256_file(history_path),
    }


def command_publish_assessment(workspace: Path, input_value: str) -> dict[str, object]:
    return publish_versioned_document(
        workspace,
        input_value,
        history_key="assessment_history",
        latest_key="latest_assessment",
        filename_prefix="PRD处理评估",
        round_pattern=ASSESSMENT_ROUND_RE,
        empty_error="PRD处理评估不能为空",
    )


def command_publish_questions(workspace: Path, input_value: str) -> dict[str, object]:
    return publish_versioned_document(
        workspace,
        input_value,
        history_key="clarification_history",
        latest_key="latest_questions",
        filename_prefix="需求澄清问题包",
        round_pattern=QUESTIONS_ROUND_RE,
        empty_error="需求澄清问题包不能为空",
    )


def command_record_clarification(workspace: Path, input_value: str) -> dict[str, object]:
    return publish_versioned_document(
        workspace,
        input_value,
        history_key="clarification_history",
        latest_key="latest_clarification",
        filename_prefix="需求澄清结论",
        round_pattern=CLARIFICATION_ROUND_RE,
        empty_error="需求澄清结论不能为空",
    )


def command_publish_draft(workspace: Path, input_value: str) -> dict[str, object]:
    return publish_versioned_document(
        workspace,
        input_value,
        history_key="draft_history",
        latest_key="latest_draft",
        filename_prefix="需求工作稿",
        round_pattern=DRAFT_ROUND_RE,
        empty_error="需求工作稿不能为空",
    )


def command_finalize(workspace: Path, input_value: str) -> dict[str, object]:
    paths = ensure_workspace(workspace)
    input_path = require_regular_input_file(input_value)
    data = input_path.read_bytes()
    if not data.strip():
        raise WorkspaceError("需求文档最终版不能为空")
    with workspace_lock(workspace):
        atomic_write(paths["latest_final"], data)
    return {
        "status": "published",
        "workspace": str(workspace),
        "latest_path": str(paths["latest_final"]),
        "sha256": sha256_file(paths["latest_final"]),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="管理 PRD 处理工作区中的输入、评估、澄清、需求文稿和最终版需求文档"
    )
    parser.add_argument("--workspace", required=True, help="用户明确指定的 PRD 工作目录绝对路径")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("init", help="创建或确认标准工作区结构")

    ingest = commands.add_parser("ingest", help="归档本地文件、目录或 HTTP/HTTPS URL")
    ingest.add_argument("--source", action="append", required=True, help="可重复传入多个来源")
    ingest.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    ingest.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)

    dialogue = commands.add_parser("record-dialogue", help="归档一轮普通对话输入到 00-产品输入/对话输入")
    dialogue.add_argument("--input", required=True, help="待归档的 Markdown 文件")
    dialogue.add_argument("--title", default="对话输入")

    assessment = commands.add_parser("publish-assessment", help="发布 PRD 处理评估并更新最新评估")
    assessment.add_argument("--input", required=True, help="待发布的 Markdown 评估")

    questions = commands.add_parser("publish-questions", help="发布需求澄清问题包并更新最新问题包")
    questions.add_argument("--input", required=True, help="待发布的 Markdown 问题包")

    clarification = commands.add_parser("record-clarification", help="发布需求澄清结论并更新最新澄清结论")
    clarification.add_argument("--input", required=True, help="待发布的 Markdown 澄清结论")

    draft = commands.add_parser("publish-draft", help="发布需求工作稿到 03-需求文稿 并更新最新工作稿")
    draft.add_argument("--input", required=True, help="待发布的 Markdown 需求工作稿")

    final = commands.add_parser("finalize", help="发布需求文档最终版到 03-需求文稿；不生成历史版本")
    final.add_argument("--input", required=True, help="待发布的 Markdown 需求文档最终版")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        workspace = resolve_workspace(args.workspace)
        if args.command == "init":
            payload = command_init(workspace)
        elif args.command == "ingest":
            payload = command_ingest(
                workspace,
                args.source,
                max_bytes=args.max_bytes,
                timeout=args.timeout,
            )
        elif args.command == "record-dialogue":
            payload = command_record_dialogue(workspace, args.input, args.title)
        elif args.command == "publish-assessment":
            payload = command_publish_assessment(workspace, args.input)
        elif args.command == "publish-questions":
            payload = command_publish_questions(workspace, args.input)
        elif args.command == "record-clarification":
            payload = command_record_clarification(workspace, args.input)
        elif args.command == "publish-draft":
            payload = command_publish_draft(workspace, args.input)
        elif args.command == "finalize":
            payload = command_finalize(workspace, args.input)
        else:  # pragma: no cover - argparse enforces this
            parser.error(f"未知命令: {args.command}")
        json_print(payload)
        return 0 if payload.get("status") != "completed_with_errors" else 2
    except (OSError, HTTPError, URLError, WorkspaceError, ValueError) as exc:
        json_print({"status": "failed", "error": str(exc)}, error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
