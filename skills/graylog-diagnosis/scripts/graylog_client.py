#!/usr/bin/env python3
"""Graylog Views Search 跨平台客户端，仅依赖 Python 标准库。"""

import argparse
import base64
import difflib
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence


ENVIRONMENT_STREAM_MARKERS = {
    "online": ("【正式】",),
    "gray": ("【灰度】", "灰度"),
    "test": ("【测试】", "【非正式】", "测试", "非正式"),
}
SENSITIVE_JSON_KEY_PATTERN = re.compile(r'(?i)("(?:token|password|secret|apiKey|authorization)"\s*:\s*")[^"]*(")')
SENSITIVE_FIELD_NAME_PATTERN = re.compile(
    r"(?i)^(?:token|password|secret|api[_-]?key|authorization|cookie|set-cookie|session(?:id)?)$"
)
BEARER_PATTERN = re.compile(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+')
BASIC_PATTERN = re.compile(r'(?i)(basic\s+)[A-Za-z0-9+/=]+')
PHONE_PATTERN = re.compile(r'(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)')
IDENTITY_PATTERN = re.compile(r'(?<!\d)(\d{6})\d{8}(\d{3}[0-9Xx])(?!\d)')
STABLE_QUERY_CLAUSE_PATTERN = re.compile(
    r'(?i)\b(?:instanceId|nodeInstanceId|definitionKey|messageId|kafkaMsgId|traceId|reportId|taskId|logger_name|source|app_name|topic)\s*:\s*'
    r'(?P<value>"(?:\\.|[^"])*"|[^\s()]+)'
)
STABLE_MESSAGE_IDENTIFIER_PATTERN = re.compile(
    r'(?i)\b[A-Za-z][A-Za-z0-9_.-]*(?:Id|ID|Key)\s*[:=]\s*[A-Za-z0-9_.:-]+'
)
QUALIFIED_CLASS_PATTERN = re.compile(r'\b(?:[a-z_][A-Za-z0-9_$]*\.){2,}[A-Z][A-Za-z0-9_$]*\b')
MAX_TIME_RANGE_SECONDS = 86400
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_STDOUT_BYTES = 4 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024


class GraylogError(RuntimeError):
    """Graylog 查询或本地配置异常。"""


def bounded_integer(minimum: int, maximum: int):
    """创建不会在帮助文本中展开巨大 choices 列表的整数校验器。"""
    def parse(value: str) -> int:
        try:
            parsed = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError("必须是整数") from exc
        if not minimum <= parsed <= maximum:
            raise argparse.ArgumentTypeError(f"必须在 {minimum} 到 {maximum} 之间")
        return parsed

    return parse


def is_positive_query_position(query: str, position: int) -> bool:
    """排除 NOT、减号和感叹号引导的纯否定条件。"""
    prefix = query[:position]
    boolean_segment = re.split(r"(?i)\b(?:AND|OR)\b", prefix)[-1]
    normalized_segment = re.sub(r"^[\s(]+", "", boolean_segment)
    return not re.match(r"(?i)^(?:NOT\b|[-!])", normalized_segment)


def is_specific_anchor_value(value: str) -> bool:
    """稳定锚点必须包含具体值，不能使用通配符或空字符串。"""
    normalized = value.strip().strip('"').strip()
    return bool(normalized and "*" not in normalized and "?" not in normalized and re.search(r"[0-9A-Za-z\u4e00-\u9fff]", normalized))


def query_has_stable_anchor(query: str) -> bool:
    """判断查询是否包含可关联到代码或业务实例的正向具体条件。"""
    for match in STABLE_QUERY_CLAUSE_PATTERN.finditer(query):
        if is_positive_query_position(query, match.start()) and is_specific_anchor_value(match.group("value")):
            return True
    for pattern in (STABLE_MESSAGE_IDENTIFIER_PATTERN, QUALIFIED_CLASS_PATTERN):
        if any(is_positive_query_position(query, match.start()) for match in pattern.finditer(query)):
            return True
    return False


def parse_iso_datetime(value: str, label: str) -> datetime:
    """解析带时区的 ISO 8601 时间，并统一转换为 UTC。"""
    normalized = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise GraylogError(f"{label} 必须是带时区的 ISO 8601 时间") from exc
    if parsed.tzinfo is None:
        raise GraylogError(f"{label} 必须显式包含时区，例如 +08:00 或 Z")
    return parsed.astimezone(timezone.utc)


def format_graylog_datetime(value: datetime) -> str:
    """生成 Graylog absolute timerange 使用的 UTC 时间。"""
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def resolve_time_range(args: argparse.Namespace) -> Dict[str, Any]:
    """将相对或绝对时间参数冻结为同一个绝对查询窗口。"""
    from_seconds = getattr(args, "from_seconds", None)
    from_time = getattr(args, "from_time", None)
    to_time = getattr(args, "to_time", None)
    if from_seconds is not None and (from_time or to_time):
        raise GraylogError("--from-seconds 不能与 --from-time 或 --to-time 同时使用")
    if from_seconds is not None:
        end = datetime.now(timezone.utc)
        start = end - timedelta(seconds=from_seconds)
        mode = "relative"
    elif from_time and to_time:
        start = parse_iso_datetime(from_time, "--from-time")
        end = parse_iso_datetime(to_time, "--to-time")
        mode = "absolute"
    else:
        raise GraylogError("必须提供 --from-seconds，或同时提供 --from-time 和 --to-time")
    duration = (end - start).total_seconds()
    if duration <= 0:
        raise GraylogError("查询结束时间必须晚于开始时间")
    if duration > MAX_TIME_RANGE_SECONDS:
        raise GraylogError(f"单次查询时间范围不能超过 {MAX_TIME_RANGE_SECONDS} 秒")
    duration_seconds = int(duration)
    return {
        "type": "absolute",
        "from": format_graylog_datetime(start),
        "to": format_graylog_datetime(end),
        "mode": mode,
        "durationSeconds": duration_seconds,
    }


def validate_query_preconditions(query: str, time_range: Dict[str, Any], code_anchors: Sequence[str]) -> None:
    """在访问 Graylog 前阻止缺少源码依据或稳定锚点的宽泛查询。"""
    anchors = [item.strip() for item in code_anchors if item and item.strip()]
    if not time_range:
        raise GraylogError("必须显式提供查询时间窗，不能使用默认范围猜测故障")
    if not anchors:
        raise GraylogError("必须至少提供一个 --code-anchor，说明已从源码确认的类名、日志字面量、Topic 或关联字段")
    if not query_has_stable_anchor(query):
        raise GraylogError(
            "查询缺少稳定锚点；必须包含实例/节点/消息/trace ID、logger_name、source、app_name、topic 或完整类名，"
            "不能仅按中文现象或异常文案搜索"
        )


def legacy_codex_home() -> Path:
    """返回旧版 Codex 配置根目录，仅用于兼容既有数据。"""
    configured = os.environ.get("CODEX_HOME")
    return Path(configured).expanduser() if configured else Path.home() / ".codex"


def default_state_home() -> Path:
    """返回与 Agent 无关的用户级 Graylog 数据目录。"""
    configured = os.environ.get("GRAYLOG_DIAGNOSIS_HOME")
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))) / "graylog-diagnosis"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "graylog-diagnosis"
    xdg_config_home = os.environ.get("XDG_CONFIG_HOME")
    return Path(xdg_config_home).expanduser() / "graylog-diagnosis" if xdg_config_home else Path.home() / ".config" / "graylog-diagnosis"


