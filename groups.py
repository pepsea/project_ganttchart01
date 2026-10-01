"""グループ目標管理 API

グループ（グループ名・PL・メンバー・大目標・関連サービス・関連基盤技術）と、
グループごとの目標（達成基準・時期・状態・期限・メモ・リンク）、年度ごとの達成したいこと（内容・担当者・達成日・リンク）を管理する。
目標と達成したいことは年度（4 月始まり、fiscal_year）ごとに表示する。
今年度の達成指標（team_kpis）は画面からは外したが、データと API は残している。
"""

import asyncio
import json
import re
import sqlite3
from datetime import date
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator

import auth
from csvutil import csv_response, parse_date, read_csv, split_list
from db import get_db

router = APIRouter(prefix="/api/groups", tags=["グループ目標"])

GOAL_STATUSES = ("未着手", "取組中", "達成", "保留")
GoalStatus = Literal[GOAL_STATUSES]


def init_db() -> None:
    with get_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS team_groups (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT NOT NULL UNIQUE,       -- グループ名
                pl         TEXT NOT NULL DEFAULT '',   -- PL
                members    TEXT NOT NULL DEFAULT '',   -- メンバー（半角スペース区切り）
                vision     TEXT NOT NULL DEFAULT '',   -- 大目標
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
            CREATE TABLE IF NOT EXISTS team_goals (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id   INTEGER NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
                title      TEXT NOT NULL,
                due_date   TEXT,
                status     TEXT NOT NULL DEFAULT '未着手',
                note       TEXT NOT NULL DEFAULT '',
                url        TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
            );
            """
        )
        cols = {r["name"] for r in db.execute("PRAGMA table_info(team_groups)")}
        for col, default in [("kpi", "''"), ("services", "'[]'"), ("platforms", "'[]'")]:
            # kpi = 今年度の達成指標 / services = 関連サービス（サービス番号）/ platforms = 関連基盤技術（基盤番号）
            if col not in cols:
                db.execute(f"ALTER TABLE team_groups ADD COLUMN {col} TEXT NOT NULL DEFAULT {default}")
        # 今年度の達成指標（指標ごとに担当者と進捗 %）
        db.execute(
            """CREATE TABLE IF NOT EXISTS team_kpis (
                   id         INTEGER PRIMARY KEY AUTOINCREMENT,
                   group_id   INTEGER NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
                   title      TEXT NOT NULL,                -- 指標
                   owner      TEXT NOT NULL DEFAULT '',     -- 担当者
                   progress   INTEGER NOT NULL DEFAULT 0,   -- 進捗（0〜100 %）
                   sort_order INTEGER NOT NULL DEFAULT 0,
                   created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )
        # 目標に「達成基準」「時期」を追加
        goal_cols = {r["name"] for r in db.execute("PRAGMA table_info(team_goals)")}
        for col in ("criteria", "period"):
            if col not in goal_cols:
                db.execute(f"ALTER TABLE team_goals ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        # 今年度達成したいこと（内容・担当者・達成日）
        db.execute(
            """CREATE TABLE IF NOT EXISTS team_achievements (
                   id          INTEGER PRIMARY KEY AUTOINCREMENT,
                   group_id    INTEGER NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
                   title       TEXT NOT NULL,               -- 達成したいこと
                   owner       TEXT NOT NULL DEFAULT '',    -- 担当者
                   achieved_on TEXT,                        -- 達成日（任意）
                   note        TEXT NOT NULL DEFAULT '',
                   created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )
        ach_cols = {r["name"] for r in db.execute("PRAGMA table_info(team_achievements)")}
        if "url" not in ach_cols:
            db.execute("ALTER TABLE team_achievements ADD COLUMN url TEXT NOT NULL DEFAULT ''")  # 関連リンク
        if "sort_order" not in goal_cols:  # 項目の並び順（ドラッグで入れ替え。0 = 未設定）
            db.execute("ALTER TABLE team_goals ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        if "progress" not in ach_cols:
            # 達成項目の達成度（％）。これまでの「達成したこと」（旧名）は達成済みなので 100
            db.execute("ALTER TABLE team_achievements ADD COLUMN progress INTEGER NOT NULL DEFAULT 100")
        if "quarter" not in ach_cols:
            # 達成時期（Q1〜Q4。年度は 4 月始まり: Q1 = 4〜6 月、Q2 = 7〜9 月、Q3 = 10〜12 月、Q4 = 1〜3 月。空 = 未設定）。
            # 旧・達成日（achieved_on）は未使用として残し、入っている日付から四半期を引き継ぐ
            db.execute("ALTER TABLE team_achievements ADD COLUMN quarter TEXT NOT NULL DEFAULT ''")
            db.execute("""UPDATE team_achievements SET quarter = 'Q' || (
                              CASE WHEN CAST(strftime('%m', achieved_on) AS INTEGER) BETWEEN 4 AND 6 THEN 1
                                   WHEN CAST(strftime('%m', achieved_on) AS INTEGER) BETWEEN 7 AND 9 THEN 2
                                   WHEN CAST(strftime('%m', achieved_on) AS INTEGER) BETWEEN 10 AND 12 THEN 3 ELSE 4 END)
                          WHERE achieved_on IS NOT NULL AND achieved_on <> ''""")
        if "goal_id" not in ach_cols:
            # 関連する「目標達成に必要な項目」（team_goals.id。0 = どの項目にも結びつけていない）
            db.execute("ALTER TABLE team_achievements ADD COLUMN goal_id INTEGER NOT NULL DEFAULT 0")
        # 年度（4 月始まり）。未設定の行は期限・達成日（無ければ作成日）から決める
        for table, date_col in (("team_goals", "due_date"), ("team_achievements", "achieved_on")):
            if "fiscal_year" not in {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}:
                db.execute(f"ALTER TABLE {table} ADD COLUMN fiscal_year INTEGER")
            d = f"COALESCE({date_col}, created_at)"
            db.execute(f"UPDATE {table} SET fiscal_year = CAST(strftime('%Y', {d}) AS INTEGER)"
                       f" - (CAST(strftime('%m', {d}) AS INTEGER) < 4) WHERE fiscal_year IS NULL")
        # 登録した年度（選択肢）。初回だけ、今年度と登録済みデータの年度を入れる
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_years'").fetchone()
        db.execute("""CREATE TABLE IF NOT EXISTS team_years (
                          year       INTEGER PRIMARY KEY,   -- 年度（4 月始まり）
                          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                      )""")
        if not exists:
            db.execute("INSERT OR IGNORE INTO team_years(year) VALUES (?)", (fiscal_year_of(),))
            db.execute("INSERT OR IGNORE INTO team_years(year) SELECT fiscal_year FROM team_goals"
                       " WHERE fiscal_year IS NOT NULL UNION SELECT fiscal_year FROM team_achievements WHERE fiscal_year IS NOT NULL")
        # 旧形式（kpi 列の文章）は 1 行ずつ指標として引き継ぐ（kpi 列は未使用として残す）
        for r in db.execute("SELECT id, kpi FROM team_groups WHERE kpi <> ''"
                            " AND id NOT IN (SELECT group_id FROM team_kpis)").fetchall():
            lines = [x.strip() for x in r["kpi"].splitlines() if x.strip()]
            for i, line in enumerate(lines, start=1):
                db.execute("INSERT INTO team_kpis(group_id, title, sort_order) VALUES (?,?,?)", (r["id"], line, i))
            db.execute("UPDATE team_groups SET kpi = '' WHERE id = ?", (r["id"],))


# ---------------------------------------------------------------- Models

def quarter_of(d: date | None) -> str:
    """年度（4 月始まり）の四半期: 4〜6 月 = Q1、7〜9 月 = Q2、10〜12 月 = Q3、1〜3 月 = Q4"""
    return "" if d is None else f"Q{((d.month - 4) % 12) // 3 + 1}"


def fiscal_year_of(d: date | None = None) -> int:
    """年度（4 月始まり）: 2026/4/1〜2027/3/31 は 2026 年度"""
    d = d or date.today()
    return d.year if d.month >= 4 else d.year - 1


FiscalYear = Field(default=None, ge=2000, le=2100)


def _url(v):
    v = (v or "").strip()
    if v and not re.match(r"^https?://", v, re.I):
        raise ValueError("リンクは http:// または https:// で始まる URL を入力してください")
    return v


class GroupIn(BaseModel):
    name: str = Field(min_length=1)
    pl: str = ""
    members: str = ""
    vision: str = ""          # 大目標
    kpi: str = ""             # 今年度の達成指標
    services: list[str] = []  # 関連サービス（サービス番号）
    platforms: list[str] = [] # 関連基盤技術（基盤番号）

    @field_validator("services", "platforms")
    @classmethod
    def uniq(cls, v):
        return list(dict.fromkeys(x.strip() for x in v if x and x.strip()))

    @field_validator("name", "pl", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("members", mode="before")
    @classmethod
    def people(cls, v):
        return " ".join(dict.fromkeys(n for n in re.split(r"[\s　]+", v or "") if n))


class GoalIn(BaseModel):
    fiscal_year: int | None = FiscalYear  # 年度（省略時は期限、無ければ今日から決める）
    title: str = Field(min_length=1)
    criteria: str = ""       # 達成基準
    period: str = ""         # 時期（例: 2026 年度下期）
    due_date: date | None = None
    status: GoalStatus = "未着手"
    note: str = ""
    url: str = ""

    @field_validator("url", mode="before")
    @classmethod
    def check_url(cls, v):
        return _url(v)


class KpiIn(BaseModel):
    title: str = Field(min_length=1)
    owner: str = ""
    progress: int = Field(default=0, ge=0, le=100)

    @field_validator("title", "owner", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v


class AchievementIn(BaseModel):
    fiscal_year: int | None = FiscalYear  # 年度（省略時は達成日、無ければ今日から決める）
    title: str = Field(min_length=1)
    owner: str = ""
    achieved_on: date | None = None  # （未使用）旧・達成日。入っていれば達成時期（quarter）の初期値に使う
    quarter: Literal["", "Q1", "Q2", "Q3", "Q4"] = ""  # 達成時期（年度の四半期）
    note: str = ""
    url: str = ""
    goal_id: int = 0  # 関連する「目標達成に必要な項目」（team_goals.id。0 = なし）
    progress: int = Field(default=0, ge=0, le=100)  # 達成度（％。新しい達成項目の初期値は 0）

    @field_validator("title", "owner", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("url", mode="before")
    @classmethod
    def check_url(cls, v):
        return _url(v)


class PasswordIn(BaseModel):
    password: str = ""


async def _require_password(body: PasswordIn) -> None:
    if not auth.check_password(body.password):
        await asyncio.sleep(1)  # 総当たり対策
        raise HTTPException(403, "パスワードが正しくないため削除できません")


# :y = 年度（NULL なら全年度）で目標の件数を数える
GROUP_SELECT = """
    SELECT g.*,
           (SELECT COUNT(*) FROM team_goals t WHERE t.group_id = g.id
             AND (:y IS NULL OR t.fiscal_year = :y)) AS goal_total,
           (SELECT COUNT(*) FROM team_goals t WHERE t.group_id = g.id AND t.status = '達成'
             AND (:y IS NULL OR t.fiscal_year = :y)) AS goal_done,
           (SELECT MIN(due_date) FROM team_goals t
             WHERE t.group_id = g.id AND t.status NOT IN ('達成', '保留') AND t.due_date IS NOT NULL
             AND (:y IS NULL OR t.fiscal_year = :y)) AS next_due,
           (SELECT COUNT(*) FROM team_kpis k WHERE k.group_id = g.id) AS kpi_count,
           (SELECT ROUND(AVG(progress)) FROM team_kpis k WHERE k.group_id = g.id) AS kpi_avg
    FROM team_groups g
"""
# 並び: 手で入れ替えた順（sort_order）→ 入れ替えていない項目は 状態・期限の順（新しく追加した項目は一番下）
GOAL_ORDER = ("ORDER BY (sort_order = 0), sort_order,"
              " CASE status WHEN '達成' THEN 1 WHEN '保留' THEN 2 ELSE 0 END, COALESCE(due_date, '9999'), id")


def _to_group(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["services"] = json.loads(d.get("services") or "[]")
    d["platforms"] = json.loads(d.get("platforms") or "[]")
    return d


def _fetch(db: sqlite3.Connection, gid: int, year: int | None = None) -> dict:
    row = db.execute(f"{GROUP_SELECT} WHERE g.id = :gid", {"gid": gid, "y": year}).fetchone()
    if row is None:
        raise HTTPException(404, "グループが見つかりません")
    return _to_group(row)


def _check_refs(db: sqlite3.Connection, g: GroupIn) -> None:
    """関連サービス・関連基盤技術は登録済みのものだけ"""
    bad_s = [n for n in g.services if not db.execute("SELECT 1 FROM services WHERE service_no = ?", (n,)).fetchone()]
    if bad_s:
        raise HTTPException(422, f"サービス番号「{'、'.join(bad_s)}」は登録されていません")
    bad_p = [n for n in g.platforms if not db.execute("SELECT 1 FROM platforms WHERE name = ?", (n,)).fetchone()]
    if bad_p:
        raise HTTPException(422, f"基盤番号「{'、'.join(bad_p)}」は登録されていません")


def _group_values(g: GroupIn) -> tuple:
    return (g.name, g.pl, g.members, g.vision.strip(), g.kpi.strip(),
            json.dumps(g.services, ensure_ascii=False), json.dumps(g.platforms, ensure_ascii=False))


def replace_service_no(db: sqlite3.Connection, old: str, new: str | None) -> None:
    """サービス番号の変更・削除をグループの関連サービスに反映（services.py から呼ぶ）"""
    for r in db.execute("SELECT id, services FROM team_groups").fetchall():
        items = json.loads(r["services"] or "[]")
        if old in items:
            items = [new if x == old else x for x in items if new is not None or x != old]
            db.execute("UPDATE team_groups SET services = ? WHERE id = ?",
                       (json.dumps(list(dict.fromkeys(items)), ensure_ascii=False), r["id"]))


def _write(db: sqlite3.Connection, sql: str, params: tuple, name: str):
    try:
        return db.execute(sql, params)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"グループ名「{name}」は既に登録されています")


# ---------------------------------------------------------------- グループ

@router.get("")
def list_groups(year: int | None = None) -> list[dict]:
    """登録の新しい順。year を指定すると、その年度の目標で件数を数える"""
    with get_db() as db:
        return [_to_group(r) for r in db.execute(f"{GROUP_SELECT} ORDER BY g.created_at DESC, g.id DESC", {"y": year})]


YEAR_USAGE = """
    SELECT y.year,
           (SELECT COUNT(*) FROM team_goals t WHERE t.fiscal_year = y.year) AS goals,
           (SELECT COUNT(*) FROM team_achievements a WHERE a.fiscal_year = y.year) AS achievements
    FROM team_years y ORDER BY y.year DESC
"""


class YearIn(BaseModel):
    year: int = Field(ge=2000, le=2100)


def _register_year(db: sqlite3.Connection, year: int) -> None:
    db.execute("INSERT OR IGNORE INTO team_years(year) VALUES (?)", (year,))


@router.get("/years")
def list_years() -> dict:
    """登録した年度（使用件数つき）と今年度。years = 選択肢（登録済み ∪ データのある年度 ∪ 今年度）"""
    now = fiscal_year_of()
    with get_db() as db:
        registered = [dict(r) for r in db.execute(YEAR_USAGE)]
        used = {r[0] for r in db.execute("SELECT fiscal_year FROM team_goals UNION SELECT fiscal_year FROM team_achievements")
                if r[0] is not None}
    ys = {r["year"] for r in registered} | used | {now}
    return {"current": now, "years": sorted(ys, reverse=True), "registered": registered}


@router.post("/years", status_code=201)
def add_year(y: YearIn) -> dict:
    with get_db() as db:
        if db.execute("SELECT 1 FROM team_years WHERE year = ?", (y.year,)).fetchone():
            raise HTTPException(409, f"{y.year}年度は既に登録されています")
        _register_year(db, y.year)
    return {"year": y.year}


@router.delete("/years/{year}", status_code=204)
def delete_year(year: int) -> Response:
    """年度の登録を外す（その年度の目標・達成したいことが残っている間は外せない）"""
    with get_db() as db:
        n = db.execute("SELECT (SELECT COUNT(*) FROM team_goals WHERE fiscal_year = :y)"
                       " + (SELECT COUNT(*) FROM team_achievements WHERE fiscal_year = :y)", {"y": year}).fetchone()[0]
        if n:
            raise HTTPException(409, f"{year}年度には目標・達成したいことが {n} 件あるため削除できません")
        if db.execute("DELETE FROM team_years WHERE year = ?", (year,)).rowcount == 0:
            raise HTTPException(404, f"{year}年度は登録されていません")
    return Response(status_code=204)


@router.get("/goal-statuses")
def goal_statuses() -> list[str]:
    return list(GOAL_STATUSES)


@router.post("", status_code=201)
def create_group(g: GroupIn) -> dict:
    with get_db() as db:
        _check_refs(db, g)
        order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM team_groups").fetchone()[0]
        cur = _write(db, "INSERT INTO team_groups(name, pl, members, vision, kpi, services, platforms, sort_order)"
                         " VALUES (?,?,?,?,?,?,?,?)", (*_group_values(g), order), g.name)
        return _fetch(db, cur.lastrowid)


@router.put("/{gid}")
def update_group(gid: int, g: GroupIn) -> dict:
    with get_db() as db:
        _fetch(db, gid)
        _check_refs(db, g)
        _write(db, "UPDATE team_groups SET name=?, pl=?, members=?, vision=?, kpi=?, services=?, platforms=?,"
                   " updated_at=datetime('now','localtime') WHERE id=?", (*_group_values(g), gid), g.name)
        return _fetch(db, gid)


@router.delete("/{gid}", status_code=204)
async def delete_group(gid: int, body: PasswordIn) -> Response:
    """グループの削除（パスワード必須。グループの目標も一緒に削除）"""
    await _require_password(body)
    with get_db() as db:
        _fetch(db, gid)
        db.execute("DELETE FROM team_groups WHERE id = ?", (gid,))
    return Response(status_code=204)


# ---------------------------------------------------------------- 目標

def _goal_values(t: GoalIn) -> tuple:
    return (t.title.strip(), t.due_date.isoformat() if t.due_date else None, t.status, t.note.strip(), t.url,
            t.criteria.strip(), t.period.strip(), t.fiscal_year or fiscal_year_of(t.due_date))


@router.get("/{gid}/goals")
def list_goals(gid: int, year: int | None = None) -> list[dict]:
    with get_db() as db:
        _fetch(db, gid)
        return [dict(r) for r in db.execute(
            f"SELECT * FROM team_goals WHERE group_id = :gid AND (:y IS NULL OR fiscal_year = :y) {GOAL_ORDER}",
            {"gid": gid, "y": year})]


class GoalReorderIn(BaseModel):
    ids: list[int]


@router.post("/{gid}/goals/reorder")
def reorder_goals(gid: int, r: GoalReorderIn) -> list[dict]:
    """項目の順番を保存（ドラッグ＆ドロップ）。画面に出ている項目（年度で絞っていれば、その年度の項目）の並びだけを入れ替え、
    ほかの項目の位置は動かさない"""
    with get_db() as db:
        _fetch(db, gid)
        full = [row["id"] for row in db.execute(f"SELECT id FROM team_goals WHERE group_id = ? {GOAL_ORDER}", (gid,))]
        if len(set(r.ids)) != len(r.ids) or not set(r.ids) <= set(full):
            raise HTTPException(409, "項目の一覧が変わっています。画面を読み込み直してから並べ替えてください")
        it = iter(r.ids)
        merged = [next(it) if x in set(r.ids) else x for x in full]  # 入れ替える項目が占めていた位置に、新しい順で入れる
        for n, tid in enumerate(merged, start=1):
            db.execute("UPDATE team_goals SET sort_order = ? WHERE id = ?", (n, tid))
        return [dict(x) for x in db.execute(f"SELECT * FROM team_goals WHERE group_id = ? {GOAL_ORDER}", (gid,))]


@router.post("/{gid}/goals", status_code=201)
def add_goal(gid: int, t: GoalIn) -> dict:
    with get_db() as db:
        _fetch(db, gid)
        cur = db.execute("INSERT INTO team_goals(group_id, title, due_date, status, note, url, criteria, period, fiscal_year)"
                         " VALUES (?,?,?,?,?,?,?,?,?)", (gid, *_goal_values(t)))
        _register_year(db, _goal_values(t)[-1])
        return dict(db.execute("SELECT * FROM team_goals WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{gid}/goals/{tid}")
def update_goal(gid: int, tid: int, t: GoalIn) -> dict:
    with get_db() as db:
        cur = db.execute("UPDATE team_goals SET title=?, due_date=?, status=?, note=?, url=?, criteria=?, period=?, fiscal_year=?,"
                         " updated_at=datetime('now','localtime') WHERE id=? AND group_id=?", (*_goal_values(t), tid, gid))
        if cur.rowcount == 0:
            raise HTTPException(404, "目標が見つかりません")
        _register_year(db, _goal_values(t)[-1])
        return dict(db.execute("SELECT * FROM team_goals WHERE id = ?", (tid,)).fetchone())


@router.delete("/{gid}/goals/{tid}", status_code=204)
async def delete_goal(gid: int, tid: int, body: PasswordIn) -> Response:
    """目標の削除（パスワード必須）"""
    await _require_password(body)
    with get_db() as db:
        if db.execute("DELETE FROM team_goals WHERE id=? AND group_id=?", (tid, gid)).rowcount == 0:
            raise HTTPException(404, "目標が見つかりません")
        # その項目に結びついていた達成したいことは残し、「項目なし」に戻す
        db.execute("UPDATE team_achievements SET goal_id = 0 WHERE goal_id = ? AND group_id = ?", (tid, gid))
    return Response(status_code=204)


# ---------------------------------------------------------------- 今年度の達成指標（担当者・進捗 %）

@router.get("/{gid}/kpis")
def list_kpis(gid: int) -> list[dict]:
    with get_db() as db:
        _fetch(db, gid)
        return [dict(r) for r in db.execute("SELECT * FROM team_kpis WHERE group_id = ? ORDER BY sort_order, id", (gid,))]


@router.post("/{gid}/kpis", status_code=201)
def add_kpi(gid: int, k: KpiIn) -> dict:
    with get_db() as db:
        _fetch(db, gid)
        order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM team_kpis WHERE group_id = ?", (gid,)).fetchone()[0]
        cur = db.execute("INSERT INTO team_kpis(group_id, title, owner, progress, sort_order) VALUES (?,?,?,?,?)",
                         (gid, k.title, k.owner, k.progress, order))
        return dict(db.execute("SELECT * FROM team_kpis WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{gid}/kpis/{kid}")
def update_kpi(gid: int, kid: int, k: KpiIn) -> dict:
    with get_db() as db:
        cur = db.execute("UPDATE team_kpis SET title=?, owner=?, progress=?, updated_at=datetime('now','localtime')"
                         " WHERE id=? AND group_id=?", (k.title, k.owner, k.progress, kid, gid))
        if cur.rowcount == 0:
            raise HTTPException(404, "指標が見つかりません")
        return dict(db.execute("SELECT * FROM team_kpis WHERE id = ?", (kid,)).fetchone())


@router.delete("/{gid}/kpis/{kid}", status_code=204)
async def delete_kpi(gid: int, kid: int, body: PasswordIn) -> Response:
    """指標の削除（パスワード必須）"""
    await _require_password(body)
    with get_db() as db:
        if db.execute("DELETE FROM team_kpis WHERE id=? AND group_id=?", (kid, gid)).rowcount == 0:
            raise HTTPException(404, "指標が見つかりません")
    return Response(status_code=204)


# ---------------------------------------------------------------- 今年度達成したいこと（内容・担当者・達成日）

def _check_goal(db, gid: int, goal_id: int) -> None:
    if goal_id and not db.execute("SELECT 1 FROM team_goals WHERE id = ? AND group_id = ?", (goal_id, gid)).fetchone():
        raise HTTPException(422, "関連する項目がこのグループに見つかりません")


def _ach_values(a: AchievementIn) -> tuple:
    return (a.title, a.owner, a.achieved_on.isoformat() if a.achieved_on else None, a.note.strip(), a.url,
            a.fiscal_year or fiscal_year_of(a.achieved_on))


def _set_quarter(db, aid: int, a: AchievementIn) -> None:
    db.execute("UPDATE team_achievements SET quarter = ? WHERE id = ?", (a.quarter or quarter_of(a.achieved_on), aid))


@router.get("/{gid}/achievements")
def list_achievements(gid: int, year: int | None = None) -> list[dict]:
    with get_db() as db:
        _fetch(db, gid)
        return [dict(r) for r in db.execute(
            "SELECT * FROM team_achievements WHERE group_id = :gid AND (:y IS NULL OR fiscal_year = :y)"
            " ORDER BY fiscal_year DESC, quarter DESC, id DESC", {"gid": gid, "y": year})]


@router.post("/{gid}/achievements", status_code=201)
def add_achievement(gid: int, a: AchievementIn) -> dict:
    with get_db() as db:
        _fetch(db, gid)
        _check_goal(db, gid, a.goal_id)
        cur = db.execute("INSERT INTO team_achievements(group_id, title, owner, achieved_on, note, url, fiscal_year, goal_id)"
                         " VALUES (?,?,?,?,?,?,?,?)", (gid, *_ach_values(a), a.goal_id))
        db.execute("UPDATE team_achievements SET progress = ? WHERE id = ?", (a.progress, cur.lastrowid))
        _set_quarter(db, cur.lastrowid, a)
        _register_year(db, _ach_values(a)[-1])
        return dict(db.execute("SELECT * FROM team_achievements WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{gid}/achievements/{aid}")
def update_achievement(gid: int, aid: int, a: AchievementIn) -> dict:
    with get_db() as db:
        _check_goal(db, gid, a.goal_id)
        cur = db.execute("UPDATE team_achievements SET title=?, owner=?, achieved_on=?, note=?, url=?, fiscal_year=?, goal_id=?, progress=?,"
                         " updated_at=datetime('now','localtime') WHERE id=? AND group_id=?", (*_ach_values(a), a.goal_id, a.progress, aid, gid))
        if cur.rowcount == 0:
            raise HTTPException(404, "記録が見つかりません")
        _set_quarter(db, aid, a)
        _register_year(db, _ach_values(a)[-1])
        return dict(db.execute("SELECT * FROM team_achievements WHERE id = ?", (aid,)).fetchone())


@router.delete("/{gid}/achievements/{aid}", status_code=204)
async def delete_achievement(gid: int, aid: int, body: PasswordIn) -> Response:
    """今年度達成したいことの削除（パスワード必須）"""
    await _require_password(body)
    with get_db() as db:
        if db.execute("DELETE FROM team_achievements WHERE id=? AND group_id=?", (aid, gid)).rowcount == 0:
            raise HTTPException(404, "記録が見つかりません")
    return Response(status_code=204)


# ---------------------------------------------------------------- CSV（エクスポート・インポート）
# 1 ファイルに「種別」列（グループ / 目標 / 達成したいこと / 指標 / 年度。旧名「達成したこと」も読める）の行を並べる。
# このファイルをインポートすれば、データが空の状態からでも元に戻せる。

EXPORT_HEADERS = ["種別", "グループ名", "リーダー", "メンバー", "大目標", "関連サービス", "関連基盤技術",
                  "年度", "状態", "目標", "達成基準", "時期", "期限",
                  "達成したいこと", "関連項目", "担当者", "達成時期", "指標", "進捗", "メモ", "リンク"]


def _err(line: int, e: Exception) -> HTTPException:
    if isinstance(e, ValidationError):
        msg = "; ".join(err["msg"].replace("Value error, ", "") for err in e.errors())
    else:
        msg = getattr(e, "detail", str(e))
    return HTTPException(422, f"{line} 行目: {msg}")


@router.get("/export.csv")
def export_csv() -> Response:
    rows = [EXPORT_HEADERS]
    blank = dict.fromkeys(EXPORT_HEADERS, "")
    add = lambda **kw: rows.append([{**blank, **kw}[h] for h in EXPORT_HEADERS])  # noqa: E731
    with get_db() as db:
        groups = [_to_group(r) for r in db.execute(f"{GROUP_SELECT} ORDER BY g.created_at, g.id", {"y": None})]
        for g in groups:
            add(種別="グループ", グループ名=g["name"], リーダー=g["pl"], メンバー=g["members"], 大目標=g["vision"],
                関連サービス="、".join(g["services"]), 関連基盤技術="、".join(g["platforms"]))
        for g in groups:
            for t in db.execute(f"SELECT * FROM team_goals WHERE group_id = ? ORDER BY fiscal_year, id", (g["id"],)):
                add(種別="目標", グループ名=g["name"], 年度=t["fiscal_year"] or "", 状態=t["status"], 目標=t["title"],
                    達成基準=t["criteria"], 時期=t["period"], 期限=t["due_date"] or "", メモ=t["note"], リンク=t["url"])
            for a in db.execute("SELECT * FROM team_achievements WHERE group_id = ? ORDER BY fiscal_year, quarter, id",
                                (g["id"],)):
                goal = db.execute("SELECT title FROM team_goals WHERE id = ? AND group_id = ?", (a["goal_id"], g["id"])).fetchone()
                add(種別="達成したいこと", グループ名=g["name"], 年度=a["fiscal_year"] or "", 達成したいこと=a["title"],
                    関連項目=goal["title"] if goal else "", 進捗=a["progress"], 担当者=a["owner"], 達成時期=a["quarter"] or "", メモ=a["note"], リンク=a["url"])
            for k in db.execute("SELECT * FROM team_kpis WHERE group_id = ? ORDER BY sort_order, id", (g["id"],)):
                add(種別="指標", グループ名=g["name"], 指標=k["title"], 担当者=k["owner"], 進捗=k["progress"])
        for r in db.execute("SELECT year FROM team_years ORDER BY year"):
            add(種別="年度", 年度=r["year"])
    return csv_response(rows, "groups")


@router.post("/import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """グループ目標 CSV を取り込む（1 行でもエラーがあれば何も取り込まない）。
    - グループ: グループ名が同じなら更新（空欄のセルは今の値のまま）、無ければ追加
    - 目標: 同じグループ・年度・目標なら更新、無ければ追加 / 達成したいこと: 同じグループ・年度・内容なら更新、無ければ追加
    - 指標（画面では非表示）: 同じグループ・指標なら更新 / 年度: 登録
    """
    rows = read_csv(await file.read(), ["種別", "グループ名"])
    result = dict.fromkeys(("groups_added", "groups_updated", "goals", "achievements", "kpis", "years"), 0)
    kinds = ("グループ", "目標", "達成したいこと", "指標", "年度")
    OLD_KINDS = {"達成したこと": "達成したいこと"}  # 旧名
    with get_db() as db:
        # グループの行を先に取り込む（目標などが同じファイルの後ろのグループを参照してもよいように）
        for line, r in sorted(rows, key=lambda x: x[1].get("種別") != "グループ"):
            kind = OLD_KINDS.get(r.get("種別"), r.get("種別")) or "グループ"
            if kind not in kinds:
                raise HTTPException(422, f"{line} 行目: 種別は {' / '.join(kinds)} のいずれかにしてください")
            if kind == "年度":
                try:
                    _register_year(db, YearIn(year=int(r.get("年度", ""))).year)
                except (ValueError, ValidationError):
                    raise HTTPException(422, f"{line} 行目: 年度「{r.get('年度', '')}」が正しくありません")
                result["years"] += 1
                continue
            name = r.get("グループ名", "")
            if not name:
                raise HTTPException(422, f"{line} 行目: グループ名は必須です")
            row = db.execute("SELECT * FROM team_groups WHERE name = ?", (name,)).fetchone()
            if kind == "グループ":
                cur = _to_group(row) if row else {}
                data = {"name": name, "pl": r.get("リーダー") or r.get("PL") or cur.get("pl", ""), "members": r.get("メンバー") or cur.get("members", ""),
                        "vision": r.get("大目標") or cur.get("vision", ""), "kpi": cur.get("kpi", ""),
                        "services": split_list(r["関連サービス"]) if r.get("関連サービス") else cur.get("services", []),
                        "platforms": split_list(r["関連基盤技術"]) if r.get("関連基盤技術") else cur.get("platforms", [])}
                try:
                    g = GroupIn(**data)
                    _check_refs(db, g)
                except (ValidationError, HTTPException) as e:
                    raise _err(line, e)
                if row:
                    db.execute("UPDATE team_groups SET name=?, pl=?, members=?, vision=?, kpi=?, services=?, platforms=?,"
                               " updated_at=datetime('now','localtime') WHERE id=?", (*_group_values(g), row["id"]))
                    result["groups_updated"] += 1
                else:
                    order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM team_groups").fetchone()[0]
                    db.execute("INSERT INTO team_groups(name, pl, members, vision, kpi, services, platforms, sort_order)"
                               " VALUES (?,?,?,?,?,?,?,?)", (*_group_values(g), order))
                    result["groups_added"] += 1
                continue
            if row is None:
                raise HTTPException(422, f"{line} 行目: グループ「{name}」が見つかりません（グループの行を先に登録してください）")
            gid = row["id"]
            try:
                year = int(r["年度"]) if r.get("年度") else None
            except ValueError:
                raise HTTPException(422, f"{line} 行目: 年度「{r['年度']}」が正しくありません")
            if kind == "目標":
                try:
                    due = parse_date(r["期限"], line, "期限") if r.get("期限") else None
                    t = GoalIn(fiscal_year=year, title=r.get("目標", ""), criteria=r.get("達成基準", ""),
                               period=r.get("時期", ""), due_date=due, status=r.get("状態") or "未着手",
                               note=r.get("メモ", ""), url=r.get("リンク", ""))
                except ValidationError as e:
                    raise _err(line, e)
                vals = _goal_values(t)
                hit = db.execute("SELECT id FROM team_goals WHERE group_id = ? AND fiscal_year = ? AND title = ?",
                                 (gid, vals[-1], vals[0])).fetchone()
                if hit:
                    db.execute("UPDATE team_goals SET title=?, due_date=?, status=?, note=?, url=?, criteria=?, period=?,"
                               " fiscal_year=?, updated_at=datetime('now','localtime') WHERE id=?", (*vals, hit["id"]))
                else:
                    db.execute("INSERT INTO team_goals(group_id, title, due_date, status, note, url, criteria, period,"
                               " fiscal_year) VALUES (?,?,?,?,?,?,?,?,?)", (gid, *vals))
                _register_year(db, vals[-1])
                result["goals"] += 1
            elif kind == "達成したいこと":
                try:
                    on = parse_date(r["達成日"], line, "達成日") if r.get("達成日") else None  # 旧列「達成日」→ 四半期に変換
                    q = (r.get("達成時期") or "").strip().upper().replace("Ｑ", "Q")
                    if q and q not in ("Q1", "Q2", "Q3", "Q4"):
                        raise HTTPException(422, f"{line} 行目: 達成時期「{r['達成時期']}」は Q1〜Q4 のいずれかにしてください")
                    a = AchievementIn(fiscal_year=year, title=r.get("達成したいこと") or r.get("達成したこと", ""), owner=r.get("担当者", ""),
                                      achieved_on=on, quarter=q, note=r.get("メモ", ""), url=r.get("リンク", ""),
                                      progress=int(r["進捗"]) if r.get("進捗") else 0)
                except (ValueError, ValidationError) as e:
                    raise _err(line, e)
                vals = _ach_values(a)
                gl = None
                rel = r.get("関連項目") or r.get("関連タスク")  # 以前の列名「関連タスク」も受け付ける
                if rel:
                    gl = db.execute("SELECT id FROM team_goals WHERE group_id = ? AND title = ?"
                                    " ORDER BY fiscal_year = ? DESC, id", (gid, rel, vals[-1])).fetchone()
                    if gl is None:
                        raise HTTPException(422, f"{line} 行目: 関連項目「{rel}」が見つかりません（先にその項目の行を登録してください）")
                goal_id = gl["id"] if gl else 0
                hit = db.execute("SELECT id, progress FROM team_achievements WHERE group_id = ? AND fiscal_year = ? AND title = ?",
                                 (gid, vals[-1], vals[0])).fetchone()
                if hit:
                    if not r.get("進捗"):
                        a.progress = hit["progress"]  # CSV に進捗が無い・空欄なら、今の達成度のまま
                    db.execute("UPDATE team_achievements SET title=?, owner=?, achieved_on=?, note=?, url=?, fiscal_year=?,"
                               " goal_id=?, progress=?, updated_at=datetime('now','localtime') WHERE id=?", (*vals, goal_id, a.progress, hit["id"]))
                    if r.get("達成時期") or r.get("達成日"):
                        _set_quarter(db, hit["id"], a)  # CSV に達成時期が無い・空欄なら、今の時期のまま
                else:
                    new_id = db.execute("INSERT INTO team_achievements(group_id, title, owner, achieved_on, note, url, fiscal_year, goal_id, progress)"
                                        " VALUES (?,?,?,?,?,?,?,?,?)", (gid, *vals, goal_id, a.progress)).lastrowid
                    _set_quarter(db, new_id, a)
                _register_year(db, vals[-1])
                result["achievements"] += 1
            else:  # 指標
                try:
                    k = KpiIn(title=r.get("指標", ""), owner=r.get("担当者", ""), progress=int(r.get("進捗") or 0))
                except (ValueError, ValidationError) as e:
                    raise _err(line, e)
                hit = db.execute("SELECT id FROM team_kpis WHERE group_id = ? AND title = ?", (gid, k.title)).fetchone()
                if hit:
                    db.execute("UPDATE team_kpis SET owner=?, progress=?, updated_at=datetime('now','localtime') WHERE id=?",
                               (k.owner, k.progress, hit["id"]))
                else:
                    order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM team_kpis WHERE group_id = ?",
                                       (gid,)).fetchone()[0]
                    db.execute("INSERT INTO team_kpis(group_id, title, owner, progress, sort_order) VALUES (?,?,?,?,?)",
                               (gid, k.title, k.owner, k.progress, order))
                result["kpis"] += 1
    return result
