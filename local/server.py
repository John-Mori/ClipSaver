from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO, Final, Mapping


HOST: Final = "127.0.0.1"
PORT: Final = int(os.environ.get("CLIPSAVER_PORT", "8790"))
ROOT: Final = Path(__file__).resolve().parents[1]
WEB_INDEX: Final = ROOT / "web" / "index.html"
USER_AGENT: Final = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
CACHE_TTL_SECONDS: Final = 15 * 60
MAX_BODY_BYTES: Final = 16 * 1024
CHUNK_BYTES: Final = 256 * 1024


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(slots=True)
class CacheEntry:
    created_at: float
    source_url: str
    video_id: str
    author_name: str
    author_id: str
    direct_urls: dict[str, str]
    format_ids: dict[str, str]


_cache: dict[str, CacheEntry] = {}
_cache_lock = threading.Lock()


def _purge_cache(now: float | None = None) -> None:
    current = now if now is not None else time.monotonic()
    with _cache_lock:
        expired = [key for key, value in _cache.items() if current - value.created_at > CACHE_TTL_SECONDS]
        for key in expired:
            _cache.pop(key, None)


def _validate_tiktok_url(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise ApiError("INVALID_URL", "URLが空か長すぎる")
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError as exc:
        raise ApiError("INVALID_URL", "URLの形式が違う") from exc
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not (host == "tiktok.com" or host.endswith(".tiktok.com")):
        raise ApiError("INVALID_URL", "TikTokのHTTPS URLだけを受け付ける")
    if parsed.username or parsed.password:
        raise ApiError("INVALID_URL", "認証情報付きURLは受け付けない")
    return value


def _yt_dlp_command() -> list[str]:
    override = os.environ.get("CLIPSAVER_YTDLP", "").strip()
    if override:
        return [override]
    module = subprocess.run(
        [sys.executable, "-c", "import yt_dlp"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if module.returncode == 0:
        return [sys.executable, "-m", "yt_dlp"]
    executable = shutil.which("yt-dlp")
    if executable:
        return [executable]
    raise ApiError("UPSTREAM_FAILED", "yt-dlpが見つからない", 500)


def _run_yt_dlp_json(url: str) -> dict[str, Any]:
    command = [
        *_yt_dlp_command(),
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--skip-download",
        "--user-agent",
        USER_AGENT,
        "--add-header",
        "Accept-Language:en-US,en;q=0.9",
        url,
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=90,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        last_line = detail[-1] if detail else "yt-dlp failed"
        lowered = last_line.lower()
        if "private" in lowered or "login" in lowered:
            raise ApiError("PRIVATE_VIDEO", last_line, 403)
        if "unsupported url" in lowered or "invalid url" in lowered:
            raise ApiError("INVALID_URL", last_line)
        if "photo" in lowered or "slideshow" in lowered:
            raise ApiError("PHOTO_POST_NO_VIDEO", last_line, 422)
        if "not available" in lowered or "not found" in lowered:
            raise ApiError("NOT_FOUND", last_line, 404)
        if "impersonation" in lowered or "challenge" in lowered or "unexpected response" in lowered:
            raise ApiError("TIKTOK_BLOCKED", last_line, 502)
        raise ApiError("UPSTREAM_FAILED", last_line, 502)
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ApiError("PARSE_FAILED", "yt-dlpのJSONを読めない", 502) from exc
    if not isinstance(value, dict):
        raise ApiError("PARSE_FAILED", "yt-dlpの結果が動画情報ではない", 502)
    return value


def _http_url(value: Any) -> str:
    return value if isinstance(value, str) and value.startswith(("https://", "http://")) else ""


def _format_score(item: Mapping[str, Any]) -> tuple[int, float, float]:
    return (
        int(item.get("height") or 0),
        float(item.get("tbr") or 0),
        float(item.get("filesize") or item.get("filesize_approx") or 0),
    )


def _select_formats(info: Mapping[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    formats = [item for item in info.get("formats") or [] if isinstance(item, dict)]
    video_formats = [
        item
        for item in formats
        if _http_url(item.get("url")) and item.get("vcodec") not in (None, "none")
    ]
    direct: dict[str, str] = {}
    format_ids: dict[str, str] = {}
    clean = [
        item
        for item in video_formats
        if "watermark" not in f"{item.get('format_id', '')} {item.get('format_note', '')}".lower()
    ]
    if clean:
        selected = max(clean, key=_format_score)
        direct["play"] = _http_url(selected.get("url"))
        format_ids["play"] = str(selected.get("format_id") or "best[ext=mp4]/best")
    elif _http_url(info.get("url")):
        direct["play"] = _http_url(info.get("url"))
        format_ids["play"] = str(info.get("format_id") or "best[ext=mp4]/best")

    watermarked = [
        item
        for item in video_formats
        if "watermark" in f"{item.get('format_id', '')} {item.get('format_note', '')}".lower()
    ]
    if watermarked:
        selected = max(watermarked, key=_format_score)
        direct["download"] = _http_url(selected.get("url"))
        format_ids["download"] = str(selected.get("format_id") or "best[ext=mp4]/best")
    return (
        {key: value for key, value in direct.items() if value},
        {key: value for key, value in format_ids.items() if value},
    )


def _thumbnail(info: Mapping[str, Any]) -> str:
    direct = _http_url(info.get("thumbnail"))
    if direct:
        return direct
    thumbnails = [item for item in info.get("thumbnails") or [] if isinstance(item, dict)]
    for item in reversed(thumbnails):
        url = _http_url(item.get("url"))
        if url:
            return url
    return ""


def resolve_video(url: str) -> dict[str, Any]:
    source_url = _validate_tiktok_url(url)
    info = _run_yt_dlp_json(source_url)
    video_id = str(info.get("id") or "")
    if not re.fullmatch(r"\d{10,21}", video_id):
        raise ApiError("PARSE_FAILED", "動画IDを取得できない", 502)

    direct_urls, format_ids = _select_formats(info)
    if not direct_urls.get("play"):
        raise ApiError("NO_MEDIA", "ロゴなし動画を取得できない", 422)

    author_name = str(info.get("uploader") or info.get("creator") or info.get("channel") or "")
    author_id = str(info.get("uploader_id") or info.get("channel_id") or "")
    has_audio = any(
        isinstance(item, dict) and item.get("acodec") not in (None, "none")
        for item in info.get("formats") or []
    ) or bool(info.get("acodec") not in (None, "none"))

    entry = CacheEntry(
        created_at=time.monotonic(),
        source_url=str(info.get("webpage_url") or source_url),
        video_id=video_id,
        author_name=author_name,
        author_id=author_id,
        direct_urls=direct_urls,
        format_ids=format_ids,
    )
    _purge_cache(entry.created_at)
    with _cache_lock:
        _cache[video_id] = entry

    files: dict[str, str] = {
        key: f"/api/file?id={urllib.parse.quote(video_id)}&kind={key}"
        for key in ("play",)
        if direct_urls.get(key)
    }
    if has_audio:
        files["music"] = f"/api/file?id={urllib.parse.quote(video_id)}&kind=music"

    return {
        "ok": True,
        "item": {
            "id": video_id,
            "author": {"name": author_name, "uniqueId": author_id},
            "desc": str(info.get("description") or info.get("title") or ""),
            "cover": _thumbnail(info),
            "sourceUrl": entry.source_url,
        },
        "files": files,
    }


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", value.strip())
    cleaned = re.sub(r"\s+", "_", cleaned).strip(" ._")[:60]
    return cleaned or "tiktok"


def _cache_entry(video_id: str) -> CacheEntry:
    _purge_cache()
    with _cache_lock:
        entry = _cache.get(video_id)
    if entry is None:
        raise ApiError("FILE_EXPIRED", "取得結果の期限が切れた", 410)
    return entry


def _extract_audio(entry: CacheEntry) -> Path:
    output_dir = Path(tempfile.mkdtemp(prefix="clipsaver-audio-"))
    output_template = output_dir / "audio.%(ext)s"
    command = [
        *_yt_dlp_command(),
        "--no-playlist",
        "--no-warnings",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--user-agent",
        USER_AGENT,
        "--output",
        str(output_template),
        entry.source_url,
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        shutil.rmtree(output_dir, ignore_errors=True)
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise ApiError("UPSTREAM_FAILED", detail[-1] if detail else "音声抽出に失敗", 502)
    files = list(output_dir.glob("audio.*"))
    if not files or files[0].stat().st_size <= 0:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise ApiError("NO_MEDIA", "音声ファイルを作れない", 422)
    return files[0]


def _download_video(entry: CacheEntry, kind: str) -> Path:
    format_id = entry.format_ids.get(kind)
    if not format_id:
        raise ApiError("NO_MEDIA", "指定された形式は取得できない", 404)
    output_dir = Path(tempfile.mkdtemp(prefix="clipsaver-video-"))
    output_template = output_dir / "video.%(ext)s"
    command = [
        *_yt_dlp_command(),
        "--no-playlist",
        "--no-warnings",
        "--user-agent",
        USER_AGENT,
        "--format",
        format_id,
        "--output",
        str(output_template),
        entry.source_url,
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        shutil.rmtree(output_dir, ignore_errors=True)
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise ApiError("UPSTREAM_FAILED", detail[-1] if detail else "動画保存に失敗", 502)
    files = list(output_dir.glob("video.*"))
    if not files or files[0].stat().st_size <= 0:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise ApiError("NO_MEDIA", "動画ファイルを作れない", 422)
    return files[0]


class ClipSaverHandler(BaseHTTPRequestHandler):
    server_version = "ClipSaver/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        print(f"[{timestamp} JST] {self.address_string()} {format_string % args}")

    def _send_headers(self, status: int, headers: Mapping[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Range")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _send_json(self, value: Any, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_headers(
            status,
            {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(payload)),
                "Cache-Control": "no-store",
            },
        )
        self.wfile.write(payload)

    def _send_error(self, error: ApiError) -> None:
        self._send_json(
            {"ok": False, "error": {"code": error.code, "message": error.message}},
            error.status,
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_headers(HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        try:
            if parsed.path in ("/", "/index.html"):
                self._serve_index()
                return
            if parsed.path == "/api/file":
                self._serve_file(urllib.parse.parse_qs(parsed.query))
                return
            raise ApiError("NOT_FOUND", "ページが見つからない", 404)
        except ApiError as error:
            self._send_error(error)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/api/resolve":
            self._send_error(ApiError("NOT_FOUND", "APIが見つからない", 404))
            return
        try:
            raw_length = self.headers.get("Content-Length", "")
            if not raw_length.isdigit() or int(raw_length) > MAX_BODY_BYTES:
                raise ApiError("INVALID_URL", "JSON本文が大きすぎる")
            raw = self.rfile.read(int(raw_length))
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ApiError("INVALID_URL", "JSON本文を読めない") from exc
            self._send_json(resolve_video(body.get("url")))
        except ApiError as error:
            self._send_error(error)
        except subprocess.TimeoutExpired:
            self._send_error(ApiError("UPSTREAM_FAILED", "yt-dlpが時間内に応答しない", 504))

    def _serve_index(self) -> None:
        if not WEB_INDEX.is_file():
            raise ApiError("NOT_FOUND", "web/index.htmlが見つからない", 500)
        payload = WEB_INDEX.read_bytes()
        self._send_headers(
            HTTPStatus.OK,
            {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": str(len(payload)),
                "Cache-Control": "no-cache",
            },
        )
        self.wfile.write(payload)

    def _serve_file(self, query: Mapping[str, list[str]]) -> None:
        video_id = (query.get("id") or [""])[0]
        kind = (query.get("kind") or [""])[0]
        if not re.fullmatch(r"\d{10,21}", video_id) or kind not in {"play", "music"}:
            raise ApiError("INVALID_URL", "idまたはkindが不正")
        entry = _cache_entry(video_id)
        author = _safe_filename(entry.author_id or entry.author_name)

        if kind == "music":
            audio_path = _extract_audio(entry)
            try:
                self._stream_local_file(audio_path, f"{author}_{video_id}.mp3", "audio/mpeg")
            finally:
                shutil.rmtree(audio_path.parent, ignore_errors=True)
            return

        video_path = _download_video(entry, kind)
        try:
            self._stream_local_file(video_path, f"{author}_{video_id}.mp4", "video/mp4")
        finally:
            shutil.rmtree(video_path.parent, ignore_errors=True)

    def _stream_local_file(self, path: Path, filename: str, content_type: str) -> None:
        self._send_headers(
            HTTPStatus.OK,
            {
                "Content-Type": content_type,
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Content-Length": str(path.stat().st_size),
                "Cache-Control": "private, no-store",
            },
        )
        with path.open("rb") as source:
            self._copy_stream(source, self.wfile)

    @staticmethod
    def _copy_stream(source: BinaryIO, destination: BinaryIO) -> None:
        try:
            while chunk := source.read(CHUNK_BYTES):
                destination.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), ClipSaverHandler)
    print(f"ClipSaver local: http://{HOST}:{PORT}/")
    print("終了: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
