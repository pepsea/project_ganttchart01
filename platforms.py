"""基盤技術 API: 基盤ごとの全体目標・目標（マイルストーン）・ディスカッション・月報を管理する。

基盤は領域ごとに管理する（1 つの基盤が複数の領域にまたがる。areas 列に JSON 配列）。PL は owner 列に保存する。

基盤番号そのものの登録・削除は管理サイト（/api/masters/platforms）で行う。
基盤のタスクはガントチャートのタスク（PJ名 = 基盤番号）を使う。
"""

import asyncio
import csv
import io
import json
import re
import sqlite3
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field, field_validator

import auth
from csvutil import decode_csv, parse_date
from db import ensure_master, get_db, sample_data_enabled

router = APIRouter(prefix="/api/platforms", tags=["基盤技術"])

GOAL_STATUSES = ("未着手", "取組中", "達成", "保留")
GoalStatus = Literal[GOAL_STATUSES]
INFO_COLS = ("title", "areas", "owner", "members", "vision")


# ---------------------------------------------------------------- DB

def init_db() -> None:
    with get_db() as db:
        db.execute("CREATE TABLE IF NOT EXISTS platforms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)")
        # 自由リンク（何個でも）。旧・自由リンク 1 つ（platforms.link_label / link_url）は初回だけ引き継ぎ、以後は未使用
        has_links = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_links'").fetchone()
        db.execute("""CREATE TABLE IF NOT EXISTS platform_links (
                          id         INTEGER PRIMARY KEY AUTOINCREMENT,
                          platform   TEXT NOT NULL,             -- 基盤番号（platforms.name）
                          label      TEXT NOT NULL DEFAULT '',  -- リンクの名前
                          url        TEXT NOT NULL,
                          sort_order INTEGER NOT NULL DEFAULT 0,
                          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                      )""")
        cols = {r["name"] for r in db.execute("PRAGMA table_info(platforms)")}
        for col, default in [("title", "''"), ("owner", "''"), ("members", "''"), ("areas", "'[]'"),
                             ("vision", "''"), ("updated_at", "''"), ("area", "''"),
                             ("plan_url", "''"), ("box_url", "''"), ("teams_url", "''"),  # 研究計画・BOX・Teams のリンク
                             ("link_label", "''"), ("link_url", "''")]:  # 自由リンク（名前と URL）
            if col not in cols:
                db.execute(f"ALTER TABLE platforms ADD COLUMN {col} TEXT NOT NULL DEFAULT {default}")
        if "sort_order" not in cols:  # 基盤一覧の並び順（手で入れ替える。0 = 未設定 → 最後に並べる）
            db.execute("ALTER TABLE platforms ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        # 一時期の単一領域（area 列）を複数領域（areas）へ引き継ぐ
        for r in db.execute("SELECT id, area FROM platforms WHERE area <> '' AND areas IN ('', '[]')").fetchall():
            db.execute("UPDATE platforms SET areas = ? WHERE id = ?", (json.dumps([r["area"]], ensure_ascii=False), r["id"]))
        db.execute(
            """CREATE TABLE IF NOT EXISTS platform_goals (
                   id         INTEGER PRIMARY KEY AUTOINCREMENT,
                   platform   TEXT NOT NULL,          -- 基盤番号
                   title      TEXT NOT NULL,
                   due_date   TEXT,
                   status     TEXT NOT NULL DEFAULT '未着手',
                   note       TEXT NOT NULL DEFAULT '',
                   created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )
        goal_cols = {r["name"] for r in db.execute("PRAGMA table_info(platform_goals)")}
        if "url" not in goal_cols:  # 目標のリンク
            db.execute("ALTER TABLE platform_goals ADD COLUMN url TEXT NOT NULL DEFAULT ''")
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS platform_topics (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                platform     TEXT NOT NULL,        -- 基盤番号
                meeting_date TEXT NOT NULL,        -- ディスカッションの日付
                title        TEXT NOT NULL,        -- トピック
                body         TEXT NOT NULL DEFAULT '',  -- 内容・決定事項・宿題
                created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
            CREATE TABLE IF NOT EXISTS platform_monthly (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                platform   TEXT NOT NULL,
                month      TEXT NOT NULL,          -- YYYY-MM
                body       TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                UNIQUE (platform, month)
            );
            """
        )
        if sample_data_enabled() and db.execute("SELECT COUNT(*) FROM platform_goals").fetchone()[0] == 0 and \
                db.execute("SELECT COUNT(*) FROM platforms WHERE title <> ''").fetchone()[0] == 0:
            seed_samples(db)
        if not has_links:
            db.execute(LEGACY_LINKS_COPY)
        fill_sort_order(db)


def seed_samples(db: sqlite3.Connection) -> None:
    t = date.today()
    d = lambda n: (t + timedelta(days=n)).isoformat()  # noqa: E731
    samples = {
        "K-001": ("解析パイプライン基盤", "田中", "佐藤 鈴木", ["バイオインフォマティクス", "トランスクリプトミクス"],
                  "RNA-seq・プロテオーム・メタボロームの解析を共通パイプラインで実行できるようにし、"
                  "受託解析の納期を 30% 短縮する。\n再現性（バージョン管理・実行ログ）を標準で担保する。",
                  [("RNA-seq パイプラインの標準化", d(-20), "達成", "nf-core ベースで構築済み"),
                   ("プロテオーム解析の自動化", d(30), "取組中", "DIA データに対応"),
                   ("解析レポートの自動生成", d(75), "未着手", ""),
                   ("社内ユーザー向けマニュアル整備", d(90), "未着手", "")]),
        "K-002": ("LC-MS 前処理自動化基盤", "鈴木", "高橋", ["プロテオミクス", "メタボロミクス"],
                  "血漿・組織サンプルの前処理を自動化し、1 日あたりの処理検体数を 2 倍にする。",
                  [("分注ロボットの条件検討", d(-5), "取組中", "期限超過・要見直し"),
                   ("前処理プロトコルの SOP 化", d(45), "未着手", "")]),
    }
    last_month = (t.replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
    for no, (title, owner, members, areas, vision, goals) in samples.items():
        ensure_master(db, "platforms", no)
        db.execute(
            "UPDATE platforms SET title=?, areas=?, owner=?, members=?, vision=?, updated_at=datetime('now','localtime')"
            " WHERE name=?",
            (title, json.dumps(areas, ensure_ascii=False), owner, members, vision, no),
        )
        db.execute("INSERT INTO platform_topics(platform, meeting_date, title, body) VALUES (?,?,?,?)",
                   (no, d(-7), "今期の優先順位の確認", "決定: 自動化を最優先。\n宿題: 必要な機材の見積もり（担当: " + owner + "）"))
        db.execute("INSERT INTO platform_monthly(platform, month, body) VALUES (?,?,?)",
                   (no, last_month, f"{title}: 目標の見直しを実施。次月は検証作業を進める。"))
        for g_title, due, status, note in goals:
            db.execute("INSERT INTO platform_goals(platform, title, due_date, status, note) VALUES (?,?,?,?,?)",
                       (no, g_title, due, status, note))


# ---------------------------------------------------------------- Models

def check_url(v):
    v = (v or "").strip()
    if v and not re.match(r"^https?://", v, re.I):
        raise ValueError("リンクは http:// または https:// で始まる URL を入力してください")
    return v


class LinkItem(BaseModel):
    label: str = ""
    url: str = ""

    @field_validator("label", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("url", mode="before")
    @classmethod
    def url_ok(cls, v):
        v = check_url(v)
        if not v:
            raise ValueError("自由リンクの URL を入力してください（不要な行は削除）")
        return v


class PlatformIn(BaseModel):
    title: str = ""
    areas: list[str] = []   # 領域（複数可）
    owner: str = ""         # PL
    members: str = ""
    vision: str = ""
    plan_url: str = ""      # 研究計画のリンク
    box_url: str = ""       # BOX のリンク
    teams_url: str = ""     # Teams のリンク
    link_label: str = ""    # （未使用）旧・自由リンクの名前。自由リンクは links へ
    link_url: str = ""      # （未使用）旧・自由リンクの URL
    links: list["LinkItem"] | None = None  # 自由リンク（何個でも）。None なら変更しない

    _urls = field_validator("plan_url", "box_url", "teams_url", "link_url", mode="before")(classmethod(lambda cls, v: check_url(v)))

    @field_validator("members", mode="before")
    @classmethod
    def people(cls, v):
        names = [n for n in re.split(r"[\s　]+", v or "") if n]
        return " ".join(dict.fromkeys(names))

    @field_validator("areas")
    @classmethod
    def uniq_areas(cls, v: list[str]):
        return list(dict.fromkeys(a.strip() for a in v if a.strip()))


class TopicIn(BaseModel):
    meeting_date: date
    title: str = Field(min_length=1)
    body: str = ""


class MonthlyIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    body: str = Field(min_length=1)


class ConfirmIn(BaseModel):
    password: str = ""


async def require_password(body: ConfirmIn) -> None:
    if not auth.check_password(body.password):
        await asyncio.sleep(1)  # 総当たり対策
        raise HTTPException(403, "パスワードが正しくないため削除できません")


class GoalIn(BaseModel):
    title: str = Field(min_length=1)
    due_date: date | None = None
    status: GoalStatus = "未着手"
    note: str = ""
    url: str = ""           # 目標のリンク

    _url = field_validator("url", mode="before")(classmethod(lambda cls, v: check_url(v)))


# ---------------------------------------------------------------- helpers

# 旧・自由リンク（platforms.link_label / link_url）→ platform_links の引き継ぎ（backup.py の復元でも使う）
LEGACY_LINKS_COPY = """INSERT INTO platform_links(platform, label, url, sort_order)
                       SELECT name, link_label, link_url, 1 FROM platforms WHERE link_url <> ''"""


def _natural(name: str) -> list:
    """K-2 < K-10 となる並べ方"""
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", name)]


def fill_sort_order(db: sqlite3.Connection) -> None:
    """並び順が未設定（0）の基盤を、基盤番号の順で最後に並べる（起動時・並べ替えの前）"""
    rows = db.execute("SELECT id, name FROM platforms WHERE sort_order = 0").fetchall()
    if not rows:
        return
    n = db.execute("SELECT COALESCE(MAX(sort_order), 0) FROM platforms").fetchone()[0]
    for r in sorted(rows, key=lambda r: _natural(r["name"])):
        n += 1
        db.execute("UPDATE platforms SET sort_order = ? WHERE id = ?", (n, r["id"]))


def links_of(db: sqlite3.Connection, names: list[str] | None = None) -> dict[str, list[dict]]:
    """基盤番号ごとの自由リンク（並び順）"""
    out: dict[str, list[dict]] = {}
    for r in db.execute("SELECT platform, label, url FROM platform_links ORDER BY platform, sort_order, id"):
        if names is None or r["platform"] in names:
            out.setdefault(r["platform"], []).append({"label": r["label"], "url": r["url"]})
    return out


def save_links(db: sqlite3.Connection, name: str, links: list) -> None:
    """基盤の自由リンクを置き換える"""
    db.execute("DELETE FROM platform_links WHERE platform = ?", (name,))
    for i, l in enumerate(links, start=1):
        db.execute("INSERT INTO platform_links(platform, label, url, sort_order) VALUES (?,?,?,?)", (name, l.label, l.url, i))


def add_link(db: sqlite3.Connection, name: str, label: str, url: str) -> None:
    """CSV の取り込み用: 同じ URL が無ければ最後に追加、あれば名前を更新"""
    url = check_url(url)
    if not url:
        return
    row = db.execute("SELECT id FROM platform_links WHERE platform = ? AND url = ?", (name, url)).fetchone()
    if row:
        if label:
            db.execute("UPDATE platform_links SET label = ? WHERE id = ?", (label, row["id"]))
        return
    order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM platform_links WHERE platform = ?", (name,)).fetchone()[0]
    db.execute("INSERT INTO platform_links(platform, label, url, sort_order) VALUES (?,?,?,?)", (name, label, url, order))


def to_platform(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["areas"] = json.loads(d.get("areas") or "[]")
    return d


def fetch_platform(db: sqlite3.Connection, name: str) -> dict:
    row = db.execute(f"{PLATFORM_SELECT} WHERE p.name = ?", (name,)).fetchone()
    if row is None:
        raise HTTPException(404, f"基盤番号「{name}」は登録されていません（管理サイトで登録してください）")
    d = to_platform(row)
    d["links"] = links_of(db, [name]).get(name, [])
    return d


PLATFORM_SELECT = """
    SELECT p.name, p.sort_order, p.title, p.owner, p.members, p.areas, p.vision, p.plan_url, p.box_url, p.teams_url, p.link_label, p.link_url, p.updated_at,
           (SELECT COUNT(*) FROM platform_topics d WHERE d.platform = p.name) AS topic_count,
           (SELECT MAX(meeting_date) FROM platform_topics d WHERE d.platform = p.name) AS last_topic_date,
           (SELECT MAX(month) FROM platform_monthly m WHERE m.platform = p.name) AS last_month,
           (SELECT COUNT(*) FROM platform_goals g WHERE g.platform = p.name) AS goal_total,
           (SELECT COUNT(*) FROM platform_goals g WHERE g.platform = p.name AND g.status = '達成') AS goal_done,
           (SELECT COUNT(*) FROM tasks t WHERE t.project = p.name) AS task_count,
           (SELECT MIN(due_date) FROM platform_goals g
             WHERE g.platform = p.name AND g.status NOT IN ('達成', '保留') AND g.due_date IS NOT NULL) AS next_due
    FROM platforms p
"""


# ---------------------------------------------------------------- 基盤

@router.get("")
def list_platforms() -> list[dict]:
    with get_db() as db:
        links = links_of(db)
        return [{**to_platform(r), "links": links.get(r["name"], [])} for r in db.execute(f"{PLATFORM_SELECT} ORDER BY (p.sort_order = 0), p.sort_order, p.id")]


# ---------------------------------------------------------------- エクスポート（CSV）

def csv_response(rows: list[list], prefix: str) -> Response:
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    filename = f"{prefix}_{datetime.now():%Y%m%d_%H%M%S}.csv"
    # Excel で文字化けしないよう BOM 付き UTF-8
    return Response(buf.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def platforms_for_export(area: str, person: str = "") -> list[dict]:
    def has_person(p: dict) -> bool:
        return not person or p["owner"] == person or person in (p["members"] or "").split(" ")
    return [p for p in list_platforms() if (not area or area in p["areas"]) and has_person(p)]


@router.get("/export.csv")
def export_platforms(area: str = "", person: str = "") -> Response:
    """基盤一覧: 1 基盤 1 行。月報はすべて「月報_YYYY-MM」列に展開（新しい月から）。"""
    ps = platforms_for_export(area, person)
    names = [p["name"] for p in ps]
    with get_db() as db:
        monthly = {}
        if names:
            q = f"SELECT platform, month, body FROM platform_monthly WHERE platform IN ({','.join('?' * len(names))})"
            monthly = {(r["platform"], r["month"]): r["body"] for r in db.execute(q, names)}
    months = sorted({m for _, m in monthly}, reverse=True)
    rows = [["基盤番号", "基盤名", "領域", "PL", "メンバー", "全体目標", "研究計画リンク", "BOXリンク", "Teamsリンク",
             "自由リンク（名前｜URL、改行区切り）", "目標の達成", "目標の総数", "次の期限",
             "タスク数", "ディスカッション数", "最新のディスカッション日", *(f"月報_{m}" for m in months)]]
    for p in ps:
        rows.append([p["name"], p["title"], "、".join(p["areas"]), p["owner"], p["members"], p["vision"],
                     p["plan_url"], p["box_url"], p["teams_url"], "\n".join(f"{l['label']}｜{l['url']}" for l in p["links"]), p["goal_done"], p["goal_total"], p["next_due"] or "", p["task_count"], p["topic_count"],
                     p["last_topic_date"] or "", *(monthly.get((p["name"], m), "") for m in months)])
    return csv_response(rows, "platforms")


BACKUP_HEADERS = ["種別", "基盤番号", "基盤名", "領域", "PL", "メンバー", "全体目標", "研究計画リンク", "BOXリンク", "Teamsリンク",
                  "自由リンクの名前", "自由リンク", "目標", "状態", "期限", "メモ", "リンク", "日付", "トピック", "内容", "月", "月報"]


@router.get("/export-backup.csv")
def export_backup(area: str = "", person: str = "") -> Response:
    """全データ（バックアップ用）: 基盤・目標・ディスカッション・月報を「種別」列付きで 1 ファイルに出力。
    このファイルをインポートすれば、データが空の状態からでも復元できる。"""
    ps = platforms_for_export(area, person)
    rows = [BACKUP_HEADERS]
    blank = {h: "" for h in BACKUP_HEADERS}
    add = lambda **kw: rows.append([{**blank, **kw}[h] for h in BACKUP_HEADERS])  # noqa: E731
    with get_db() as db:
        for p in ps:
            add(種別="基盤", 基盤番号=p["name"], 基盤名=p["title"], 領域="、".join(p["areas"]), PL=p["owner"],
                メンバー=p["members"], 全体目標=p["vision"], 研究計画リンク=p["plan_url"], BOXリンク=p["box_url"],
                Teamsリンク=p["teams_url"])
            for l in p["links"]:
                add(種別="リンク", 基盤番号=p["name"], 自由リンクの名前=l["label"], 自由リンク=l["url"])
        for p in ps:
            for g in db.execute(f"SELECT * FROM platform_goals WHERE platform = ? {GOAL_ORDER}", (p["name"],)):
                add(種別="目標", 基盤番号=p["name"], 目標=g["title"], 状態=g["status"], 期限=g["due_date"] or "",
                    メモ=g["note"], リンク=g["url"])
            for t in db.execute("SELECT * FROM platform_topics WHERE platform = ? ORDER BY meeting_date, id", (p["name"],)):
                add(種別="ディスカッション", 基盤番号=p["name"], 日付=t["meeting_date"], トピック=t["title"], 内容=t["body"])
            for m in db.execute("SELECT * FROM platform_monthly WHERE platform = ? ORDER BY month", (p["name"],)):
                add(種別="月報", 基盤番号=p["name"], 月=m["month"], 月報=m["body"])
    return csv_response(rows, "platforms_backup")


@router.get("/export-monthly.csv")
def export_monthly(area: str = "", person: str = "", month: str = "") -> Response:
    """月報一覧: 基盤 × 月 で 1 行。month=YYYY-MM を指定するとその月だけ。"""
    info = {p["name"]: p for p in platforms_for_export(area, person)}
    sql = "SELECT platform, month, body, updated_at FROM platform_monthly"
    params: list = []
    if month:
        if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
            raise HTTPException(422, "month は YYYY-MM 形式で指定してください")
        sql += " WHERE month = ?"
        params.append(month)
    rows = [["月", "基盤番号", "基盤名", "領域", "PL", "メンバー", "月報", "更新日時"]]
    with get_db() as db:
        records = db.execute(sql + " ORDER BY month DESC", params).fetchall()
    order = list(info)
    for r in sorted((r for r in records if r["platform"] in info),
                    key=lambda r: (-int(r["month"].replace("-", "")), order.index(r["platform"]))):
        p = info[r["platform"]]
        rows.append([r["month"], p["name"], p["title"], "、".join(p["areas"]), p["owner"], p["members"],
                     r["body"], r["updated_at"]])
    return csv_response(rows, f"platform_monthly_{month}" if month else "platform_monthly")


@router.get("/export-goals.csv")
def export_goals(area: str = "", person: str = "") -> Response:
    info = {p["name"]: p for p in platforms_for_export(area, person)}
    rows = [["基盤番号", "基盤名", "領域", "PL", "メンバー", "状態", "目標", "期限", "メモ", "リンク", "更新日時"]]
    with get_db() as db:
        for name, p in info.items():
            for g in db.execute(f"SELECT * FROM platform_goals WHERE platform = ? {GOAL_ORDER}", (name,)):
                rows.append([name, p["title"], "、".join(p["areas"]), p["owner"], p["members"], g["status"], g["title"],
                             g["due_date"] or "", g["note"], g["url"], g["updated_at"]])
    return csv_response(rows, "platform_goals")


@router.get("/export-topics.csv")
def export_topics(area: str = "", person: str = "") -> Response:
    info = {p["name"]: p for p in platforms_for_export(area, person)}
    rows = [["日付", "基盤番号", "基盤名", "領域", "PL", "メンバー", "トピック", "内容・決定事項", "更新日時"]]
    with get_db() as db:
        records = db.execute("SELECT * FROM platform_topics ORDER BY meeting_date DESC, id DESC").fetchall()
    for t in records:
        if t["platform"] in info:
            p = info[t["platform"]]
            rows.append([t["meeting_date"], p["name"], p["title"], "、".join(p["areas"]), p["owner"], p["members"],
                         t["title"], t["body"],
                         t["updated_at"]])
    return csv_response(rows, "platform_topics")


# ---------------------------------------------------------------- インポート（CSV）
# エクスポートした 4 種類の CSV をそのまま取り込める。種類は列名から自動判別する。
MONTH_COL = re.compile(r"^月報_(\d{4})[-/](\d{1,2})$")
MONTH_RE = re.compile(r"^(\d{4})[-/](\d{1,2})$")


def _month(value: str, line: int, label: str = "月") -> str:
    m = MONTH_RE.match((value or "").strip())
    if not m or not 1 <= int(m.group(2)) <= 12:
        raise HTTPException(422, f"{line} 行目: {label}「{value}」は YYYY-MM 形式で入力してください")
    return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}"


def _ensure_platform(db: sqlite3.Connection, name: str, line: int) -> bool:
    """基盤番号が無ければ登録。案件番号と重複する場合はエラー。新規登録なら True"""
    if db.execute("SELECT 1 FROM platforms WHERE name = ?", (name,)).fetchone():
        return False
    if db.execute("SELECT 1 FROM case_nos WHERE name = ?", (name,)).fetchone():
        raise HTTPException(422, f"{line} 行目: 「{name}」は案件番号として登録済みのため基盤番号にできません")
    ensure_master(db, "platforms", name)
    return True


def _upsert_monthly(db: sqlite3.Connection, name: str, month: str, body: str) -> None:
    db.execute(
        """INSERT INTO platform_monthly(platform, month, body) VALUES (?,?,?)
           ON CONFLICT(platform, month) DO UPDATE
           SET body = excluded.body, updated_at = datetime('now', 'localtime')
           WHERE body <> excluded.body""",
        (name, month, body))


def _import_platform(db: sqlite3.Connection, name: str, r: dict, line: int, result: dict, headers: list[str]) -> None:
    cur = to_platform(db.execute("SELECT * FROM platforms WHERE name = ?", (name,)).fetchone())
    data = {"title": cur.get("title", ""), "areas": cur["areas"], "owner": cur.get("owner", ""),
            "members": cur.get("members", ""), "vision": cur.get("vision", ""),
            "plan_url": cur.get("plan_url", ""), "box_url": cur.get("box_url", ""), "teams_url": cur.get("teams_url", ""),
            "link_label": cur.get("link_label", ""), "link_url": cur.get("link_url", "")}
    for col, key in (("基盤名", "title"), ("PL", "owner"), ("メンバー", "members"), ("全体目標", "vision"),
                     ("研究計画リンク", "plan_url"), ("BOXリンク", "box_url"), ("Teamsリンク", "teams_url")):
        if r.get(col):
            data[key] = r[col]
    # 自由リンク: 旧形式（自由リンクの名前・自由リンク）と一覧形式（名前｜URL を改行区切り）
    new_links = []
    if r.get("自由リンク"):
        new_links.append((r.get("自由リンクの名前", ""), r["自由リンク"]))
    for ln in (r.get("自由リンク（名前｜URL、改行区切り）") or "").splitlines():
        if ln.strip():
            label, _, url = ln.rpartition("｜")
            new_links.append((label.strip(), url.strip()))
    if r.get("領域"):
        data["areas"] = [a for a in re.split(r"[\s\u3000;；、,/／]+", r["領域"]) if a]
    try:
        pin = PlatformIn(**data)
    except ValueError as e:
        raise HTTPException(422, f"{line} 行目（{name}）: {str(e).splitlines()[-1].replace('Value error, ', '').strip()}")
    for a in pin.areas:
        ensure_master(db, "areas", a)
    db.execute(
        "UPDATE platforms SET title=?, areas=?, owner=?, members=?, vision=?, plan_url=?, box_url=?, teams_url=?, link_label=?, link_url=?,"
        " updated_at=datetime('now','localtime') WHERE name=?",
        (pin.title, json.dumps(pin.areas, ensure_ascii=False), pin.owner, pin.members, pin.vision,
         pin.plan_url, pin.box_url, pin.teams_url, pin.link_label.strip(), pin.link_url, name))
    for label, url in new_links:
        try:
            add_link(db, name, label, url)
        except ValueError as e:
            raise HTTPException(422, f"{line} 行目（{name}）: {e}")
    result["platforms_updated"] += 1
    for h in headers:
        m = MONTH_COL.match(h)
        if m and r.get(h):
            _upsert_monthly(db, name, _month(f"{m.group(1)}-{m.group(2)}", line, f"列名「{h}」"), r[h])
            result["monthly"] += 1


def _import_monthly(db: sqlite3.Connection, name: str, r: dict, line: int, result: dict) -> None:
    if not r.get("月報"):
        return
    _upsert_monthly(db, name, _month(r.get("月", ""), line), r["月報"])
    result["monthly"] += 1


def _import_goal(db: sqlite3.Connection, name: str, r: dict, line: int, result: dict) -> None:
    title = r.get("目標", "")
    if not title:
        raise HTTPException(422, f"{line} 行目: 目標は必須です")
    status = r.get("状態") or "未着手"
    if status not in GOAL_STATUSES:
        raise HTTPException(422, f"{line} 行目: 状態「{status}」は {'・'.join(GOAL_STATUSES)} のいずれかにしてください")
    due = parse_date(r["期限"], line, "期限").isoformat() if r.get("期限") else None
    try:
        url = check_url(r.get("リンク", ""))
    except ValueError as e:
        raise HTTPException(422, f"{line} 行目: {e}")
    row = db.execute("SELECT id, status, due_date, note, url FROM platform_goals WHERE platform = ? AND title = ?",
                     (name, title)).fetchone()
    if row:
        new = (status, due or row["due_date"], r.get("メモ") or row["note"], url or row["url"])
        if new != (row["status"], row["due_date"], row["note"], row["url"]):  # 変化がなければ更新日時もそのまま
            db.execute("UPDATE platform_goals SET status=?, due_date=?, note=?, url=?, updated_at=datetime('now','localtime')"
                       " WHERE id=?", (*new, row["id"]))
        result["goals_updated"] += 1
    else:
        db.execute("INSERT INTO platform_goals(platform, title, due_date, status, note, url) VALUES (?,?,?,?,?,?)",
                   (name, title, due, status, r.get("メモ", ""), url))
        result["goals_added"] += 1


def _import_topic(db: sqlite3.Connection, name: str, r: dict, line: int, result: dict) -> None:
    title = r.get("トピック", "")
    if not title:
        raise HTTPException(422, f"{line} 行目: トピックは必須です")
    if not r.get("日付"):
        raise HTTPException(422, f"{line} 行目: 日付は必須です")
    day = parse_date(r["日付"], line, "日付").isoformat()
    body = r.get("内容・決定事項") or r.get("内容", "")
    row = db.execute("SELECT id, body FROM platform_topics WHERE platform=? AND meeting_date=? AND title=?",
                     (name, day, title)).fetchone()
    if row:
        if body and body != row["body"]:
            db.execute("UPDATE platform_topics SET body=?, updated_at=datetime('now','localtime') WHERE id=?",
                       (body, row["id"]))
        result["topics_updated"] += 1
    else:
        db.execute("INSERT INTO platform_topics(platform, meeting_date, title, body) VALUES (?,?,?,?)",
                   (name, day, title, body))
        result["topics_added"] += 1


BACKUP_KINDS = ("基盤", "リンク", "目標", "ディスカッション", "月報")


@router.post("/import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """基盤技術の CSV を取り込む（1 行でもエラーがあれば何も取り込まない）。

    - 全データ（バックアップ）: 「種別」列（基盤 / 目標 / ディスカッション / 月報）の行をそれぞれ取り込む。
      データが空の状態からでも、エクスポート時点の内容に復元できる
    - 基盤一覧＋月報: 基盤番号で照合して基盤名・領域・PL・メンバー・全体目標を更新（空欄は変更なし）。
      「月報_YYYY-MM」列はその月の月報として登録・上書き。未登録の基盤番号は新規登録
    - 月報一覧: 月＋基盤番号で登録・上書き
    - 目標一覧: 基盤番号＋目標で照合し、状態・期限・メモを更新（なければ追加）
    - ディスカッション一覧: 基盤番号＋日付＋トピックで照合し、内容を更新（なければ追加）
    """
    reader = csv.DictReader(io.StringIO(decode_csv(await file.read())))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    if "基盤番号" not in headers:
        raise HTTPException(422, "「基盤番号」列がありません（基盤技術のエクスポートと同じ形式の CSV を選んでください）")
    reader.fieldnames = headers
    rows = [(i, {k: (v or "").strip() for k, v in r.items() if k}) for i, r in enumerate(reader, start=2)]
    rows = [(i, r) for i, r in rows if any(r.values())]

    if "種別" in headers:
        kind = "backup"
    elif "月" in headers and "月報" in headers:
        kind = "monthly"
    elif "目標" in headers:
        kind = "goals"
    elif "トピック" in headers:
        kind = "topics"
    else:
        kind = "platforms"

    result = {"kind": kind, "platforms_added": 0, "platforms_updated": 0,
              "monthly": 0, "goals_added": 0, "goals_updated": 0, "topics_added": 0, "topics_updated": 0}
    with get_db() as db:
        # バックアップは「基盤」行を先に取り込む（領域などの情報を先に復元）
        if kind == "backup":
            order = {k: i for i, k in enumerate(BACKUP_KINDS)}
            for line, r in rows:
                if r.get("種別") not in order:
                    raise HTTPException(422, f"{line} 行目: 種別「{r.get('種別', '')}」は {'・'.join(BACKUP_KINDS)} のいずれかです")
            rows.sort(key=lambda x: (order[x[1]["種別"]], x[0]))
        for line, r in rows:
            name = r.get("基盤番号", "")
            if not name:
                raise HTTPException(422, f"{line} 行目: 基盤番号は必須です")
            if _ensure_platform(db, name, line):
                result["platforms_added"] += 1
            row_kind = {"基盤": "platforms", "リンク": "links", "目標": "goals", "ディスカッション": "topics", "月報": "monthly"}[r["種別"]] \
                if kind == "backup" else kind
            if row_kind == "platforms":
                _import_platform(db, name, r, line, result, headers if kind == "platforms" else [])
            elif row_kind == "links":
                try:
                    add_link(db, name, r.get("自由リンクの名前", ""), r.get("自由リンク", ""))
                except ValueError as e:
                    raise HTTPException(422, f"{line} 行目（{name}）: {e}")
            elif row_kind == "monthly":
                _import_monthly(db, name, r, line, result)
            elif row_kind == "goals":
                _import_goal(db, name, r, line, result)
            else:
                _import_topic(db, name, r, line, result)
    return result


@router.get("/goal-statuses")
def goal_statuses() -> list[str]:
    return list(GOAL_STATUSES)


class MoveIn(BaseModel):
    direction: Literal["up", "down"]


@router.post("/{name}/move")
def move_platform(name: str, m: MoveIn) -> list[dict]:
    """基盤一覧で 1 つ上／下と入れ替える"""
    with get_db() as db:
        fetch_platform(db, name)
        fill_sort_order(db)
        names = [r["name"] for r in db.execute("SELECT name FROM platforms ORDER BY sort_order, id")]
        i = names.index(name)
        j = i - 1 if m.direction == "up" else i + 1
        if 0 <= j < len(names):
            names[i], names[j] = names[j], names[i]
        for k, n in enumerate(names, start=1):
            db.execute("UPDATE platforms SET sort_order = ? WHERE name = ?", (k, n))
    return list_platforms()


class ReorderIn(BaseModel):
    names: list[str]


@router.post("/reorder")
def reorder_platforms(r: ReorderIn) -> list[dict]:
    """基盤一覧の順番をまとめて保存（ドラッグ＆ドロップ）。names は全基盤番号を新しい順番で"""
    with get_db() as db:
        current = {row["name"] for row in db.execute("SELECT name FROM platforms")}
        if set(r.names) != current or len(r.names) != len(current):
            raise HTTPException(409, "基盤の一覧が変わっています。画面を読み込み直してから並べ替えてください")
        for k, n in enumerate(r.names, start=1):
            db.execute("UPDATE platforms SET sort_order = ? WHERE name = ?", (k, n))
    return list_platforms()


@router.put("/{name}")
def update_platform(name: str, p: PlatformIn) -> dict:
    with get_db() as db:
        fetch_platform(db, name)
        for a in p.areas:
            ensure_master(db, "areas", a)
        db.execute(
            "UPDATE platforms SET title=?, areas=?, owner=?, members=?, vision=?, plan_url=?, box_url=?, teams_url=?, link_label=?, link_url=?,"
            " updated_at=datetime('now','localtime') WHERE name=?",
            (p.title.strip(), json.dumps(p.areas, ensure_ascii=False), p.owner.strip(), p.members,
             p.vision.strip(), p.plan_url, p.box_url, p.teams_url, p.link_label.strip(), p.link_url, name),
        )
        if p.links is not None:
            save_links(db, name, p.links)
        return fetch_platform(db, name)


# ---------------------------------------------------------------- 目標

GOAL_ORDER = "ORDER BY CASE status WHEN '達成' THEN 1 WHEN '保留' THEN 2 ELSE 0 END, COALESCE(due_date, '9999'), id"


@router.get("/{name}/goals")
def list_goals(name: str) -> list[dict]:
    with get_db() as db:
        fetch_platform(db, name)
        return [dict(r) for r in db.execute(f"SELECT * FROM platform_goals WHERE platform = ? {GOAL_ORDER}", (name,))]


def goal_values(g: GoalIn) -> tuple:
    return (g.title.strip(), g.due_date.isoformat() if g.due_date else None, g.status, g.note.strip(), g.url)


@router.post("/{name}/goals", status_code=201)
def add_goal(name: str, g: GoalIn) -> dict:
    with get_db() as db:
        fetch_platform(db, name)
        cur = db.execute("INSERT INTO platform_goals(platform, title, due_date, status, note, url) VALUES (?,?,?,?,?,?)",
                         (name, *goal_values(g)))
        return dict(db.execute("SELECT * FROM platform_goals WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{name}/goals/{goal_id}")
def update_goal(name: str, goal_id: int, g: GoalIn) -> dict:
    with get_db() as db:
        cur = db.execute(
            "UPDATE platform_goals SET title=?, due_date=?, status=?, note=?, url=?, updated_at=datetime('now','localtime')"
            " WHERE id=? AND platform=?",
            (*goal_values(g), goal_id, name),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "目標が見つかりません")
        return dict(db.execute("SELECT * FROM platform_goals WHERE id = ?", (goal_id,)).fetchone())


@router.delete("/{name}/goals/{goal_id}", status_code=204)
async def delete_goal(name: str, goal_id: int, body: ConfirmIn) -> Response:
    """目標の削除にはパスワード（ログインと同じ）が必要。パスワードは URL に載せず本文で受け取る。"""
    await require_password(body)
    with get_db() as db:
        cur = db.execute("DELETE FROM platform_goals WHERE id=? AND platform=?", (goal_id, name))
        if cur.rowcount == 0:
            raise HTTPException(404, "目標が見つかりません")
    return Response(status_code=204)


# ---------------------------------------------------------------- ディスカッション（定期的な議論のトピック）

@router.get("/{name}/topics")
def list_topics(name: str) -> list[dict]:
    with get_db() as db:
        fetch_platform(db, name)
        rows = db.execute("SELECT * FROM platform_topics WHERE platform = ? ORDER BY meeting_date DESC, id DESC", (name,))
        return [dict(r) for r in rows]


@router.post("/{name}/topics", status_code=201)
def add_topic(name: str, t: TopicIn) -> dict:
    with get_db() as db:
        fetch_platform(db, name)
        cur = db.execute("INSERT INTO platform_topics(platform, meeting_date, title, body) VALUES (?,?,?,?)",
                         (name, t.meeting_date.isoformat(), t.title.strip(), t.body.strip()))
        return dict(db.execute("SELECT * FROM platform_topics WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{name}/topics/{topic_id}")
def update_topic(name: str, topic_id: int, t: TopicIn) -> dict:
    with get_db() as db:
        cur = db.execute(
            "UPDATE platform_topics SET meeting_date=?, title=?, body=?, updated_at=datetime('now','localtime')"
            " WHERE id=? AND platform=?",
            (t.meeting_date.isoformat(), t.title.strip(), t.body.strip(), topic_id, name))
        if cur.rowcount == 0:
            raise HTTPException(404, "トピックが見つかりません")
        return dict(db.execute("SELECT * FROM platform_topics WHERE id = ?", (topic_id,)).fetchone())


@router.delete("/{name}/topics/{topic_id}", status_code=204)
def delete_topic(name: str, topic_id: int) -> Response:
    with get_db() as db:
        if db.execute("DELETE FROM platform_topics WHERE id=? AND platform=?", (topic_id, name)).rowcount == 0:
            raise HTTPException(404, "トピックが見つかりません")
    return Response(status_code=204)


# ---------------------------------------------------------------- 月報

@router.get("/{name}/monthly")
def list_monthly(name: str) -> list[dict]:
    with get_db() as db:
        fetch_platform(db, name)
        rows = db.execute("SELECT * FROM platform_monthly WHERE platform = ? ORDER BY month DESC", (name,))
        return [dict(r) for r in rows]


@router.put("/{name}/monthly")
def upsert_monthly(name: str, m: MonthlyIn) -> dict:
    """月ごとに 1 件。既にあれば上書き。"""
    with get_db() as db:
        fetch_platform(db, name)
        db.execute(
            """INSERT INTO platform_monthly(platform, month, body) VALUES (?,?,?)
               ON CONFLICT(platform, month) DO UPDATE
               SET body = excluded.body, updated_at = datetime('now', 'localtime')""",
            (name, m.month, m.body.strip()))
        return dict(db.execute("SELECT * FROM platform_monthly WHERE platform = ? AND month = ?",
                               (name, m.month)).fetchone())


@router.delete("/{name}/monthly/{report_id}", status_code=204)
async def delete_monthly(name: str, report_id: int, body: ConfirmIn) -> Response:
    """月報の削除にもパスワードが必要。"""
    await require_password(body)
    with get_db() as db:
        if db.execute("DELETE FROM platform_monthly WHERE id=? AND platform=?", (report_id, name)).rowcount == 0:
            raise HTTPException(404, "月報が見つかりません")
    return Response(status_code=204)
