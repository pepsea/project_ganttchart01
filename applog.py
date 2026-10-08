"""操作・エラーのログ

- すべての操作（登録・更新・削除・インポート・ログイン・ログアウトなど、データを変える操作と、エクスポート＝ダウンロード）と、
  すべてのエラー（サーバーのエラー、入力のエラー、画面（ブラウザ）で起きた JavaScript のエラー）を記録する
- 記録するのは「いつ・何を・どの結果で」だけ。入力した内容（本文・パスワードなど）は記録しない
- ファイルは DATA_DIR/logs/app-YYYYMMDD.jsonl（1 日 1 ファイル、1 行 1 件）。データベースには入れない（バックアップを大きくしない）
- KEEP_DAYS（約 1 か月）を過ぎた日のファイルは自動で削除する
- 「バックアップ」画面から CSV でダウンロードできる（全部 / エラーのみ）
"""

import asyncio
import json
import re
import threading
import time
import traceback
from datetime import datetime, timedelta

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from csvutil import csv_response
from db import DATA_DIR

LOG_DIR = DATA_DIR / "logs"
KEEP_DAYS = 31  # ログを残す日数（約 1 か月）
NAME_RE = re.compile(r"^app-(\d{8})\.jsonl$")
_lock = threading.Lock()

router = APIRouter(prefix="/api", tags=["ログ"])

# 操作の名前（画面に出す説明）: パスの先頭の部分から決める
RESOURCES = {
    "tasks": "タスク", "cases": "案件", "platforms": "基盤技術", "services": "サービス", "documents": "共有資料",
    "links": "自社リンク・ナレッジ", "groups": "グループ", "people": "個人", "records": "メモ・議論", "masters": "選択肢",
    "admin": "管理・バックアップ", "import": "タスク", "export.csv": "タスク", "logs": "ログ",
}
VERBS = {"POST": "追加", "PUT": "更新", "PATCH": "更新", "DELETE": "削除", "GET": "取得"}


def _operation(method: str, path: str) -> str:
    if path in ("/login", "/api/login"):
        return "ログイン"
    if path in ("/logout", "/api/logout"):
        return "ログアウト"
    parts = [p for p in path.split("/") if p]
    segs = parts[1:] if parts and parts[0] == "api" else parts
    name = RESOURCES.get(segs[0], segs[0]) if segs else path
    tail = "/".join(segs[1:])
    if "import" in segs:
        return f"{name}のインポート"
    if any(s.startswith("export") for s in segs) or "download" in segs or tail.endswith(".csv"):
        return f"{name}のエクスポート（ダウンロード）"
    if "restore" in segs:
        return f"{name}の復元"
    if "reorder" in segs or "move" in segs:
        return f"{name}の並べ替え"
    if "done" in segs:
        return f"{name}の完了・取り消し"
    return f"{name}の{VERBS.get(method, method)}"