def legacy_config_path() -> Path:
    """返回旧版 Codex 数据源配置位置。"""
    return legacy_codex_home() / "graylog-diagnosis-sources.json"


def default_config_path() -> Path:
    """返回默认数据源配置位置，并优先复用旧版已存在配置。"""
    modern_path = default_state_home() / "graylog-diagnosis-sources.json"
    if os.environ.get("GRAYLOG_DIAGNOSIS_HOME"):
        return modern_path
    legacy_path = legacy_config_path()
    if not modern_path.exists() and legacy_path.exists():
        return legacy_path
    return modern_path


def token_store_path() -> Path:
    """返回默认用户级 Token 文件位置，用于 Unix 持久化和旧配置兼容。"""
    return default_config_path().parent / "graylog-diagnosis-tokens.json"


def repair_mojibake(value: str) -> str:
    """修复部分 Graylog 部署以 Latin-1 错解 UTF-8 后返回的中文。"""
    if not value or not re.search(r"[åäèç]", value):
        return value
    try:
        return value.encode("latin-1").decode("utf-8")
    except UnicodeError:
        return value


def repair_value(value: Any) -> Any:
    """递归修复 API 返回对象中的文本字段。"""
    if isinstance(value, str):
        return repair_mojibake(value)
    if isinstance(value, list):
        return [repair_value(item) for item in value]
    if isinstance(value, dict):
        return {key: repair_value(item) for key, item in value.items()}
    return value


def redact_text(value: str) -> str:
    """保留完整日志长度，同时隐藏凭据和常见个人标识。"""
    value = SENSITIVE_JSON_KEY_PATTERN.sub(r'\1***\2', value)
    value = BEARER_PATTERN.sub(r'\1***', value)
    value = BASIC_PATTERN.sub(r'\1***', value)
    value = PHONE_PATTERN.sub(r'\1****\2', value)
    return IDENTITY_PATTERN.sub(r'\1********\2', value)


def redact_value(value: Any, field_name: Optional[str] = None) -> Any:
    """递归脱敏结构化响应，避免 raw response 绕过日志正文脱敏。"""
    if field_name and SENSITIVE_FIELD_NAME_PATTERN.fullmatch(field_name):
        return "***"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): redact_value(item, str(key)) for key, item in value.items()}
    return value


