"""FastAPI プロジェクト管理ツール（ガントチャート）"""

import csv
import io
import json
import re
import sqlite3
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

import asyncio
from contextlib import asynccontextmanager

import auth
import backup
import cases
import documents
import groups
import links
import people
import platforms
import services
from csvutil import decode_csv, parse_date
import db as dbmod
from db import BASE_DIR, ensure_master, get_db

STATIC_DIR = BASE_DIR / "static"

PRIORITIES = ("高", "中", "低")
DEFAULT_AREAS = ("バイオインフォマティクス", "プロテオミクス", "メタボロミクス", "バイオマーカー分析", "トランスクリプトミクス")

# 選択肢マスタ: URL 名 -> (テーブル名, 表示名, [(使用件数を数える SQL, 使用先の名称)])
MASTERS = {
    "areas": ("areas", "領域", [
        ("SELECT COUNT(*) FROM tasks WHERE area = ?", "タスク"),
        ("SELECT COUNT(*) FROM cases WHERE EXISTS (SELECT 1 FROM json_each(cases.areas) WHERE value = ?)", "案件"),
        ("SELECT COUNT(*) FROM platforms WHERE EXISTS (SELECT 1 FROM json_each(platforms.areas) WHERE value = ?)", "基盤"),
        ("SELECT COUNT(*) FROM services WHERE EXISTS (SELECT 1 FROM json_each(services.areas) WHERE value = ?)", "サービス"),
        ("SELECT COUNT(*) FROM documents WHERE EXISTS (SELECT 1 FROM json_each(documents.areas) WHERE value = ?)", "共有資料"),
        ("SELECT COUNT(*) FROM ref_links WHERE EXISTS (SELECT 1 FROM json_each(ref_links.areas) WHERE value = ?)", "参考リンク"),
    ]),
    # ガントチャートの PJ名 = 案件番号（case_nos）または 基盤番号（platforms）
    "platforms": ("platforms", "基盤番号", [
        ("SELECT COUNT(*) FROM tasks WHERE project = ?", "タスク（PJ名）"),
        ("SELECT COUNT(*) FROM platform_goals WHERE platform = ?", "基盤の目標"),
        ("SELECT COUNT(*) FROM platform_topics WHERE platform = ?", "基盤のディスカッション"),
        ("SELECT COUNT(*) FROM platform_links WHERE platform = ?", "基盤の自由リンク"),
        ("SELECT COUNT(*) FROM platform_monthly WHERE platform = ?", "基盤の月報"),
        ("SELECT COUNT(*) FROM services WHERE EXISTS (SELECT 1 FROM json_each(services.platforms) WHERE value = ?)", "サービス"),
        ("SELECT COUNT(*) FROM team_groups WHERE EXISTS (SELECT 1 FROM json_each(team_groups.platforms) WHERE value = ?)", "グループ目標"),
    ]),
    "customers": ("customers", "企業名", [("SELECT COUNT(*) FROM cases WHERE customer = ?", "案件")]),
    "case_nos": ("case_nos", "案件番号", [
        ("SELECT COUNT(*) FROM cases WHERE case_no = ?", "案件"),
        ("SELECT COUNT(*) FROM tasks WHERE project = ?", "タスク（PJ名）"),
    ]),
}
MasterKind = Literal["areas", "platforms", "customers", "case_nos"]

CSV_HEADERS = ["id", "領域", "PJ名", "タスク", "担当者", "優先度", "開始日", "終了日", "詳細"]
# CSV インポート時に受け付ける列名（日本語 / 英語）
HEADER_ALIASES = {
    "id": "id", "ID": "id",
    "領域": "area", "area": "area",
    "PJ名": "project", "PJ": "project", "プロジェクト": "project", "プロジェクト名": "project", "project": "project",
    "タスク": "task", "task": "task", "name": "task",
    "担当者": "assignee", "assignee": "assignee",
    "優先度": "priority", "priority": "priority",
    "開始日": "start_date", "start_date": "start_date", "start": "start_date",
    "終了日": "end_date", "end_date": "end_date", "end": "end_date",
    "詳細": "detail", "説明": "detail", "detail": "detail", "description": "detail",
}

Priority = Literal["高", "中", "低"]
REPLACE_CONFIRM = "置き換え"
TASK_COLS = ("area", "project", "task", "assignee", "priority", "start_date", "end_date", "detail")


# ---------------------------------------------------------------- DB

