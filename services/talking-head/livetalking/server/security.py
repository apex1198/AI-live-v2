import hmac
import os
import re
from pathlib import Path
from aiohttp import web


SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def csv_env(name: str, default: str = ""):
    return [value.strip() for value in os.getenv(name, default).split(",") if value.strip()]


def require_safe_id(value, label="id"):
    candidate = str(value or "").strip()
    if not SAFE_ID.fullmatch(candidate):
        raise ValueError(f"{label} must contain only letters, numbers, underscore, or dash")
    return candidate


def secure_filename(value):
    name = Path(str(value or "upload.bin")).name
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name).lstrip(".")[:120]
    if not safe:
        raise ValueError("invalid upload filename")
    return safe


def _allowed_roots(env_name: str, defaults):
    configured = csv_env(env_name)
    roots = configured or defaults
    return [Path(root).expanduser().resolve() for root in roots]


def resolve_existing_media(value):
    candidate = Path(str(value or "")).expanduser().resolve()
    roots = _allowed_roots(
        "LIVETALKING_ALLOWED_MEDIA_ROOTS",
        [str(Path("./data/tmp").resolve()), str(Path("./data/avatars").resolve())],
    )
    if not any(candidate == root or root in candidate.parents for root in roots):
        raise ValueError("video_path is outside the allowed media roots")
    if not candidate.is_file():
        raise ValueError("video_path does not exist")
    return str(candidate)


def resolve_avatar_output(value):
    candidate = Path(str(value or "./data/avatars")).expanduser().resolve()
    roots = _allowed_roots(
        "LIVETALKING_ALLOWED_AVATAR_ROOTS",
        [str(Path("./data/avatars").resolve())],
    )
    if not any(candidate == root or root in candidate.parents for root in roots):
        raise ValueError("save_path is outside the allowed avatar roots")
    candidate.mkdir(parents=True, exist_ok=True)
    return str(candidate)


def resolve_avatar_entry(avatar_id):
    """Resolve one avatar and its symlink target without escaping allowed roots."""
    safe_id = require_safe_id(avatar_id, "avatar_id")
    native_root = Path("./data/avatars").resolve()
    entry = native_root / safe_id
    roots = _allowed_roots(
        "LIVETALKING_ALLOWED_AVATAR_ROOTS",
        [str(native_root)],
    )
    if not entry.exists() and not entry.is_symlink():
        raise FileNotFoundError("avatar not found")
    target = entry.resolve(strict=False)
    if target in roots or not any(root in target.parents for root in roots):
        raise ValueError("avatar path is outside the allowed avatar roots")
    return entry, target


def is_loopback_host(host: str):
    return host in ("127.0.0.1", "::1", "localhost")


@web.middleware
async def auth_middleware(request, handler):
    if request.path == "/health":
        return await handler(request)
    expected = os.getenv("LIVETALKING_AUTH_TOKEN", "").strip()
    if expected:
        authorization = request.headers.get("Authorization", "")
        candidate = authorization[7:].strip() if authorization.startswith("Bearer ") else ""
        if not candidate or not hmac.compare_digest(candidate, expected):
            return web.json_response({"code": 401, "msg": "authentication required"}, status=401)
    return await handler(request)