def write_private_text(path: Path, content: str, overwrite: bool = False) -> None:
    """原子写入用户私有文本，Unix 从创建临时文件开始即限制为 0600。"""
    if path.exists() and not overwrite:
        raise GraylogError(f"输出文件已存在，拒绝覆盖: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        if os.name == "nt":
            temporary.write_text(content, encoding="utf-8")
        else:
            descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
        temporary.replace(path)
        if os.name != "nt":
            path.chmod(0o600)
    except OSError as exc:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise GraylogError(f"私有文件无法写入: {path}") from exc


def serialize_json(value: Any) -> str:
    """统一生成已经递归脱敏的 JSON。"""
    return json.dumps(redact_value(value), ensure_ascii=False, indent=2, default=str) + "\n"


def print_json(value: Any, output_file: Optional[str] = None) -> None:
    """输出受大小约束的 JSON，超大结果可写入显式指定的私有文件。"""
    content = serialize_json(value)
    byte_size = len(content.encode("utf-8"))
    if output_file:
        path = Path(output_file).expanduser().resolve()
        write_private_text(path, content)
        summary = {"outputFile": str(path), "bytes": byte_size, "redacted": True}
        print(serialize_json(summary), end="")
        return
    if byte_size > MAX_STDOUT_BYTES:
        raise GraylogError(f"脱敏后的输出超过 {MAX_STDOUT_BYTES} 字节，请显式传入 --output-file")
    print(content, end="")


def read_config(path: Path) -> Dict[str, Any]:
    """读取并校验默认连接和业务系统覆盖配置。"""
    if not path.exists():
        raise GraylogError("当前 Graylog 没有任何数据源，请先配置 default 或指定项目的数据源")
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GraylogError(f"Graylog 数据源配置无法读取: {path}") from exc
    if not isinstance(data, dict):
        raise GraylogError("Graylog 数据源配置必须是 JSON 对象")
    return data


def write_config(path: Path, data: Dict[str, Any]) -> None:
    """原子写入数据源配置，避免配置写入中断后留下半截 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def validate_connection(connection: Any, label: str) -> Dict[str, str]:
    """校验单个 Graylog 连接，不允许把不同来源的地址和 Token 拼接使用。"""
    if not isinstance(connection, dict):
        raise GraylogError(f"Graylog 连接配置无效: {label}")
    base_url = str(connection.get("baseUrl") or "").rstrip("/")
    token_env = str(connection.get("tokenEnv") or "")
    if not base_url or not token_env:
        raise GraylogError(f"Graylog 连接配置不完整: {label}")
    return {"baseUrl": base_url, "tokenEnv": token_env}


def normalize_name(value: str) -> str:
    """标准化项目或业务名称，支持大小写、空格和常见分隔符差异。"""
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]", "", value.lower())


def configured_service_names(config: Dict[str, Any]) -> List[str]:
    """返回顶级业务系统名称，忽略默认连接与非对象配置。"""
    return [key for key, value in config.items() if key != "default" and isinstance(value, dict)]


def has_usable_connection(config: Dict[str, Any]) -> bool:
    """判断默认连接或任一业务系统是否具备可执行查询的连接信息。"""
    for value in config.values():
        if not isinstance(value, dict):
            continue
        if str(value.get("baseUrl") or "").strip() and str(value.get("tokenEnv") or "").strip():
            return True
    return False


def configured_aliases(config: Dict[str, Any], service_name: str) -> List[str]:
    """读取业务系统的可选项目别名，兼容简单的仅连接配置。"""
    service = config.get(service_name)
    aliases = service.get("aliases", []) if isinstance(service, dict) else []
    return [str(alias) for alias in aliases if isinstance(alias, str) and alias.strip()]


def configured_display_name(config: Dict[str, Any], service_key: str) -> str:
    """读取业务系统展示名和 Stream 匹配名，未配置时回退稳定键。"""
    service = config.get(service_key)
    if not isinstance(service, dict):
        return service_key
    return str(service.get("name") or service_key)


def project_hints(workdir: Optional[str]) -> List[str]:
    """从当前工作目录和常见项目元数据中提取项目候选名。"""
    directory = Path(workdir or Path.cwd()).resolve()
    hints = [directory.name]
    pom = directory / "pom.xml"
    if pom.is_file():
        try:
            artifact_ids = re.findall(r"<artifactId>\s*([^<\s]+)\s*</artifactId>", pom.read_text(encoding="utf-8", errors="ignore"))
            if artifact_ids:
                hints.append(artifact_ids[0])
        except OSError:
            pass
    package_json = directory / "package.json"
    if package_json.is_file():
        try:
            package_name = json.loads(package_json.read_text(encoding="utf-8")).get("name")
            if isinstance(package_name, str):
                hints.append(package_name)
        except (OSError, json.JSONDecodeError):
            pass
    return list(dict.fromkeys(hint for hint in hints if hint.strip()))


def match_configured_service(config: Dict[str, Any], names: Sequence[str]) -> Optional[str]:
    """按精确、包含和高置信度模糊匹配定位唯一业务系统。"""
    best_scores: Dict[str, float] = {}
    for service_name in configured_service_names(config):
        identities = [service_name, configured_display_name(config, service_name)] + configured_aliases(config, service_name)
        for supplied_name in names:
            supplied = normalize_name(supplied_name)
            if not supplied:
                continue
            for identity in identities:
                normalized_identity = normalize_name(identity)
                if not normalized_identity:
                    continue
                score = difflib.SequenceMatcher(None, supplied, normalized_identity).ratio()
                if supplied == normalized_identity:
                    score = 1.0
                elif min(len(supplied), len(normalized_identity)) >= 3 and (supplied in normalized_identity or normalized_identity in supplied):
                    score = max(score, 0.9)
                if score >= 0.72:
                    best_scores[service_name] = max(score, best_scores.get(service_name, 0.0))
    if not best_scores:
        return None
    maximum = max(best_scores.values())
    winners = sorted(service_name for service_name, score in best_scores.items() if abs(score - maximum) < 1e-9)
    if len(winners) != 1:
        details = [{"service": item, "score": best_scores[item]} for item in winners]
        raise GraylogError(f"业务系统无法唯一识别，请显式指定项目键: candidates={json.dumps(details, ensure_ascii=False)}")
    return winners[0]


def resolve_service(config: Dict[str, Any], requested_service: Optional[str], workdir: Optional[str]) -> Dict[str, Any]:
    """按用户描述或当前项目选择业务系统，未配置时回退默认连接。"""
    if not config or not has_usable_connection(config):
        raise GraylogError("当前 Graylog 没有任何数据源，请先配置 default 或指定项目的数据源")
    hints = [requested_service] if requested_service else project_hints(workdir)
    service_key = match_configured_service(config, hints)
    if not service_key:
        service_key = requested_service or (hints[0] if hints else "")
    if not service_key:
        raise GraylogError("未能识别当前会话项目，请在对话中说明要查询的项目")
    service = config.get(service_key)
    if service is None:
        default = config.get("default")
        if not isinstance(default, dict):
            raise GraylogError("当前 Graylog 没有任何数据源，请先配置 default 或指定项目的数据源")
        connection = validate_connection(default, "default")
        return {"key": service_key, "name": service_key, "connection": connection, "connectionLabel": "默认", "projectHints": hints}
    if not isinstance(service, dict):
        raise GraylogError(f"业务系统连接配置无效: {service_key}")
    has_base_url = bool(str(service.get("baseUrl") or "").strip())
    has_token_env = bool(str(service.get("tokenEnv") or "").strip())
    if has_base_url != has_token_env:
        raise GraylogError(f"业务系统连接必须同时配置 baseUrl 和 tokenEnv: {service_key}")
    if has_base_url:
        connection = validate_connection(service, service_key)
        connection_label = configured_display_name(config, service_key)
    else:
        connection = validate_connection(config.get("default"), "default")
        connection_label = "默认"
    return {"key": service_key, "name": configured_display_name(config, service_key), "connection": connection, "connectionLabel": connection_label, "projectHints": hints}


def get_token(token_env: str) -> str:
    """依次从进程环境、Windows 用户环境和兼容 Token 文件读取凭据。"""
    token = os.environ.get(token_env, "").strip()
    if not token and os.name == "nt":
        # 新写入的用户级变量不会回灌到已启动的桌面应用进程，Windows 下额外读取用户注册表。
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as environment_key:
                token = str(winreg.QueryValueEx(environment_key, token_env)[0]).strip()
        except (FileNotFoundError, OSError):
            token = ""
    if not token:
        try:
            stored = json.loads(token_store_path().read_text(encoding="utf-8"))
            if not isinstance(stored, dict):
                raise GraylogError("Token 存储格式无效，根节点必须是 JSON 对象")
            token = str(stored.get(token_env) or "").strip()
        except (OSError, json.JSONDecodeError) as exc:
            token = ""
    if not token:
        raise GraylogError(f"Graylog Token 环境变量未设置: {token_env}")
    return token


def default_token_env(service_name: str) -> str:
    """为任意语言的项目名生成稳定且合法的 Token 环境变量名。"""
    normalized = re.sub(r"[^A-Z0-9]", "_", service_name.upper()).strip("_")
    if normalized:
        return f"GRAYLOG_TOKEN_{normalized}"
    return f"GRAYLOG_TOKEN_{hashlib.sha256(service_name.encode('utf-8')).hexdigest()[:12].upper()}"


def persist_token(token_env: str, token: str) -> None:
    """Windows 写入用户环境变量，Unix 写入权限为 0600 的用户级 Token 文件。"""
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as environment_key:
                winreg.SetValueEx(environment_key, token_env, 0, winreg.REG_SZ, token)
        except OSError as exc:
            raise GraylogError(f"Windows 用户环境变量写入失败: {token_env}") from exc
        os.environ[token_env] = token
        return
    path = token_store_path()
    stored = {}
    if path.exists():
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise GraylogError(f"Token 存储无法读取: {path}") from exc
        if not isinstance(stored, dict):
            raise GraylogError("Token 存储格式无效，根节点必须是 JSON 对象")
    stored[token_env] = token
    write_private_text(path, json.dumps(stored, ensure_ascii=False, indent=2) + "\n", overwrite=True)
    os.environ[token_env] = token


def request_json(base_url: str, token: str, method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Any:
    """调用 Graylog API，并确保 JSON 请求体按 UTF-8 字节发送。"""
    payload = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    authorization = base64.b64encode(f"{token}:token".encode("ascii")).decode("ascii")
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=payload,
        method=method,
        headers={
            "Authorization": f"Basic {authorization}",
            "X-Requested-By": "codex-graylog-diagnosis",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    if int(content_length) > MAX_RESPONSE_BYTES:
                        raise GraylogError(f"Graylog API 响应超过安全上限 {MAX_RESPONSE_BYTES} 字节")
                except ValueError:
                    pass
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise GraylogError(f"Graylog API 响应超过安全上限 {MAX_RESPONSE_BYTES} 字节")
    except urllib.error.HTTPError as exc:
        detail = exc.read(MAX_ERROR_BYTES).decode("utf-8", errors="replace")
        raise GraylogError(f"Graylog API 请求失败: HTTP {exc.code}, {redact_text(detail)}") from exc
    except urllib.error.URLError as exc:
        raise GraylogError(f"无法连接 Graylog: {exc.reason}") from exc
    try:
        return repair_value(json.loads(raw.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GraylogError("Graylog API 返回了无法解析的 JSON") from exc


def list_streams(base_url: str, token: str) -> List[Dict[str, str]]:
    """读取当前 Token 可访问的 Stream，并只保留选择环境所需字段。"""
    response = request_json(base_url, token, "GET", "/api/streams")
    streams = response.get("streams", []) if isinstance(response, dict) else []
    return [
        {"id": str(item.get("id", "")), "title": str(item.get("title", ""))}
        for item in streams
        if isinstance(item, dict) and item.get("id")
    ]


def select_streams(streams: Sequence[Dict[str, str]], service_name: str, environment: Optional[str]) -> List[Dict[str, str]]:
    """通过业务名在运行时定位对应 Stream，环境仅作为二次选择条件。"""
    selected = [item for item in streams if item["title"] == service_name or item["title"].endswith(service_name)]
    if environment:
        markers = ENVIRONMENT_STREAM_MARKERS.get(environment)
        if markers:
            environment_selected = [item for item in selected if any(marker in item["title"] for marker in markers)]
            if not environment_selected:
                raise GraylogError(f"未找到 {environment} 环境的业务 Stream: service={service_name}")
            selected = environment_selected
    if len(selected) != 1:
        candidates = [{"id": item["id"], "title": item["title"]} for item in selected]
        raise GraylogError(f"业务 Stream 未唯一确定: service={service_name}, candidates={json.dumps(candidates, ensure_ascii=False)}")
    return selected


def build_stream_filter(streams: Sequence[Dict[str, str]]) -> Optional[Dict[str, Any]]:
    """构建 Graylog Views Search 的 Stream 过滤条件。"""
    if not streams:
        return None
    return {"type": "or", "filters": [{"type": "stream", "id": item["id"]} for item in streams]}


def build_search_definition(query: str, time_range: Dict[str, Any], limit: int, offset: int, streams: Sequence[Dict[str, str]]) -> Dict[str, Any]:
    """构造单个 messages Search Type 的最小执行定义。"""
    query_id = str(uuid.uuid4())
    search_type_id = str(uuid.uuid4())
    return {
        "queries": [{
            "id": query_id,
            "timerange": {key: time_range[key] for key in ("type", "from", "to")},
            "filter": build_stream_filter(streams),
            "query": {"type": "elasticsearch", "query_string": query},
            "search_types": [{
                "timerange": None,
                "query": None,
                "streams": [],
                "id": search_type_id,
                "name": None,
                "limit": limit,
                "offset": offset,
                "sort": [{"field": "timestamp", "order": "DESC"}],
                "fields": [],
                "decorators": [],
                "type": "messages",
                "filter": None,
            }],
        }],
        "parameters": [],
    }


def run_search(base_url: str, token: str, query: str, time_range: Dict[str, Any], limit: int, offset: int, streams: Sequence[Dict[str, str]]) -> Dict[str, Any]:
    """创建并执行当前 Graylog 实例支持的临时 Views Search。"""
    definition = build_search_definition(query, time_range, limit, offset, streams)
    query_id = definition["queries"][0]["id"]
    search_type_id = definition["queries"][0]["search_types"][0]["id"]
    created = request_json(base_url, token, "POST", "/api/views/search", definition)
    search_id = str(created.get("id", "")) if isinstance(created, dict) else ""
    if not search_id:
        raise GraylogError("Graylog 未返回可执行的临时 Search ID")
    result = request_json(base_url, token, "POST", f"/api/views/search/{search_id}/execute", {"parameter_bindings": {}})
    try:
        query_result = result["results"][query_id]
        search_result = query_result["search_types"][search_type_id]
    except (KeyError, TypeError) as exc:
        raise GraylogError("Graylog 执行结果缺少 messages Search Type") from exc
    effective_query = str(query_result.get("query", {}).get("query", {}).get("query_string", ""))
    if repair_mojibake(effective_query) != query:
        raise GraylogError("Graylog 未按请求条件执行查询，已拒绝使用该结果")
    return {**search_result, "_graylogSearchId": search_id}


def message_rows(messages: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """返回完整但已脱敏的日志消息，不设置固定字符截断。"""
    rows = []
    for item in messages:
        message = item.get("message", {}) if isinstance(item, dict) else {}
        if not isinstance(message, dict):
            continue
        text = redact_text(str(message.get("message", "")))
        rows.append({
            "timestamp": message.get("timestamp"),
            "source": message.get("source"),
            "level": message.get("level"),
            "loggerName": message.get("logger_name"),
            "message": text,
        })
    return rows


def source_clause(sources: Sequence[str]) -> str:
    """将已确认的节点列表转成 Graylog source 字段过滤条件。"""
    escaped = [source.replace('"', '\\"') for source in sources if source]
    if not escaped:
        raise GraylogError("未获取到可用于环境隔离的日志节点")
    return " OR ".join(f'source:"{source}"' for source in escaped)


def field_clause(field: str, value: str) -> str:
    """构造单个 Graylog 字段精确匹配条件，拒绝不安全字段名。"""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.-]*", field):
        raise GraylogError(f"日志隔离字段名不合法: {field}")
    escaped_value = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{field}:"{escaped_value}"'


def logback_files(workdir: Optional[str], environment: Optional[str]) -> List[Path]:
    """按环境优先级定位项目内的 Logback 配置文件。"""
    resources = Path(workdir or os.getcwd()) / "src" / "main" / "resources"
    if not resources.is_dir():
        return []
    names = [f"logback-{environment}.xml"] if environment else []
    names.append("logback.xml")
    result = [resources / name for name in names if (resources / name).is_file()]
    return result or sorted(resources.glob("logback*.xml"))


def resolve_logback_value(value: str) -> Optional[str]:
    """解析静态字段的字面量或单个环境变量占位符。"""
    normalized = value.strip()
    placeholder = re.fullmatch(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}", normalized)
    if placeholder:
        return os.environ.get(placeholder.group(1), placeholder.group(2))
    return normalized or None


def discover_app_name_isolation(workdir: Optional[str], environment: Optional[str]) -> Dict[str, Any]:
    """从 Logback GELF staticField 识别 app_name 字段及可解析的运行值。"""
    checked_files = []
    for path in logback_files(workdir, environment):
        checked_files.append(str(path))
        try:
            root = ET.parse(path).getroot()
        except (ET.ParseError, OSError):
            continue
        for node in root.iter():
            if node.tag.rsplit("}", 1)[-1] != "staticField" or not node.text or ":" not in node.text:
                continue
            field, raw_value = (part.strip() for part in node.text.split(":", 1))
            if field != "app_name":
                continue
            return {
                "field": field,
                "rawValue": raw_value,
                "value": resolve_logback_value(raw_value),
                "configPath": str(path),
                "checkedFiles": checked_files,
            }
    return {"field": None, "rawValue": None, "value": None, "configPath": None, "checkedFiles": checked_files}


def resolve_app_name_isolation(args: argparse.Namespace) -> Dict[str, Any]:
    """解析显式 app_name 或项目 Logback 自动发现的 app_name 隔离条件。"""
    detected = discover_app_name_isolation(args.workdir, args.environment)
    explicit_value = (args.app_name or "").strip()
    value = explicit_value or detected["value"]
    return {
        **detected,
        "field": "app_name" if explicit_value else detected["field"],
        "value": value or None,
        "valueSource": "argument" if explicit_value else "logback" if detected["value"] else None,
    }


def discover_sources(base_url: str, token: str, streams: Sequence[Dict[str, str]], server_env: str, time_range: Dict[str, Any]) -> List[str]:
    """从带 serverEnv 的日志中发现测试或灰度节点，避免共用 Stream 串环境。"""
    page = run_search(base_url, token, field_clause("serverEnv", server_env), time_range, 500, 0, streams)
    sources = {
        str(item.get("message", {}).get("source", ""))
        for item in page.get("messages", [])
        if isinstance(item, dict) and item.get("message", {}).get("source")
    }
    if not sources:
        raise GraylogError(f"未从当前时间窗口发现 serverEnv={server_env} 的节点，无法安全隔离 {server_env} 环境")
    return sorted(sources)


def command_init_default(args: argparse.Namespace) -> None:
    """初始化默认连接，不接收也不保存 Token 明文。"""
    config_path = Path(args.config_path).expanduser() if args.config_path else default_config_path()
    config = read_config(config_path) if config_path.exists() else {"default": {}}
    config["default"] = {
        "baseUrl": args.base_url.rstrip("/"),
        "tokenEnv": args.token_env,
    }
    write_config(config_path, config)
    print_json({"connection": "默认", "baseUrl": args.base_url.rstrip("/"), "tokenEnv": args.token_env, "configPath": str(config_path)})


def command_init_service(args: argparse.Namespace) -> None:
    """初始化或更新业务系统的独立 Graylog 连接。"""
    config_path = Path(args.config_path).expanduser() if args.config_path else default_config_path()
    config = read_config(config_path) if config_path.exists() else {}
    connection = {"baseUrl": args.base_url.rstrip("/"), "tokenEnv": args.token_env, "name": args.name or args.service}
    existing = config.get(args.service)
    existing_aliases = existing.get("aliases", []) if isinstance(existing, dict) else []
    aliases = list(dict.fromkeys(args.alias if args.alias is not None else existing_aliases))
    if aliases:
        connection["aliases"] = aliases
    config[args.service] = connection
    write_config(config_path, config)
    print_json({"serviceKey": args.service, "service": connection["name"], "baseUrl": args.base_url.rstrip("/"), "tokenEnv": args.token_env, "aliases": aliases, "configPath": str(config_path)})


def command_learn_alias(args: argparse.Namespace) -> None:
    """基于用户明确纠正，为已配置业务系统追加可复用的识别别名。"""
    config_path = Path(args.config_path).expanduser() if args.config_path else default_config_path()
    config = read_config(config_path)
    service = config.get(args.service)
    if not isinstance(service, dict):
        raise GraylogError(f"未配置业务系统，无法学习别名: {args.service}")
    alias = args.alias.strip()
    if not alias:
        raise GraylogError("待学习别名不能为空")
    existing_aliases = configured_aliases(config, args.service)
    identities = [args.service, configured_display_name(config, args.service)] + existing_aliases
    if any(normalize_name(alias) == normalize_name(identity) for identity in identities):
        print_json({"serviceKey": args.service, "service": configured_display_name(config, args.service), "alias": alias, "learned": False, "reason": "别名已存在"})
        return
    service["aliases"] = existing_aliases + [alias]
    write_config(config_path, config)
    print_json({"serviceKey": args.service, "service": configured_display_name(config, args.service), "alias": alias, "learned": True})


def command_configure_service(args: argparse.Namespace) -> None:
    """从标准输入接收 Token，持久化凭据并新增或更新业务系统数据源。"""
    token = sys.stdin.read().strip()
    if not token:
        raise GraylogError("未从标准输入读取到 Graylog Token")
    token_env = args.token_env or default_token_env(args.service)
    persist_token(token_env, token)
    args.token_env = token_env
    command_init_service(args)


def command_configure_default(args: argparse.Namespace) -> None:
    """从标准输入接收 Token，持久化凭据并完成默认数据源首次配置。"""
    token = sys.stdin.read().strip()
    if not token:
        raise GraylogError("未从标准输入读取到 Graylog Token")
    token_env = args.token_env or "GRAYLOG_TOKEN_DEFAULT"
    persist_token(token_env, token)
    args.token_env = token_env
    command_init_default(args)


def command_preview(args: argparse.Namespace) -> None:
    """只读展示本次查询会使用的 Stream 与环境隔离要求。"""
    time_range = resolve_time_range(args)
    validate_query_preconditions(args.query, time_range, args.code_anchor)
    config = read_config(resolve_config_path(args))
    service = resolve_service(config, args.service, args.workdir)
    connection = service["connection"]
    streams = select_streams(list_streams(connection["baseUrl"], get_token(connection["tokenEnv"])), service["name"], args.environment)
    app_name_isolation = resolve_app_name_isolation(args)
    print_json({
        "service": service["name"],
        "projectHints": service["projectHints"],
        "connection": service["connectionLabel"],
        "baseUrl": connection["baseUrl"],
        "selectedStreams": streams,
        "environment": args.environment,
        "query": args.query,
        "codeAnchors": args.code_anchor,
        "timeRange": time_range,
        "requiresSourceIsolation": args.environment in {"gray", "test"},
        "recommendedServerEnv": args.environment if args.environment in {"gray", "test"} else None,
        "appNameIsolation": app_name_isolation,
    })


def resolve_config_path(args: argparse.Namespace) -> Path:
    """解析命令行显式配置路径或默认数据源路径。"""
    return Path(args.config_path).expanduser() if args.config_path else default_config_path()


def command_search(args: argparse.Namespace) -> None:
    """执行分页查询，并在灰度/测试共用 Stream 时强制完成节点隔离。"""
    if not args.allow_temporary_search:
        raise GraylogError("创建临时 Views Search 需要显式传入 --allow-temporary-search")
    time_range = resolve_time_range(args)
    validate_query_preconditions(args.query, time_range, args.code_anchor)
    config = read_config(resolve_config_path(args))
    service = resolve_service(config, args.service, args.workdir)
    connection = service["connection"]
    token = get_token(connection["tokenEnv"])
    streams = select_streams(list_streams(connection["baseUrl"], token), service["name"], args.environment)
    sources = list(args.source or [])
    app_name_isolation = resolve_app_name_isolation(args)
    if args.server_env and args.server_env != args.environment:
        raise GraylogError("--server-env 必须与 --environment 保持一致")
    if args.environment in {"gray", "test"} and not sources and not app_name_isolation["value"]:
        if not args.server_env:
            raise GraylogError("灰度和测试可能共用非正式 Stream，必须提供 --app-name、--server-env 或 --source 才能执行查询")
        sources = discover_sources(connection["baseUrl"], token, streams, args.server_env, time_range)
    query = args.query
    if sources:
        query = f"({query}) AND ({source_clause(sources)})"
    if app_name_isolation["value"]:
        query = f"({query}) AND ({field_clause(app_name_isolation['field'], app_name_isolation['value'])})"
    pages = []
    offset = args.offset
    first = run_search(connection["baseUrl"], token, query, time_range, args.limit, offset, streams)
    pages.append(first)
    total = int(first.get("total_results", 0))
    if args.all_pages:
        maximum = args.max_pages * args.limit
        remaining = max(total - args.offset, 0)
        if remaining > maximum:
            raise GraylogError(f"查询结果超过安全分页上限 {maximum}，请使用更精确的 ID、类名或时间范围")
        while offset + args.limit < total and len(pages) < args.max_pages:
            offset += args.limit
            pages.append(run_search(connection["baseUrl"], token, query, time_range, args.limit, offset, streams))
    rows = []
    for page in pages:
        rows.extend(message_rows(page.get("messages", [])))
    print_json({
        "service": service["name"],
        "projectHints": service["projectHints"],
        "connection": service["connectionLabel"],
        "baseUrl": connection["baseUrl"],
        "selectedStreams": streams,
        "environment": args.environment,
        "sourceIsolation": sources,
        "appNameIsolation": app_name_isolation,
        "query": query,
        "codeAnchors": args.code_anchor,
        "timeRange": time_range,
        "totalResults": total,
        "returnedMessages": len(rows),
        "searchIds": [page.get("_graylogSearchId") for page in pages],
        "messages": rows,
    }, args.output_file)


def command_execute_saved(args: argparse.Namespace) -> None:
    """仅用于 API 调试，显式执行已保存的 Search。"""
    if not re.fullmatch(r"[A-Za-z0-9-]{1,128}", args.search_id):
        raise GraylogError("search-id 格式不合法")
    config = read_config(resolve_config_path(args))
    connection = validate_connection(config["default"], "default")
    try:
        bindings = json.loads(args.parameter_bindings)
    except json.JSONDecodeError as exc:
        raise GraylogError("parameter-bindings 必须是 JSON 对象") from exc
    if not isinstance(bindings, dict):
        raise GraylogError("parameter-bindings 必须是 JSON 对象")
    response = request_json(connection["baseUrl"], get_token(connection["tokenEnv"]), "POST", f"/api/views/search/{args.search_id}/execute", {"parameter_bindings": bindings})
    if not isinstance(response, dict):
        raise GraylogError("Graylog 已保存 Search 返回格式无效")
    output = response if args.raw_response else {
        "searchId": response.get("search_id"),
        "executionId": response.get("id"),
        "resultCount": len(response.get("results", {})),
    }
    print_json(output, args.output_file)


def add_common_arguments(parser: argparse.ArgumentParser) -> None:
    """添加所有查询命令共享的业务系统、环境与时间参数。"""
    parser.add_argument("--service", help="可选业务系统名称，例如 订单服务；未提供时从当前项目识别")
    parser.add_argument("--workdir", help="用于识别当前项目的工作目录，默认当前目录")
    parser.add_argument("--environment", choices=("online", "gray", "test"), help="可选环境，用于 Stream 和节点二次隔离")
    parser.add_argument("--app-name", help="GELF app_name 精确值；未提供时尝试从项目 Logback staticField 和环境变量解析")
    parser.add_argument("--config-path")


def build_parser() -> argparse.ArgumentParser:
    """构建命令行参数定义。"""
    parser = argparse.ArgumentParser(description="Graylog Views Search 跨平台客户端")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init-default", help="初始化默认 Graylog 连接")
    init.add_argument("--base-url", required=True)
    init.add_argument("--token-env", required=True)
    init.add_argument("--config-path")
    init.set_defaults(handler=command_init_default)

    configure_default = subparsers.add_parser("configure-default", help="通过标准输入安全配置默认 Graylog 连接与 Token")
    configure_default.add_argument("--base-url", required=True)
    configure_default.add_argument("--token-env")
    configure_default.add_argument("--config-path")
    configure_default.set_defaults(handler=command_configure_default)

    service_init = subparsers.add_parser("init-service", help="初始化业务系统独立 Graylog 连接")
    service_init.add_argument("--service", required=True)
    service_init.add_argument("--name", help="业务系统中文展示名和 Stream 匹配名")
    service_init.add_argument("--base-url", required=True)
    service_init.add_argument("--token-env", required=True)
    service_init.add_argument("--alias", action="append", help="项目目录名或常用名称，可重复传入")
    service_init.add_argument("--config-path")
    service_init.set_defaults(handler=command_init_service)

    learn_alias = subparsers.add_parser("learn-alias", help="记录用户明确纠正后的项目别名")
    learn_alias.add_argument("--service", required=True, help="数据源配置中的 ASCII 项目键，例如 orderService")
    learn_alias.add_argument("--alias", required=True, help="用户明确纠正的项目名称、目录名或简称")
    learn_alias.add_argument("--config-path")
    learn_alias.set_defaults(handler=command_learn_alias)

    configure = subparsers.add_parser("configure-service", help="通过标准输入安全配置业务系统 Token 与 Graylog 连接")
    configure.add_argument("--service", required=True)
    configure.add_argument("--name", help="业务系统中文展示名和 Stream 匹配名")
    configure.add_argument("--base-url", required=True)
    configure.add_argument("--token-env")
    configure.add_argument("--alias", action="append", help="项目目录名或常用名称，可重复传入")
    configure.add_argument("--config-path")
    configure.set_defaults(handler=command_configure_service)

    for name, handler, help_text in (("preview", command_preview, "预览 Stream 与环境隔离"), ("search", command_search, "执行临时 Views Search")):
        command = subparsers.add_parser(name, help=help_text)
        add_common_arguments(command)
        command.add_argument("--query", required=True)
        command.add_argument("--from-seconds", type=bounded_integer(1, MAX_TIME_RANGE_SECONDS))
        command.add_argument("--from-time", help="带时区的 ISO 8601 开始时间，例如 2026-08-10T09:00:00+08:00")
        command.add_argument("--to-time", help="带时区的 ISO 8601 结束时间，例如 2026-08-10T10:00:00+08:00")
        command.add_argument(
            "--code-anchor",
            action="append",
            required=True,
            help="源码确认的类名、日志字面量、Topic 或关联字段，可重复传入",
        )
        command.add_argument("--limit", type=bounded_integer(1, 500), default=100)
        command.add_argument("--offset", type=bounded_integer(0, 1000000), default=0)
        command.add_argument("--server-env")
        command.add_argument("--source", action="append")
        if name == "search":
            command.add_argument("--allow-temporary-search", action="store_true")
            command.add_argument("--all-pages", action="store_true")
            command.add_argument("--max-pages", type=bounded_integer(1, 100), default=20)
            command.add_argument("--output-file", help="脱敏结果超过终端上限时写入的用户私有文件")
        command.set_defaults(handler=handler)

    saved = subparsers.add_parser("execute-saved", help="执行指定已保存 Search，仅用于 API 调试")
    saved.add_argument("--config-path")
    saved.add_argument("--search-id", required=True)
    saved.add_argument("--parameter-bindings", default="{}")
    saved.add_argument("--raw-response", action="store_true")
    saved.add_argument("--output-file", help="将递归脱敏后的响应写入用户私有文件")
    saved.set_defaults(handler=command_execute_saved)
    return parser


def main() -> int:
    """处理命令行异常，确保不在错误输出中泄露 Token。"""
    try:
        args = build_parser().parse_args()
        args.handler(args)
        return 0
    except GraylogError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