def write(kind: str, method: str, path: str, status: int, ms: int, ip: str, detail: str = "", op: str = "") -> None:
    """1 件を記録する（失敗してもアプリは止めない）"""
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        now = datetime.now()
        line = json.dumps({"t": now.strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "op": op or _operation(method, path),
                           "method": method, "path": path, "status": status, "ms": ms, "ip": ip,
                           "detail": detail[:500]}, ensure_ascii=False)
        with _lock:
            with open(LOG_DIR / f"app-{now:%Y%m%d}.jsonl", "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"[log] ログを書けませんでした: {e}")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "")) or ""


def _worth_logging(method: str, path: str, status: int) -> str | None:
    """記録する種類（操作 / エラー）。記録しないときは None"""
    if path.startswith("/static") or path == "/favicon.ico":
        return None
    if path == "/api/logs/client" and status < 400:
        return None  # 画面のエラーの報告そのものは、記録済み（二重にしない）
    if status >= 400:
        return "エラー"
    if method != "GET":
        return "操作"
    if any(s in path for s in ("/export", "/download")) or path.endswith(".csv"):
        return "操作"  # ダウンロード
    return None


async def log_requests(request: Request, call_next):
    """すべてのリクエストを見て、操作とエラーを記録する（いちばん外側のミドルウェア）"""
    start = time.time()
    path, method = request.url.path, request.method
    try:
        response = await call_next(request)
    except Exception as e:  # noqa: BLE001  想定外のエラー
        traceback.print_exc()
        write("エラー", method, path, 500, int((time.time() - start) * 1000), _client_ip(request),
              f"{type(e).__name__}: {e}")
        return JSONResponse({"detail": "サーバーでエラーが起きました（ログに記録しました）"}, status_code=500)
    kind = _worth_logging(method, path, response.status_code)
    if kind:
        write(kind, method, path, response.status_code, int((time.time() - start) * 1000), _client_ip(request),
              getattr(request.state, "err_detail", "") if kind == "エラー" else "")
    return response


class ClientError(BaseModel):
    message: str = ""
    source: str = ""
    line: int = 0
    page: str = ""


_client_times: list[float] = []


@router.post("/logs/client", status_code=204)
def client_error(e: ClientError, request: Request):
    """画面（ブラウザ）で起きたエラーを記録する（1 分に 30 件まで）"""
    now = time.time()
    _client_times[:] = [t for t in _client_times if now - t < 60]
    if len(_client_times) >= 30:
        return
    _client_times.append(now)
    detail = f"{e.message[:300]}（{e.source[-80:]}:{e.line}）" if e.source else e.message[:300]
    write("画面エラー", "-", e.page[:200] or "-", 0, 0, _client_ip(request), detail, op="画面（JavaScript）のエラー")


def _files() -> list:
    if not LOG_DIR.exists():
        return []
    return sorted(f for f in LOG_DIR.glob("app-*.jsonl") if NAME_RE.match(f.name))


def _entries(errors_only: bool = False):
    for f in _files():
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if not errors_only or d.get("kind") in ("エラー", "画面エラー"):
                yield d


@router.get("/admin/logs/summary")
def summary() -> dict:
    files = _files()
    entries = list(_entries())
    return {"files": len(files), "entries": len(entries), "errors": sum(1 for d in entries if d.get("kind") != "操作"),
            "oldest": NAME_RE.match(files[0].name).group(1) if files else "",
            "newest": NAME_RE.match(files[-1].name).group(1) if files else "", "keep_days": KEEP_DAYS}


@router.get("/admin/logs/download")
def download(kind: str = "all"):
    """ログを CSV でダウンロード（kind=all: すべて / kind=error: エラーのみ。新しいものが上）"""
    rows = [["日時", "種別", "操作", "メソッド", "パス", "状態", "所要時間(ms)", "接続元", "内容"]]
    for d in sorted(_entries(kind == "error"), key=lambda x: x.get("t", ""), reverse=True):
        rows.append([d.get("t", ""), d.get("kind", ""), d.get("op", ""), d.get("method", ""), d.get("path", ""),
                     d.get("status", ""), d.get("ms", ""), d.get("ip", ""), d.get("detail", "")])
    return csv_response(rows, "app_log_errors" if kind == "error" else "app_log")


def prune(now: datetime | None = None) -> list[str]:
    """KEEP_DAYS を過ぎた日のログファイルを削除する"""
    limit = (now or datetime.now()) - timedelta(days=KEEP_DAYS)
    removed = []
    for f in _files():
        day = datetime.strptime(NAME_RE.match(f.name).group(1), "%Y%m%d")
        if day < limit.replace(hour=0, minute=0, second=0, microsecond=0):
            f.unlink(missing_ok=True)
            removed.append(f.name)
    return removed


async def prune_loop() -> None:
    while True:
        try:
            prune()
        except Exception as e:  # noqa: BLE001
            print(f"[log] 古いログの削除に失敗しました: {e}")
        await asyncio.sleep(3600)
