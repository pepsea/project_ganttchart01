"""案件管理 API"""

import csv
import io
import json
import re
import sqlite3
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from csvutil import decode_csv, parse_date

from db import DB_PATH, ensure_master, get_db, sample_data_enabled

router = APIRouter(prefix="/api/cases", tags=["案件管理"])

# アーカイブ = 終了した案件（カンバンの一番右）。状況を選び直せば元に戻せる
STATUSES = ("顧客開発", "打診", "見積提出", "契約中", "ブリーフィング前", "実施中", "QC", "アフターフォロー", "キャンセル",
            "アーカイブ")
Status = Literal[STATUSES]
URL_FIELDS = ("box_url", "teams_url", "overview_url", "plan_url")
FREE_LINK_COLS = ("link1_label", "link1_url", "link2_label", "link2_url")  # 自由リンク 2 つ（名前と URL）
CASE_COLS = ("case_no", "customer", "name", "status", "pl", "assignees", "areas",
             "start_date", "end_date", *URL_FIELDS, "detail", *FREE_LINK_COLS, "trial")


# ---------------------------------------------------------------- DB

def init_db() -> None:
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS cases (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                case_no      TEXT NOT NULL,              -- 同じ案件番号で試験が複数ある場合は、試験名（trial）で区別
                customer     TEXT NOT NULL DEFAULT '',
                name         TEXT NOT NULL,
                project      TEXT NOT NULL DEFAULT '',   -- 未使用（PJ名 = 案件番号）
                status       TEXT NOT NULL DEFAULT '顧客開発',
                pl           TEXT NOT NULL DEFAULT '',
                assignees    TEXT NOT NULL DEFAULT '',   -- スペース区切り
                areas        TEXT NOT NULL DEFAULT '[]', -- JSON 配列
                start_date   TEXT,
                end_date     TEXT,
                box_url      TEXT NOT NULL DEFAULT '',
                teams_url    TEXT NOT NULL DEFAULT '',
                overview_url TEXT NOT NULL DEFAULT '',
                plan_url     TEXT NOT NULL DEFAULT '',
                detail       TEXT NOT NULL DEFAULT '',   -- 案件詳細
                created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
            CREATE TABLE IF NOT EXISTS customers (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS case_nos (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS case_monthly (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
                month      TEXT NOT NULL,   -- YYYY-MM
                body       TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                UNIQUE (case_id, month)
            );
            CREATE TABLE IF NOT EXISTS case_notes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
                week       TEXT NOT NULL,   -- その週の月曜日
                body       TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                UNIQUE (case_id, week)
            );
            """
        )
        # 進捗メモ（日付ごと。同じ日に複数可）。旧・週次進捗メモ（case_notes）は初回だけ引き継ぎ、以後は未使用として残す
        has_progress = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_progress'").fetchone()
        db.execute("""CREATE TABLE IF NOT EXISTS case_progress (
                          id         INTEGER PRIMARY KEY AUTOINCREMENT,
                          case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
                          note_date  TEXT NOT NULL,   -- 日付（YYYY-MM-DD）
                          body       TEXT NOT NULL,
                          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                      )""")
        if not has_progress:
            db.execute(LEGACY_NOTES_COPY)
        cols = {r["name"] for r in db.execute("PRAGMA table_info(cases)")}
        for col in ("project", "detail", *FREE_LINK_COLS, "trial"):  # trial = 試験名（同じ案件番号の案件を区別）
            if col not in cols:
                db.execute(f"ALTER TABLE cases ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        if sample_data_enabled() and db.execute("SELECT COUNT(*) FROM cases").fetchone()[0] == 0:
            seed_sample_cases(db)
        # 既存の案件から顧客・案件番号のマスタを補完
        db.execute("INSERT OR IGNORE INTO customers(name) SELECT DISTINCT customer FROM cases WHERE customer <> ''")
        db.execute("INSERT OR IGNORE INTO case_nos(name) SELECT case_no FROM cases ORDER BY case_no")
        # ガントチャートの PJ名は案件番号か基盤番号。どちらにも無い既存タスクの PJ名は基盤番号として登録
        db.execute("""INSERT OR IGNORE INTO platforms(name)
                      SELECT DISTINCT project FROM tasks
                      WHERE project <> '' AND project NOT IN (SELECT name FROM case_nos)""")
    allow_same_case_no()  # 同じ案件番号の案件を複数登録できるようにする（1 回だけ）


# 旧・週次進捗メモ（case_notes）→ 進捗メモ（case_progress）の引き継ぎ（backup.py の復元でも使う）
LEGACY_NOTES_COPY = """INSERT INTO case_progress(case_id, note_date, body, created_at, updated_at)
                       SELECT case_id, week, body, updated_at, updated_at FROM case_notes ORDER BY case_id, week"""


def allow_same_case_no() -> None:
    """同じ案件番号の案件を複数登録できるよう、case_no の UNIQUE 制約を外す（1 回だけ・冪等）。
    列とデータはそのまま。SQLite は制約だけを外せないため、同じ列の表を作り直して全行を写す。
    （関連する進捗メモ・月報が連鎖削除されないよう、外部キーを止めて 1 つのトランザクションで行う）"""
    conn = sqlite3.connect(DB_PATH, isolation_level=None)
    try:
        unique = [r for r in conn.execute("PRAGMA index_list(cases)") if r[2] and r[3] == "u"]
        if not any([c[2] for c in conn.execute(f"PRAGMA index_info('{r[1]}')")] == ["case_no"] for r in unique):
            return
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='cases'").fetchone()[0]
        new_sql = re.sub(r"(case_no\s+TEXT\s+NOT\s+NULL)\s+UNIQUE", r"\1", sql, count=1)
        new_sql = re.sub(r"^CREATE TABLE\s+\"?cases\"?", "CREATE TABLE cases_new", new_sql, count=1)
        if new_sql == sql or "UNIQUE" in re.search(r"case_no[^,]*", new_sql).group(0):
            raise RuntimeError("cases テーブルの定義を読み取れませんでした")
        before = conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0]
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN")
        try:
            conn.execute(new_sql)
            conn.execute("INSERT INTO cases_new SELECT * FROM cases")
            conn.execute("DROP TABLE cases")
            conn.execute("ALTER TABLE cases_new RENAME TO cases")
            after = conn.execute("SELECT COUNT(*) FROM cases").fetchone()[0]
            if after != before or conn.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("案件の件数・関連データの確認に失敗しました")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def seed_sample_cases(db: sqlite3.Connection) -> None:
    t = date.today()
    d = lambda n: (t + timedelta(days=n)).isoformat()  # noqa: E731
    w = lambda n: (t + timedelta(weeks=n)).isoformat()  # noqa: E731
    samples = [
        ("C-2026-001", "A製薬", "血漿プロテオーム解析", "実施中", "佐藤", "鈴木 高橋",
         ["プロテオミクス", "バイオマーカー分析"], d(-40), d(25),
         [(w(-2), "サンプル受領（96 検体）。前処理プロトコル確定。"),
          (w(-1), "LC-MS/MS 測定 50% 完了。QC サンプルの CV 良好。")]),
        ("C-2026-002", "Bバイオ", "RNA-seq 受託解析", "QC", "田中", "佐藤",
         ["トランスクリプトミクス", "バイオインフォマティクス"], d(-60), d(5),
         [(w(-1), "解析完了。レポートのダブルチェック中。")]),
        ("C-2026-003", "C大学", "代謝物プロファイリング", "見積提出", "鈴木", "",
         ["メタボロミクス"], None, None, []),
        ("C-2026-004", "D食品", "機能性成分のマルチオミクス解析", "ブリーフィング前", "高橋", "田中 鈴木",
         ["メタボロミクス", "トランスクリプトミクス"], d(10), d(90), []),
        ("C-2026-005", "E製薬", "新規バイオマーカー探索", "打診", "佐藤", "",
         ["バイオマーカー分析"], None, None, []),
        ("C-2026-006", "F研究所", "単一細胞解析", "顧客開発", "田中", "", ["トランスクリプトミクス"], None, None, []),
    ]
    for no, cust, name, status, pl, members, areas, start, end, notes in samples:
        cur = db.execute(
            "INSERT INTO cases(case_no, customer, name, status, pl, assignees, areas, start_date, end_date)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (no, cust, name, status, pl, members, json.dumps(areas, ensure_ascii=False), start, end),
        )
        if no == "C-2026-001":
            db.execute(
                "UPDATE cases SET detail = ? WHERE id = ?",
                ("目的: 血漿中タンパク質の網羅的定量による疾患関連マーカー候補の抽出\n"
                 "検体: 血漿 96 検体（患者 48 / 健常 48）\n手法: DIA-MS、2 反復測定\n納品物: 定量データ、統計解析レポート",
                 cur.lastrowid))
            db.execute("INSERT INTO case_monthly(case_id, month, body) VALUES (?,?,?)",
                       (cur.lastrowid, (t.replace(day=1) - timedelta(days=1)).strftime("%Y-%m"),
                        "サンプル受領・前処理条件の検討を実施。測定開始に向けた準備が完了。"))
        for day, body in notes:
            db.execute("INSERT INTO case_progress(case_id, note_date, body) VALUES (?,?,?)", (cur.lastrowid, day, body))
    # 未使用の案件番号・顧客（選択肢のサンプル）
    for no in ("C-2026-001", "C-2026-002", "C-2026-003", "C-2026-004", "C-2026-005", "C-2026-006",
               "C-2026-007", "C-2026-008"):
        ensure_master(db, "case_nos", no)
    ensure_master(db, "customers", "G病院")


# ---------------------------------------------------------------- Models

def normalize_people(v: str) -> str:
    """半角・全角スペース区切りの担当者を 1 つの半角スペース区切りに正規化"""
    names = [n for n in re.split(r"[\s　]+", v or "") if n]
    return " ".join(dict.fromkeys(names))  # 重複除去（順序維持）


class CaseIn(BaseModel):
    case_no: str = Field(min_length=1)
    customer: str = ""
    name: str = Field(min_length=1)
    detail: str = ""
    status: Status = "顧客開発"
    pl: str = ""
    assignees: str = ""
    areas: list[str] = []
    start_date: date | None = None
    end_date: date | None = None
    box_url: str = ""
    teams_url: str = ""
    overview_url: str = ""
    plan_url: str = ""
    link1_label: str = ""  # 自由リンク 1 の名前
    link1_url: str = ""
    link2_label: str = ""  # 自由リンク 2 の名前
    link2_url: str = ""
    trial: str = ""        # 試験名（同じ案件番号で試験が複数あるときに区別する）

    @field_validator("case_no", "customer", "name", "pl", "link1_label", "link2_label", "trial", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("assignees", mode="before")
    @classmethod
    def people(cls, v):
        return normalize_people(v) if isinstance(v, str) else v

    @field_validator("areas")
    @classmethod
    def uniq_areas(cls, v: list[str]):
        return list(dict.fromkeys(a.strip() for a in v if a.strip()))

    @field_validator(*URL_FIELDS, "link1_url", "link2_url", mode="before")
    @classmethod
    def check_url(cls, v):
        v = (v or "").strip()
        if v and not re.match(r"^https?://", v, re.I):
            raise ValueError("リンクは http:// または https:// で始まる URL を入力してください")
        return v

    @model_validator(mode="after")
    def check_dates(self):
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("終了予定日は開始日以降にしてください")
        return self

    def values(self) -> tuple:
        return (self.case_no, self.customer, self.name, self.status, self.pl, self.assignees,
                json.dumps(self.areas, ensure_ascii=False),
                self.start_date.isoformat() if self.start_date else None,
                self.end_date.isoformat() if self.end_date else None,
                self.box_url, self.teams_url, self.overview_url, self.plan_url, self.detail.strip(),
                self.link1_label, self.link1_url, self.link2_label, self.link2_url, self.trial)


class StatusIn(BaseModel):
    status: Status


class MonthlyIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    body: str = Field(min_length=1)


class NoteIn(BaseModel):
    note_date: date = Field(default_factory=date.today)  # 省略時は今日
    body: str = Field(min_length=1)

    @field_validator("body", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v


# ---------------------------------------------------------------- helpers

CASE_SELECT = """
    SELECT c.*,
           (SELECT COUNT(*) FROM case_progress n WHERE n.case_id = c.id) AS note_count,
           (SELECT note_date FROM case_progress n WHERE n.case_id = c.id
             ORDER BY note_date DESC, id DESC LIMIT 1) AS last_note_date,
           (SELECT body FROM case_progress n WHERE n.case_id = c.id
             ORDER BY note_date DESC, id DESC LIMIT 1) AS last_note,
           (SELECT month FROM case_monthly m WHERE m.case_id = c.id ORDER BY month DESC LIMIT 1) AS last_month,
           (SELECT COUNT(*) FROM tasks t WHERE t.project = c.case_no) AS task_count
    FROM cases c
"""


def to_case(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["areas"] = json.loads(d["areas"] or "[]")
    return d


def fetch_case(db: sqlite3.Connection, case_id: int) -> dict:
    row = db.execute(f"{CASE_SELECT} WHERE c.id = ?", (case_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "案件が見つかりません")
    return to_case(row)


def case_label(case_no: str, trial: str) -> str:
    if not trial:
        return case_no
    return f"{case_no}-{trial}" if trial.isdigit() else f"{case_no}（{trial}）"


def auto_trial(db: sqlite3.Connection, c: "CaseIn", exclude_id: int | None = None) -> None:
    """同じ案件番号の案件があり、試験名が空欄なら、次の番号（2, 3, …）を試験名に自動で付ける。
    最初の案件（試験名が空欄）は 1 番として数える"""
    if c.trial:
        return
    rows = db.execute("SELECT trial FROM cases WHERE case_no = ? AND id <> ?", (c.case_no, exclude_id or 0)).fetchall()
    if not rows:
        return
    used = {1 if not r["trial"] else int(r["trial"]) for r in rows if not r["trial"] or r["trial"].isdigit()}
    n = 2
    while n in used:
        n += 1
    c.trial = str(n)


def check_duplicate(db: sqlite3.Connection, c: "CaseIn", exclude_id: int | None = None) -> None:
    """同じ案件番号は複数登録できるが、案件番号と試験名の組み合わせは重ならないようにする"""
    row = db.execute("SELECT id FROM cases WHERE case_no = ? AND trial = ? AND id <> ?",
                     (c.case_no, c.trial, exclude_id or 0)).fetchone()
    if row:
        if c.trial:
            raise HTTPException(409, f"案件番号「{c.case_no}」の試験「{c.trial}」は既に登録されています")
        raise HTTPException(409, f"案件番号「{c.case_no}」は既に登録されています。同じ番号で別の試験を登録するときは「試験名」を入力してください")


def write_case(db: sqlite3.Connection, sql: str, params: tuple, case_no: str):
    try:
        return db.execute(sql, params)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"案件番号「{case_no}」は既に登録されています")


# ---------------------------------------------------------------- 案件

@router.get("")
def list_cases() -> list[dict]:
    with get_db() as db:
        rows = db.execute(f"{CASE_SELECT} ORDER BY COALESCE(c.end_date, '9999-12-31'), c.case_no")
        return [to_case(r) for r in rows]


@router.get("/statuses")
def list_statuses() -> list[str]:
    return list(STATUSES)


# エクスポートの基本列（月報・進捗メモの列はこの後ろに日付ごとに並ぶ）
EXPORT_HEADERS = ["案件番号", "試験名", "状況", "顧客名", "案件名", "PL", "担当者", "領域", "開始日", "終了予定日",
                  "BOXリンク", "Teamsリンク", "案件概要書リンク", "試験計画書リンク", "案件詳細",
                  "自由リンク1の名前", "自由リンク1", "自由リンク2の名前", "自由リンク2"]
# 日付パターンの列名: 月報_YYYY-MM / 進捗_YYYY-MM-DD（旧形式の 週次_YYYY-MM-DD も読み込める）
MONTH_COL = re.compile(r"^月報_(\d{4})[-/](\d{1,2})$")
NOTE_COL = re.compile(r"^(?:進捗|週次)_(\d{4}[-/]\d{1,2}[-/]\d{1,2})$")
NOTE_SEP = "\n\n"  # 同じ日の進捗メモが複数あるときは空行でつないで 1 セルにする


def _notes_by_day(db: sqlite3.Connection, case_id: int | None = None) -> dict[tuple[int, str], str]:
    sql = "SELECT case_id, note_date, body FROM case_progress"
    rows = db.execute(sql + (" WHERE case_id = ?" if case_id else "") + " ORDER BY id", (case_id,) if case_id else ())
    out: dict[tuple[int, str], list[str]] = {}
    for r in rows:
        out.setdefault((r["case_id"], r["note_date"]), []).append(r["body"])
    return {k: NOTE_SEP.join(v) for k, v in out.items()}


def _import_note(db: sqlite3.Connection, case_id: int, day: str, body: str) -> bool:
    """その日の進捗メモを CSV の内容にそろえる（同じ内容なら何もしない）。変更したら True"""
    if _notes_by_day(db, case_id).get((case_id, day)) == body:
        return False
    db.execute("DELETE FROM case_progress WHERE case_id = ? AND note_date = ?", (case_id, day))
    db.execute("INSERT INTO case_progress(case_id, note_date, body) VALUES (?,?,?)", (case_id, day, body))
    return True


@router.get("/export.csv")
def export_csv() -> Response:
    """全案件を 1 案件 1 行で出力。月報・進捗メモはすべて日付ごとの列に展開する（新しい順）。"""
    cases = list_cases()
    with get_db() as db:
        notes = _notes_by_day(db)
        monthly = {(r["case_id"], r["month"]): r["body"]
                   for r in db.execute("SELECT case_id, month, body FROM case_monthly")}
    months = sorted({m for _, m in monthly}, reverse=True)
    weeks = sorted({w for _, w in notes}, reverse=True)

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([*EXPORT_HEADERS, *(f"月報_{m}" for m in months), *(f"進捗_{wk}" for wk in weeks)])
    for c in cases:
        w.writerow([c["case_no"], c["trial"], c["status"], c["customer"], c["name"], c["pl"], c["assignees"],
                    " ".join(c["areas"]), c["start_date"] or "", c["end_date"] or "",
                    c["box_url"], c["teams_url"], c["overview_url"], c["plan_url"], c["detail"],
                    c["link1_label"], c["link1_url"], c["link2_label"], c["link2_url"],
                    *(monthly.get((c["id"], m), "") for m in months),
                    *(notes.get((c["id"], wk), "") for wk in weeks)])
    filename = f"cases_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return Response(buf.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def save_case_masters(db: sqlite3.Connection, c: CaseIn) -> None:
    for a in c.areas:
        ensure_master(db, "areas", a)
    ensure_master(db, "customers", c.customer)
    ensure_master(db, "case_nos", c.case_no)


# CSV の列名 -> 項目名（エクスポートと同じ列名。英語名も可）
IMPORT_ALIASES = {
    "案件番号": "case_no", "case_no": "case_no",
    "状況": "status", "status": "status",
    "顧客名": "customer", "顧客": "customer", "customer": "customer",
    "案件名": "name", "name": "name",
    "試験名": "trial", "試験": "trial", "trial": "trial",
    "PL": "pl", "pl": "pl",
    "担当者": "assignees", "assignees": "assignees",
    "領域": "areas", "areas": "areas",
    "開始日": "start_date", "start_date": "start_date",
    "終了予定日": "end_date", "終了日": "end_date", "end_date": "end_date",
    "BOXリンク": "box_url", "BOX": "box_url", "box_url": "box_url",
    "Teamsリンク": "teams_url", "Teams": "teams_url", "teams_url": "teams_url",
    "案件概要書リンク": "overview_url", "案件概要書": "overview_url", "overview_url": "overview_url",
    "試験計画書リンク": "plan_url", "試験計画書": "plan_url", "plan_url": "plan_url",
    "案件詳細": "detail", "detail": "detail",
    "自由リンク1の名前": "link1_label", "自由リンク1": "link1_url", "自由リンク2の名前": "link2_label", "自由リンク2": "link2_url",
    "最新進捗週": "note_week", "最新進捗メモ": "note_body",  # 旧形式
}


@router.post("/import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """案件 CSV を取り込む（案件番号と試験名が一致すれば更新、なければ追加）。

    - 既存案件の更新時、CSV に無い列・空欄のセルは既存の値を保持する（誤って消さないため）
    - 「月報_YYYY-MM」「進捗_YYYY-MM-DD」列の内容を月報・進捗メモとして登録（同じ月・日は上書き、空欄は変更なし）
    - 旧形式の「週次_YYYY-MM-DD」列は、その日付の進捗メモとして登録
    - 旧形式の「最新進捗週」「最新進捗メモ」列にも対応
    - 1 行でもエラーがあれば全体を取り込まない
    """
    reader = csv.DictReader(io.StringIO(decode_csv(await file.read())))
    if not reader.fieldnames:
        raise HTTPException(422, "CSV にヘッダー行がありません")
    colmap = {h: IMPORT_ALIASES.get(h.strip()) for h in reader.fieldnames}
    # 日付パターンの列（月報・進捗）
    log_cols: dict[str, tuple[str, str]] = {}
    for h in reader.fieldnames:
        if m := MONTH_COL.match(h.strip()):
            y, mo = int(m.group(1)), int(m.group(2))
            if not 1 <= mo <= 12:
                raise HTTPException(422, f"列名「{h}」の月が正しくありません")
            log_cols[h] = ("month", f"{y:04d}-{mo:02d}")
        elif m := NOTE_COL.match(h.strip()):
            log_cols[h] = ("note", parse_date(m.group(1), 1, f"列名「{h}」の日付").isoformat())
    missing = {"case_no", "name"} - set(colmap.values())
    if missing:
        raise HTTPException(422, "必須列がありません: " + ", ".join({"case_no": "案件番号", "name": "案件名"}[m] for m in sorted(missing)))

    added = updated = notes = reports = 0
    with get_db() as db:
        seen: set[tuple[str, str]] = set()
        for line, raw in enumerate(reader, start=2):
            rec = {colmap[k]: (v or "").strip() for k, v in raw.items() if k in colmap and colmap[k]}
            if not any(rec.values()):
                continue  # 空行
            no = rec.get("case_no", "")
            if not no:
                raise HTTPException(422, f"{line} 行目: 案件番号は必須です")
            trial = rec.get("trial", "")
            if (no, trial) in seen:
                raise HTTPException(422, f"{line} 行目: 案件「{case_label(no, trial)}」が CSV 内で重複しています")
            seen.add((no, trial))
            if "status" in rec and rec["status"] and rec["status"] not in STATUSES:
                raise HTTPException(422, f"{line} 行目: 状況「{rec['status']}」は次のいずれかにしてください: {'、'.join(STATUSES)}")

            row = db.execute("SELECT * FROM cases WHERE case_no = ? AND trial = ?", (no, trial)).fetchone()
            data = to_case(row) if row else {}
            data = {k: data.get(k) for k in CASE_COLS if k in data}
            for key in CASE_COLS:
                if key not in rec or (row and not rec[key]):
                    continue
                v = rec[key]
                if key == "areas":
                    data[key] = [a for a in re.split(r"[\s\u3000;；、,/／]+", v) if a]
                elif key in ("start_date", "end_date"):
                    label = "開始日" if key == "start_date" else "終了予定日"
                    data[key] = parse_date(v, line, label).isoformat() if v else None
                elif key == "status":
                    data[key] = v or data.get("status") or "顧客開発"
                else:
                    data[key] = v
            try:
                c = CaseIn(**data)
            except ValidationError as e:
                msg = "; ".join(err["msg"].replace("Value error, ", "") for err in e.errors())
                raise HTTPException(422, f"{line} 行目（{no}）: {msg}")

            save_case_masters(db, c)
            if row:
                db.execute(f"UPDATE cases SET {', '.join(k + '=?' for k in CASE_COLS)},"
                           " updated_at = datetime('now', 'localtime') WHERE id = ?", (*c.values(), row["id"]))
                case_id = row["id"]
                updated += 1
            else:
                case_id = db.execute(
                    f"INSERT INTO cases({', '.join(CASE_COLS)}) VALUES ({', '.join('?' * len(CASE_COLS))})",
                    c.values()).lastrowid
                added += 1

            if rec.get("note_week") and rec.get("note_body"):
                day = parse_date(rec["note_week"], line, "最新進捗週").isoformat()
                _import_note(db, case_id, day, rec["note_body"])
                notes += 1

            for h, (kind, key) in log_cols.items():
                body = (raw.get(h) or "").strip()
                if not body:
                    continue
                if kind == "month":
                    db.execute(
                        """INSERT INTO case_monthly(case_id, month, body) VALUES (?,?,?)
                           ON CONFLICT(case_id, month) DO UPDATE
                           SET body = excluded.body, updated_at = datetime('now', 'localtime')
                           WHERE body <> excluded.body""",
                        (case_id, key, body))
                    reports += 1
                else:
                    _import_note(db, case_id, key, body)
                    notes += 1
    return {"added": added, "updated": updated, "notes": notes, "monthly": reports}


@router.post("", status_code=201)
def create_case(c: CaseIn) -> dict:
    with get_db() as db:
        auto_trial(db, c)
        check_duplicate(db, c)
        save_case_masters(db, c)
        cur = write_case(
            db,
            f"INSERT INTO cases({', '.join(CASE_COLS)}) VALUES ({', '.join('?' * len(CASE_COLS))})",
            c.values(), c.case_no,
        )
        return fetch_case(db, cur.lastrowid)


@router.put("/{case_id}")
def update_case(case_id: int, c: CaseIn) -> dict:
    with get_db() as db:
        fetch_case(db, case_id)
        auto_trial(db, c, case_id)
        check_duplicate(db, c, case_id)
        save_case_masters(db, c)
        write_case(
            db,
            f"UPDATE cases SET {', '.join(k + '=?' for k in CASE_COLS)},"
            " updated_at = datetime('now', 'localtime') WHERE id = ?",
            (*c.values(), case_id), c.case_no,
        )
        return fetch_case(db, case_id)


@router.patch("/{case_id}/status")
def update_status(case_id: int, s: StatusIn) -> dict:
    with get_db() as db:
        fetch_case(db, case_id)
        db.execute("UPDATE cases SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
                   (s.status, case_id))
        return fetch_case(db, case_id)


@router.delete("/{case_id}", status_code=204)
def delete_case(case_id: int, confirm: str = "") -> Response:
    """誤削除防止のため、confirm に案件番号を正確に指定した場合のみ削除する。"""
    with get_db() as db:
        c = fetch_case(db, case_id)
        if confirm != c["case_no"]:
            raise HTTPException(400, "確認用の案件番号が一致しないため削除できません")
        db.execute("DELETE FROM cases WHERE id = ?", (case_id,))
    return Response(status_code=204)


# ---------------------------------------------------------------- 進捗メモ（日付ごと。同じ日に複数可）

@router.get("/{case_id}/notes")
def list_notes(case_id: int) -> list[dict]:
    with get_db() as db:
        fetch_case(db, case_id)
        rows = db.execute("SELECT * FROM case_progress WHERE case_id = ? ORDER BY note_date DESC, id DESC", (case_id,))
        return [dict(r) for r in rows]


@router.post("/{case_id}/notes", status_code=201)
def add_note(case_id: int, n: NoteIn) -> dict:
    with get_db() as db:
        fetch_case(db, case_id)
        cur = db.execute("INSERT INTO case_progress(case_id, note_date, body) VALUES (?,?,?)",
                         (case_id, n.note_date.isoformat(), n.body))
        return dict(db.execute("SELECT * FROM case_progress WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{case_id}/notes/{note_id}")
def update_note(case_id: int, note_id: int, n: NoteIn) -> dict:
    with get_db() as db:
        cur = db.execute("UPDATE case_progress SET note_date = ?, body = ?, updated_at = datetime('now', 'localtime')"
                         " WHERE id = ? AND case_id = ?", (n.note_date.isoformat(), n.body, note_id, case_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "進捗メモが見つかりません")
        return dict(db.execute("SELECT * FROM case_progress WHERE id = ?", (note_id,)).fetchone())


@router.delete("/{case_id}/notes/{note_id}", status_code=204)
def delete_note(case_id: int, note_id: int) -> Response:
    with get_db() as db:
        cur = db.execute("DELETE FROM case_progress WHERE id = ? AND case_id = ?", (note_id, case_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "進捗メモが見つかりません")
    return Response(status_code=204)


# ---------------------------------------------------------------- 月報

@router.get("/{case_id}/monthly")
def list_monthly(case_id: int) -> list[dict]:
    with get_db() as db:
        fetch_case(db, case_id)
        rows = db.execute("SELECT * FROM case_monthly WHERE case_id = ? ORDER BY month DESC", (case_id,))
        return [dict(r) for r in rows]


@router.put("/{case_id}/monthly")
def upsert_monthly(case_id: int, m: MonthlyIn) -> dict:
    """月（YYYY-MM）ごとに 1 件。既にあれば上書き。"""
    with get_db() as db:
        fetch_case(db, case_id)
        db.execute(
            """INSERT INTO case_monthly(case_id, month, body) VALUES (?,?,?)
               ON CONFLICT(case_id, month) DO UPDATE
               SET body = excluded.body, updated_at = datetime('now', 'localtime')""",
            (case_id, m.month, m.body.strip()),
        )
        return dict(db.execute("SELECT * FROM case_monthly WHERE case_id = ? AND month = ?",
                               (case_id, m.month)).fetchone())


@router.delete("/{case_id}/monthly/{report_id}", status_code=204)
def delete_monthly(case_id: int, report_id: int) -> Response:
    with get_db() as db:
        cur = db.execute("DELETE FROM case_monthly WHERE id = ? AND case_id = ?", (report_id, case_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "月報が見つかりません")
    return Response(status_code=204)