def init_db() -> None:
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS areas (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS platforms (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                area       TEXT NOT NULL,
                project    TEXT NOT NULL DEFAULT '',
                task       TEXT NOT NULL,
                assignee   TEXT NOT NULL DEFAULT '',
                priority   TEXT NOT NULL DEFAULT '中',
                start_date TEXT NOT NULL,
                end_date   TEXT NOT NULL,
                detail     TEXT NOT NULL DEFAULT ''
            );
            """
        )
        # 旧バージョンの DB に列を追加
        cols = {r["name"] for r in db.execute("PRAGMA table_info(tasks)")}
        for col in ("project", "detail"):
            if col not in cols:
                db.execute(f"ALTER TABLE tasks ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")

        if dbmod.is_fresh_install() and db.execute("SELECT COUNT(*) FROM areas").fetchone()[0] == 0:
            db.executemany("INSERT INTO areas(name) VALUES (?)", [(a,) for a in DEFAULT_AREAS])
        if dbmod.sample_data_enabled() and db.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0:
            seed_sample_tasks(db)
            db.executemany("INSERT OR IGNORE INTO platforms(name) VALUES (?)", [("K-001",), ("K-002",)])


def seed_sample_tasks(db: sqlite3.Connection) -> None:
    t = date.today()
    d = lambda n: (t + timedelta(days=n)).isoformat()  # noqa: E731
    samples = [
        ("トランスクリプトミクス", "C-2026-002", "RNA-seq ライブラリ調製", "佐藤", "高", d(-10), d(-3),
         "対象: 24 検体（処理群 12 / 対照群 12）\nキット: TruSeq Stranded mRNA\nQC: Bioanalyzer で RIN ≥ 7 を確認"),
        ("トランスクリプトミクス", "C-2026-002", "発現変動解析", "佐藤", "高", d(-2), d(8)),
        ("プロテオミクス", "C-2026-001", "LC-MS/MS 測定", "鈴木", "中", d(1), d(12)),
        ("メタボロミクス", "C-2026-004", "代謝物抽出・測定", "高橋", "中", d(3), d(15)),
        ("バイオインフォマティクス", "C-2026-004", "マルチオミクス統合解析", "田中", "高", d(13), d(30)),
        ("バイオインフォマティクス", "K-001", "解析パイプライン構築", "田中", "低", d(0), d(20)),
        ("バイオマーカー分析", "C-2026-001", "候補マーカー選定", "鈴木", "中", d(16), d(28)),
        ("バイオマーカー分析", "C-2026-001", "検証実験", "高橋", "高", d(29), d(45)),
    ]
    samples = [s if len(s) == 8 else (*s, "") for s in samples]
    db.executemany(
        "INSERT INTO tasks(area, project, task, assignee, priority, start_date, end_date, detail)"
        " VALUES (?,?,?,?,?,?,?,?)",
        samples,
    )


def register_pj(db: sqlite3.Connection, name: str) -> None:
    """PJ名が案件番号・基盤番号のどちらにも無ければ基盤番号として登録（案件番号は案件管理で登録する）"""
    if not name:
        return
    if db.execute("SELECT 1 FROM case_nos WHERE name = ? UNION SELECT 1 FROM platforms WHERE name = ?",
                  (name, name)).fetchone() is None:
        ensure_master(db, "platforms", name)


def list_master(db: sqlite3.Connection, table: str) -> list[str]:
    return [r["name"] for r in db.execute(f"SELECT name FROM {table} ORDER BY id")]


# ---------------------------------------------------------------- Models

class TaskIn(BaseModel):
    area: str = Field(min_length=1)
    project: str = ""
    task: str = Field(min_length=1)
    assignee: str = ""  # 担当者（複数はスペース区切り）
    priority: Priority = "中"
    start_date: date
    end_date: date
    detail: str = ""

    @field_validator("assignee", mode="before")
    @classmethod
    def people(cls, v):
        """担当者はスペース区切りで複数（全角スペースも可。重複はまとめる）"""
        return " ".join(dict.fromkeys(n for n in re.split(r"[\s\u3000]+", v or "") if n)) if isinstance(v, str) else v

    @model_validator(mode="after")
    def check_dates(self):
        if self.end_date < self.start_date:
            raise ValueError("終了日は開始日以降にしてください")
        return self

    def values(self) -> tuple:
        return (self.area, self.project, self.task, self.assignee, self.priority,
                self.start_date.isoformat(), self.end_date.isoformat(), self.detail)


class MasterIn(BaseModel):
    name: str = Field(min_length=1)


def save_masters(db: sqlite3.Connection, t: TaskIn) -> None:
    ensure_master(db, "areas", t.area)
    register_pj(db, t.project)


# ---------------------------------------------------------------- App

# アップデート前の状態を残す: 既存データがあれば、起動のたび（テーブル更新の前）にバックアップを保存
if not dbmod.FRESH_DB:
    backup.save_startup_backup()

# テーブルの作成・更新（列の追加など。既存データは消さない）
MIGRATIONS = [init_db, cases.init_db, platforms.init_db, services.init_db, documents.init_db, links.init_db,
              groups.init_db, people.init_db]
for migrate in MIGRATIONS:
    migrate()
dbmod.finish_startup()
# 復元のあとにも同じ更新処理を実行する（古いバックアップを新しいアプリに取り込めるように）
backup.MIGRATIONS.extend(MIGRATIONS)
backup.LEGACY_UPGRADES["case_progress"] = ("case_notes", cases.LEGACY_NOTES_COPY)
backup.LEGACY_UPGRADES["platform_links"] = ("platforms", platforms.LEGACY_LINKS_COPY)


@asynccontextmanager
async def lifespan(_app):
    # 1 日 1 回、全データのバックアップをサーバーに自動保存
    task = asyncio.create_task(backup.auto_backup_loop())
    yield
    task.cancel()


app = FastAPI(title="ガントチャート プロジェクト管理", lifespan=lifespan)
app.include_router(cases.router)
app.include_router(platforms.router)
app.include_router(services.router)
app.include_router(documents.router)
app.include_router(links.router)
app.include_router(groups.router)
app.include_router(people.router)
app.include_router(auth.router)
app.include_router(backup.router)
# ログイン必須（/login と /static 以外。API は 401、画面はログイン画面へ転送）
app.middleware("http")(auth.require_login)


@app.middleware("http")
async def no_stale_cache(request, call_next):
    """画面・静的ファイルは毎回更新を確認させる（更新後に古い表示が残らないように）"""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/cases", include_in_schema=False)
def cases_page():
    return FileResponse(STATIC_DIR / "cases.html")


@app.get("/platforms", include_in_schema=False)
def platforms_page():
    return FileResponse(STATIC_DIR / "platforms.html")


@app.get("/services", include_in_schema=False)
def services_page():
    return FileResponse(STATIC_DIR / "services.html")


@app.get("/documents", include_in_schema=False)
def documents_page():
    return FileResponse(STATIC_DIR / "documents.html")


@app.get("/links", include_in_schema=False)
def links_page():
    return FileResponse(STATIC_DIR / "links.html")


@app.get("/groups", include_in_schema=False)
def groups_page():
    return FileResponse(STATIC_DIR / "groups.html")


@app.get("/people", include_in_schema=False)
def people_page():
    return FileResponse(STATIC_DIR / "people.html")


@app.get("/admin", include_in_schema=False)
def admin_page():
    return FileResponse(STATIC_DIR / "admin.html")


# ----- 選択肢マスタ（領域 / プロジェクト / 顧客 / 案件番号）

@app.get("/api/masters/{kind}")
def list_items(kind: MasterKind) -> list[str]:
    table, _, _ = MASTERS[kind]
    with get_db() as db:
        return list_master(db, table)


@app.get("/api/admin/masters")
def admin_masters() -> dict:
    """管理サイト用: 全マスタと、それぞれの使用件数"""
    result = {}
    with get_db() as db:
        for kind, (table, label, usages) in MASTERS.items():
            items = []
            for name in list_master(db, table):
                usage = {unit: db.execute(sql, (name,)).fetchone()[0] for sql, unit in usages}
                items.append({"name": name, "usage": {k: v for k, v in usage.items() if v}})
            result[kind] = {"label": label, "items": items}
    return result


@app.post("/api/masters/{kind}", status_code=201)
def add_item(kind: MasterKind, item: MasterIn) -> list[str]:
    table, label, _ = MASTERS[kind]
    name = item.name.strip()
    if not name:
        raise HTTPException(422, f"{label}を入力してください")
    with get_db() as db:
        if db.execute(f"SELECT 1 FROM {table} WHERE name = ?", (name,)).fetchone():
            raise HTTPException(409, f"{label}「{name}」は既に登録されています")
        if kind in ("case_nos", "platforms"):
            other = "platforms" if kind == "case_nos" else "case_nos"
            if db.execute(f"SELECT 1 FROM {other} WHERE name = ?", (name,)).fetchone():
                raise HTTPException(409, f"「{name}」は{MASTERS[other][1]}として登録済みです（PJ名が重複します）")
        ensure_master(db, table, name)
        return list_master(db, table)


# 名称変更時に書き換える参照先: (テーブル, 列, JSON 配列かどうか)
RENAME_TARGETS = {
    "areas": [("tasks", "area", False), ("cases", "areas", True), ("platforms", "areas", True), ("services", "areas", True),
              ("documents", "areas", True), ("ref_links", "areas", True)],
    "case_nos": [("cases", "case_no", False), ("tasks", "project", False)],
    "platforms": [("tasks", "project", False), ("platform_goals", "platform", False),
                  ("platform_topics", "platform", False), ("platform_monthly", "platform", False),
                  ("platform_links", "platform", False),
                  ("services", "platforms", True), ("team_groups", "platforms", True)],
    "customers": [("cases", "customer", False)],
}


@app.put("/api/masters/{kind}/{name}")
def rename_item(kind: MasterKind, name: str, item: MasterIn) -> list[str]:
    """名称変更。使用中のタスク・案件・基盤の目標なども新しい名前に書き換える。"""
    table, label, _ = MASTERS[kind]
    new = item.name.strip()
    if not new:
        raise HTTPException(422, f"{label}を入力してください")
    if new == name:
        with get_db() as db:
            return list_master(db, table)
    with get_db() as db:
        if db.execute(f"SELECT 1 FROM {table} WHERE name = ?", (name,)).fetchone() is None:
            raise HTTPException(404, f"{label}「{name}」は登録されていません")
        if db.execute(f"SELECT 1 FROM {table} WHERE name = ?", (new,)).fetchone():
            raise HTTPException(409, f"{label}「{new}」は既に登録されています")
        if kind in ("case_nos", "platforms"):
            other = "platforms" if kind == "case_nos" else "case_nos"
            if db.execute(f"SELECT 1 FROM {other} WHERE name = ?", (new,)).fetchone():
                raise HTTPException(409, f"「{new}」は{MASTERS[other][1]}として登録済みのため使えません（PJ名が重複します）")
        db.execute(f"UPDATE {table} SET name = ? WHERE name = ?", (new, name))
        for tbl, col, is_json in RENAME_TARGETS[kind]:
            if not is_json:
                db.execute(f"UPDATE {tbl} SET {col} = ? WHERE {col} = ?", (new, name))
                continue
            key = "rowid" if tbl != "platforms" else "id"
            for r in db.execute(f"SELECT {key} AS k, {col} AS v FROM {tbl}").fetchall():
                values = json.loads(r["v"] or "[]")
                if name in values:
                    values = [new if v == name else v for v in values]
                    db.execute(f"UPDATE {tbl} SET {col} = ? WHERE {key} = ?",
                               (json.dumps(list(dict.fromkeys(values)), ensure_ascii=False), r["k"]))
        return list_master(db, table)


@app.delete("/api/masters/{kind}/{name}")
def delete_item(kind: MasterKind, name: str) -> list[str]:
    table, label, usages = MASTERS[kind]
    with get_db() as db:
        for sql, unit in usages:
            used = db.execute(sql, (name,)).fetchone()[0]
            if used:
                raise HTTPException(409, f"{label}「{name}」は {used} 件の{unit}で使用中のため削除できません")
        db.execute(f"DELETE FROM {table} WHERE name = ?", (name,))
        return list_master(db, table)


# ----- タスク

# 並び順: 担当者の名前順（未設定は最後）→ 締切（終了日）の早い順 → 開始日 → ID
TASK_ORDER = "ORDER BY (t.assignee = ''), t.assignee, t.end_date, t.start_date, t.id"


@app.get("/api/tasks")
def list_tasks() -> list[dict]:
    with get_db() as db:
        return [dict(r) for r in db.execute(f"SELECT t.* FROM tasks t {TASK_ORDER}")]


def get_task(db: sqlite3.Connection, task_id: int) -> dict:
    return dict(db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())


INSERT_SQL = f"INSERT INTO tasks({', '.join(TASK_COLS)}) VALUES ({', '.join('?' * len(TASK_COLS))})"
UPDATE_SQL = f"UPDATE tasks SET {', '.join(c + '=?' for c in TASK_COLS)} WHERE id=?"


@app.post("/api/tasks", status_code=201)
def create_task(task: TaskIn) -> dict:
    with get_db() as db:
        save_masters(db, task)
        cur = db.execute(INSERT_SQL, task.values())
        return get_task(db, cur.lastrowid)


@app.put("/api/tasks/{task_id}")
def update_task(task_id: int, task: TaskIn) -> dict:
    with get_db() as db:
        save_masters(db, task)
        cur = db.execute(UPDATE_SQL, (*task.values(), task_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "タスクが見つかりません")
        return get_task(db, task_id)


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, confirm: str = "") -> Response:
    """誤削除防止のため、confirm に本日の日付（YYYYMMDD）を指定した場合のみ削除する。

    ブラウザとサーバーの日付境界のずれを考慮し、前後 1 日までは許容する。
    """
    digits = "".join(ch for ch in confirm if ch.isdigit())
    today = date.today()
    accepted = {(today + timedelta(days=n)).strftime("%Y%m%d") for n in (-1, 0, 1)}
    with get_db() as db:
        row = db.execute("SELECT task FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "タスクが見つかりません")
        if digits not in accepted:
            raise HTTPException(400, "確認用の日付が本日と一致しないため削除できません（例: 20260927）")
        db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    return Response(status_code=204)


# ----- CSV

@app.get("/api/export.csv")
def export_csv() -> Response:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_HEADERS)
    for t in list_tasks():
        writer.writerow([t["id"], *(t[c] for c in TASK_COLS)])
    # Excel で文字化けしないよう BOM 付き UTF-8
    body = buf.getvalue().encode("utf-8-sig")
    filename = f"tasks_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/import")
async def import_csv(
    file: UploadFile = File(...),
    mode: Literal["append", "replace"] = "append",
    confirm: str = "",
) -> dict:
    """CSV を取り込む。

    mode=append : id が既存タスクと一致すれば更新、それ以外は新規追加
    mode=replace: 既存タスクを全削除してから取り込み（confirm="置き換え" が必要）
    """
    if mode == "replace" and confirm != REPLACE_CONFIRM:
        raise HTTPException(400, f"置き換えを実行するには確認欄に「{REPLACE_CONFIRM}」と入力してください")
    text = decode_csv(await file.read())
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(422, "CSV にヘッダー行がありません")
    colmap = {h: HEADER_ALIASES.get(h.strip()) for h in reader.fieldnames}
    required = {"area", "task", "start_date", "end_date"}
    missing = required - set(colmap.values())
    if missing:
        labels = {"area": "領域", "task": "タスク", "start_date": "開始日", "end_date": "終了日"}
        raise HTTPException(422, "必須列がありません: " + ", ".join(labels[m] for m in sorted(missing)))

    rows: list[tuple[int | None, TaskIn]] = []
    for line, raw in enumerate(reader, start=2):
        rec = {colmap[k]: (v or "").strip() for k, v in raw.items() if k in colmap and colmap[k]}
        if not any(rec.values()):
            continue  # 空行
        priority = rec.get("priority") or "中"
        if priority not in PRIORITIES:
            raise HTTPException(422, f"{line} 行目: 優先度「{priority}」は 高/中/低 のいずれかにしてください")
        if not rec.get("area") or not rec.get("task"):
            raise HTTPException(422, f"{line} 行目: 領域とタスクは必須です")
        start = parse_date(rec.get("start_date", ""), line, "開始日")
        end = parse_date(rec.get("end_date", ""), line, "終了日")
        if end < start:
            raise HTTPException(422, f"{line} 行目: 終了日が開始日より前です")
        task_id = int(rec["id"]) if rec.get("id", "").isdigit() else None
        rows.append((task_id, TaskIn(area=rec["area"], project=rec.get("project", ""), task=rec["task"],
                                     assignee=rec.get("assignee", ""), priority=priority,
                                     start_date=start, end_date=end, detail=rec.get("detail", ""))))

    added = updated = 0
    with get_db() as db:
        if mode == "replace":
            db.execute("DELETE FROM tasks")
        for task_id, t in rows:
            save_masters(db, t)
            if task_id is not None and mode == "append":
                if db.execute(UPDATE_SQL, (*t.values(), task_id)).rowcount:
                    updated += 1
                    continue
            db.execute(INSERT_SQL, t.values())
            added += 1
    return {"added": added, "updated": updated, "mode": mode}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
