"""全データのバックアップ・復元（管理サイト用）

- バックアップは JSON（全テーブルの全行）。テーブル・列はデータベースから自動で読み取るので、今後項目が増えても対象になる
- 復元は全データの置き換え。パスワードが必要で、直前の状態を自動でサーバーに保存してから実行する
- サーバーには月 1 回自動でバックアップを保存し、直近 AUTO_KEEP か月分を残す
- アプリの起動のたび（アップデートでテーブルを更新する前）にもバックアップを保存し、直近 STARTUP_KEEP 回分を残す
- 復元のあとには MIGRATIONS（テーブルの作成・列の追加）を実行し、古い形式のバックアップも新しいアプリで使えるようにする
"""

import asyncio
import json
import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

import auth
from db import DATA_DIR, DB_PATH, get_db

router = APIRouter(prefix="/api/admin", tags=["バックアップ"])

BACKUP_DIR = DATA_DIR / "backups"
FORMAT = "gantt-pm-backup"
VERSION = 1
AUTO_KEEP = 12  # 自動バックアップ（月 1 回）を残す数 = 12 か月分
STARTUP_KEEP = 10
NAME_RE = re.compile(r"^(auto|manual|pre-restore|startup)-\d{8}-\d{6}\.json$")
MIGRATIONS: list = []  # main.py が登録する（テーブルの作成・列の追加）

# テーブルの説明（管理画面の表示用）
TABLE_LABELS = {
    "tasks": "ガントチャートのタスク",
    "cases": "案件",
    "case_notes": "案件の週次進捗メモ",
    "case_monthly": "案件の月報",
    "platforms": "基盤（基盤番号・基本情報・全体目標）",
    "platform_goals": "基盤の目標",
    "platform_topics": "基盤のディスカッション",
    "platform_monthly": "基盤の月報",
    "services": "サービス",
    "service_packages": "主要サービスパッケージ",
    "app_settings": "画面の設定（親リンクなど）",
    "documents": "共有資料",
    "ref_links": "参考リンク",
    "team_groups": "グループ",
    "team_goals": "グループの目標",
    "team_kpis": "グループの今年度の達成指標",
    "areas": "領域",
    "case_nos": "案件番号",
    "customers": "顧客",
    "projects": "（旧）PJ名",
}


