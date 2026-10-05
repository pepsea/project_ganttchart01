"""アプリのバージョン情報

- バージョン番号は VERSION ファイル（1.0.0 の形）で管理する。更新履歴は CHANGELOG.md
- 画面の右上（ログアウトの隣）に表示し、クリックで更新履歴を見られる
- どのコミット・いつ作ったかも、分かるときは表示する（Docker のビルド時に GIT_COMMIT / BUILD_DATE を渡す。update.sh が渡す）
"""

import os
import subprocess
from pathlib import Path

from fastapi import APIRouter

BASE_DIR = Path(__file__).resolve().parent
router = APIRouter(prefix="/api", tags=["バージョン"])


def _read(name: str, default: str = "") -> str:
    try:
        return (BASE_DIR / name).read_text(encoding="utf-8").strip()
    except OSError:
        return default


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=BASE_DIR, capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception:  # noqa: BLE001  git が無い・フォルダが git でない
        return ""


def info() -> dict:
    return {
        "version": _read("VERSION", "0.0.0"),
        "commit": os.environ.get("APP_COMMIT") or _git("rev-parse", "--short", "HEAD"),
        "built": os.environ.get("APP_BUILT") or "",
        "changelog": _read("CHANGELOG.md"),
    }


_cached: dict | None = None


@router.get("/version")
def get_version() -> dict:
    global _cached
    if _cached is None:  # 起動中は変わらないので、1 回だけ読む
        _cached = info()
    return _cached
