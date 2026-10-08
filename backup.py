"""全データのバックアップ・復元（管理サイト用）

- バックアップは JSON（全テーブルの全行）。テーブル・列はデータベースから自動で読み取るので、今後項目が増えても対象になる
- 復元は全データの置き換え。パスワードが必要で、直前の状態を自動でサーバーに保存してから実行する
- サーバーには毎日 1 回、夜 12 時（0 時台）に自動でバックアップを保存する（その時間にアプリが止まっていた日は保存しない）
- サーバー上のバックアップは、作成から KEEP_DAYS 日（約 1 か月）を過ぎたら自動で削除する（最新の 1 つは残す）
- バックアップは管理サイトからいつでも作れる（「今すぐバックアップを作る」）。一覧の「復元」でいつでも戻せる
- バックアップファイルはダウンロードでき、手元のファイルをサーバーにアップロード（保存のみ。復元は別操作）もできる
- アプリの起動時には自動バックアップを行わない（アップデートの前は update.sh が手動のバックアップを取る。直接 docker compose up するときは先に手動で作る）
- 復元のあとには MIGRATIONS（テーブルの作成・列の追加）を実行し、古い形式のバックアップも新しいアプリで使えるようにする
"""

import asyncio
import json
import re
import sqlite3
from datetime import datetime, timedelta

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

import auth
from db import DATA_DIR, DB_PATH, get_db

router = APIRouter(prefix="/api/admin", tags=["バックアップ"])

BACKUP_DIR = DATA_DIR / "backups"
FORMAT = "gantt-pm-backup"
VERSION = 1
AUTO_KEEP = 40  # 自動バックアップ（毎日 0 時）を残す数の上限（KEEP_DAYS を過ぎたものは別に自動削除）
KEEP_DAYS = 31  # サーバー上のバックアップを残す日数（約 1 か月）。これより古いものは自動で削除
STARTUP_KEEP = 10
NAME_RE = re.compile(r"^(auto|manual|pre-restore|startup|upload)-\d{8}-\d{6}\.json$")
MIGRATIONS: list = []  # main.py が登録する（テーブルの作成・列の追加）
# 形を変えたテーブル: {新テーブル: (旧テーブル, 旧→新へ写す SQL)}。main.py が登録する。
# 新テーブルを含まない古いバックアップを復元したときは、復元した旧テーブルから作り直す
LEGACY_UPGRADES: dict[str, tuple[str, str]] = {}

# テーブルの説明（管理画面の表示用）
TABLE_LABELS = {
    "tasks": "ガントチャートのタスク",
    "task_history": "ガントチャートの履歴（完了・削除したタスクの写し）",
    "case_history": "案件の履歴（終了・削除した案件の写し）",
    "cases": "案件",
    "case_notes": "案件の週次進捗メモ（旧形式・未使用）",
    "case_progress": "案件の進捗メモ",
    "case_monthly": "案件の月報",
    "platforms": "基盤（基盤番号・基本情報・全体目標）",
    "platform_goals": "基盤の目標",
    "platform_goal_tasks": "基盤の項目の中の実施内容（進捗率）",
    "platform_goal_notes": "基盤の項目の議論の記録",
    "platform_topics": "基盤のディスカッション",
    "platform_monthly": "基盤の月報",
    "services": "サービス",
    "service_packages": "主要サービスパッケージ",
    "service_links": "サービス・パッケージの追加リンク",
    "app_settings": "画面の設定（親リンクなど）",
    "documents": "共有資料",
    "ref_links": "自社リンク・ナレッジのリンク",
    "team_groups": "グループ",
    "team_goals": "グループの目標",
    "team_goal_notes": "グループの項目の議論の記録",
    "team_kpis": "グループの今年度の達成指標（画面では非表示）",
    "team_achievements": "グループの達成したこと（年度ごと）",
    "team_years": "グループ目標の年度（選択肢）",
    "person_notes": "個人のメモ",
    "case_links": "案件の自由リンク",
    "document_links": "共有資料のリンク",
    "records": "メモ・議論（記録）",
    "platform_links": "基盤の自由リンク",
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
            for new, (old, copy_sql) in LEGACY_UPGRADES.items():
                if new in existing and new not in data["tables"] and old in data["tables"]:
                    conn.execute(f"DELETE FROM {new}")
                    conn.execute(copy_sql)
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
                          "expires_at": ((_created(f.name) or datetime.fromtimestamp(st.st_mtime)) + timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds"),
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


# ---------------------------------------------------------------- 自動バックアップ（毎日 夜 12 時）

def ensure_daily_backup(now: datetime | None = None) -> str | None:
    """夜 12 時（0 時台）に、今日の自動バックアップがまだなければ保存する（1 分ごとに確認）。
    アプリが止まっていて 0 時台に動いていなかった日は保存しない（起動時にバックアップを取らない方針）"""
    now = now or datetime.now()
    if now.hour != 0:
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    today = f"auto-{now:%Y%m%d}"
    if any(f.name.startswith(today) for f in BACKUP_DIR.glob("auto-*.json")):
        return None
    name = save_to_server("auto")
    _prune("auto", AUTO_KEEP)
    return name


def _created(name: str) -> datetime | None:
    """ファイル名（種類-YYYYmmdd-HHMMSS.json）から作成日時"""
    m = re.search(r"(\d{8}-\d{6})\.json$", name)
    return datetime.strptime(m.group(1), "%Y%m%d-%H%M%S") if m else None


def prune_old_backups(now: datetime | None = None) -> list[str]:
    """作成から KEEP_DAYS 日を過ぎたサーバー上のバックアップを削除する（すべての種類。最新の 1 つは必ず残す）"""
    if not BACKUP_DIR.exists():
        return []
    limit = (now or datetime.now()) - timedelta(days=KEEP_DAYS)
    files = [(c, f) for f in BACKUP_DIR.glob("*.json") if NAME_RE.match(f.name) and (c := _created(f.name))]
    if not files:
        return []
    newest = max(files)[1]
    removed = []
    for created, f in files:
        if created < limit and f != newest:
            f.unlink(missing_ok=True)
            removed.append(f.name)
    return removed


async def auto_backup_loop() -> None:
    while True:
        try:
            ensure_daily_backup()
            prune_old_backups()
        except Exception as e:  # noqa: BLE001  バックアップの失敗でアプリを止めない
            print(f"[backup] 自動バックアップに失敗しました: {e}")
        await asyncio.sleep(60)


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
            "startup_keep": STARTUP_KEEP, "keep_days": KEEP_DAYS}


@router.post("/backups", status_code=201)
def create_server_backup() -> dict:
    return {"name": save_to_server("manual"), "server_backups": list_server_backups()}


@router.post("/backups/upload", status_code=201)
async def upload_backup(file: UploadFile = File(...)) -> dict:
    """手元のバックアップファイル（JSON）をサーバーに保存する（保存のみ。データは変わらない）"""
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(422, "バックアップファイル（JSON）を読み込めません")
    _validate(data)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"upload-{datetime.now():%Y%m%d-%H%M%S}.json"
    (BACKUP_DIR / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return {"name": name, "backup_created_at": data.get("created_at"), "server_backups": list_server_backups()}


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