def _tables(db: sqlite3.Connection) -> list[str]:
    return [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def dump() -> dict:
    """全テーブルの全行を辞書にする"""
    with get_db() as db:
        tables = {}
        for t in _tables(db):
            tables[t] = [dict(r) for r in db.execute(f"SELECT * FROM {t} ORDER BY rowid")]
    return {
        "format": FORMAT,
        "version": VERSION,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "tables": tables,
    }


def summary(data: dict) -> list[dict]:
    return [{"table": t, "label": TABLE_LABELS.get(t, t), "rows": len(rows)}
            for t, rows in data["tables"].items()]


def save_to_server(kind: str) -> str:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{kind}-{datetime.now():%Y%m%d-%H%M%S}.json"
    (BACKUP_DIR / name).write_text(json.dumps(dump(), ensure_ascii=False), encoding="utf-8")
    return name


def _validate(data: dict) -> dict:
    if not isinstance(data, dict) or data.get("format") != FORMAT or not isinstance(data.get("tables"), dict):
        raise HTTPException(422, "このシステムのバックアップファイルではありません")
    for t, rows in data["tables"].items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", t) or not isinstance(rows, list):
            raise HTTPException(422, f"バックアップの内容が正しくありません（{t}）")
    return data


def restore(data: dict) -> list[dict]:
    """全データを置き換える。バックアップに無いテーブルは空にせず、そのまま残す。"""
    data = _validate(data)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA foreign_keys = OFF")  # 削除・再投入の順序で連鎖削除が起きないように
        existing = set(_tables(conn))
        with conn:  # 1 つのトランザクション（失敗したら全部元に戻る）
            for t, rows in data["tables"].items():
                if t not in existing:
                    continue
                cols = {r[1] for r in conn.execute(f"PRAGMA table_info({t})")}
                conn.execute(f"DELETE FROM {t}")
                for row in rows:
                    keys = [k for k in row if k in cols]
                    if not keys:
                        continue
                    conn.execute(f"INSERT INTO {t} ({', '.join(keys)}) VALUES ({', '.join('?' * len(keys))})",
                                 [row[k] for k in keys])
    except sqlite3.Error as e:
        raise HTTPException(422, f"復元に失敗しました（データは変更されていません）: {e}")
    finally:
        conn.close()
    # 古いバックアップでも新しいアプリの形式（追加された列など）に合わせる
    for migrate in MIGRATIONS:
        migrate()
    return summary(data)


def list_server_backups() -> list[dict]:
    if not BACKUP_DIR.exists():
        return []
    items = []
    for f in sorted(BACKUP_DIR.glob("*.json"), reverse=True):
        if NAME_RE.match(f.name):
            st = f.stat()
            items.append({"name": f.name, "kind": f.name.split("-")[0] if not f.name.startswith("pre-restore")
                          else "pre-restore", "size": st.st_size,
                          "created_at": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    return sorted(items, key=lambda x: x["name"].split("-", 1)[-1] if not x["name"].startswith("pre-restore")
                  else x["name"][len("pre-restore-"):], reverse=True)


def _server_file(name: str):
    if not NAME_RE.match(name) or not (BACKUP_DIR / name).is_file():
        raise HTTPException(404, "バックアップが見つかりません")
    return BACKUP_DIR / name


async def _check_password(password: str) -> None:
    if not auth.check_password(password):
        await asyncio.sleep(1)  # 総当たり対策
        raise HTTPException(403, "パスワードが正しくないため復元できません")


def _prune(prefix: str, keep: int) -> None:
    for old in sorted(BACKUP_DIR.glob(f"{prefix}-*.json"))[:-keep]:
        old.unlink(missing_ok=True)


def save_startup_backup() -> str | None:
    """起動時（テーブル更新の前）のバックアップ。失敗しても起動は続ける"""
    try:
        name = save_to_server("startup")
        _prune("startup", STARTUP_KEEP)
        return name
    except Exception as e:  # noqa: BLE001
        print(f"[backup] 起動時のバックアップに失敗しました: {e}")
        return None


# ---------------------------------------------------------------- 自動バックアップ（月 1 回）

def ensure_monthly_backup() -> str | None:
    """その月の自動バックアップがまだなければ保存する（1 時間ごとに確認）"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    this_month = f"auto-{datetime.now():%Y%m}"
    if any(f.name.startswith(this_month) for f in BACKUP_DIR.glob("auto-*.json")):
        return None
    name = save_to_server("auto")
    _prune("auto", AUTO_KEEP)
    return name


async def auto_backup_loop() -> None:
    while True:
        try:
            ensure_monthly_backup()
        except Exception as e:  # noqa: BLE001  バックアップの失敗でアプリを止めない
            print(f"[backup] 自動バックアップに失敗しました: {e}")
        await asyncio.sleep(3600)


# ---------------------------------------------------------------- API

class PasswordIn(BaseModel):
    password: str = ""


@router.get("/backup")
def download_backup() -> Response:
    """全データのバックアップ（JSON）をダウンロード"""
    body = json.dumps(dump(), ensure_ascii=False, indent=1).encode("utf-8")
    filename = f"backup_{datetime.now():%Y%m%d_%H%M%S}.json"
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/backup/summary")
def current_summary() -> dict:
    data = dump()
    return {"tables": summary(data), "server_backups": list_server_backups(), "auto_keep": AUTO_KEEP,
            "startup_keep": STARTUP_KEEP}


@router.post("/backups", status_code=201)
def create_server_backup() -> dict:
    return {"name": save_to_server("manual"), "server_backups": list_server_backups()}


@router.get("/backups/{name}")
def download_server_backup(name: str):
    return FileResponse(_server_file(name), media_type="application/json", filename=name)


@router.post("/restore")
async def restore_upload(file: UploadFile = File(...), password: str = Form("")) -> dict:
    """アップロードしたバックアップで全データを置き換える（パスワード必須。直前の状態をサーバーに保存）"""
    await _check_password(password)
    try:
        data = json.loads((await file.read()).decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(422, "バックアップファイル（JSON）を読み込めません")
    _validate(data)
    saved = save_to_server("pre-restore")
    return {"restored": restore(data), "backup_created_at": data.get("created_at"), "pre_restore": saved}


@router.delete("/backups/{name}", status_code=204)
async def delete_server_backup(name: str, body: PasswordIn) -> Response:
    """サーバー上のバックアップを削除（パスワード必須。元に戻せない）"""
    path = _server_file(name)
    if not auth.check_password(body.password):
        await asyncio.sleep(1)  # 総当たり対策
        raise HTTPException(403, "パスワードが正しくないため削除できません")
    path.unlink(missing_ok=True)
    return Response(status_code=204)


@router.post("/backups/{name}/restore")
async def restore_server_backup(name: str, body: PasswordIn) -> dict:
    await _check_password(body.password)
    path = _server_file(name)
    data = json.loads(path.read_text(encoding="utf-8"))
    _validate(data)
    saved = save_to_server("pre-restore")
    return {"restored": restore(data), "backup_created_at": data.get("created_at"), "pre_restore": saved}
