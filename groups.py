"""グループ目標管理 API

グループ（グループ名・PL・メンバー・大目標・関連サービス・関連基盤技術）と、
今年度の達成指標（指標・担当者・進捗 %）、グループごとの目標（状態・期限・メモ・リンク）を管理する。
"""

import asyncio
import json
import re
import sqlite3
from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

import auth
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
        # 旧形式（kpi 列の文章）は 1 行ずつ指標として引き継ぐ（kpi 列は未使用として残す）
        for r in db.execute("SELECT id, kpi FROM team_groups WHERE kpi <> ''"
                            " AND id NOT IN (SELECT group_id FROM team_kpis)").fetchall():
            lines = [x.strip() for x in r["kpi"].splitlines() if x.strip()]
            for i, line in enumerate(lines, start=1):
                db.execute("INSERT INTO team_kpis(group_id, title, sort_order) VALUES (?,?,?)", (r["id"], line, i))
            db.execute("UPDATE team_groups SET kpi = '' WHERE id = ?", (r["id"],))


# ---------------------------------------------------------------- Models

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
    title: str = Field(min_length=1)
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


class PasswordIn(BaseModel):
    password: str = ""


async def _require_password(body: PasswordIn) -> None:
    if not auth.check_password(body.password):
        await asyncio.sleep(1)  # 総当たり対策
        raise HTTPException(403, "パスワードが正しくないため削除できません")


GROUP_SELECT = """
    SELECT g.*,
           (SELECT COUNT(*) FROM team_goals t WHERE t.group_id = g.id) AS goal_total,
           (SELECT COUNT(*) FROM team_goals t WHERE t.group_id = g.id AND t.status = '達成') AS goal_done,
           (SELECT MIN(due_date) FROM team_goals t
             WHERE t.group_id = g.id AND t.status NOT IN ('達成', '保留') AND t.due_date IS NOT NULL) AS next_due,
           (SELECT COUNT(*) FROM team_kpis k WHERE k.group_id = g.id) AS kpi_count,
           (SELECT ROUND(AVG(progress)) FROM team_kpis k WHERE k.group_id = g.id) AS kpi_avg
    FROM team_groups g
"""
GOAL_ORDER = "ORDER BY CASE status WHEN '達成' THEN 1 WHEN '保留' THEN 2 ELSE 0 END, COALESCE(due_date, '9999'), id"


def _to_group(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["services"] = json.loads(d.get("services") or "[]")
    d["platforms"] = json.loads(d.get("platforms") or "[]")
    return d


def _fetch(db: sqlite3.Connection, gid: int) -> dict:
    row = db.execute(f"{GROUP_SELECT} WHERE g.id = ?", (gid,)).fetchone()
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
def list_groups() -> list[dict]:
    with get_db() as db:
        return [_to_group(r) for r in db.execute(f"{GROUP_SELECT} ORDER BY g.sort_order, g.id")]


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
    return (t.title.strip(), t.due_date.isoformat() if t.due_date else None, t.status, t.note.strip(), t.url)


@router.get("/{gid}/goals")
def list_goals(gid: int) -> list[dict]:
    with get_db() as db:
        _fetch(db, gid)
        return [dict(r) for r in db.execute(f"SELECT * FROM team_goals WHERE group_id = ? {GOAL_ORDER}", (gid,))]


@router.post("/{gid}/goals", status_code=201)
def add_goal(gid: int, t: GoalIn) -> dict:
    with get_db() as db:
        _fetch(db, gid)
        cur = db.execute("INSERT INTO team_goals(group_id, title, due_date, status, note, url) VALUES (?,?,?,?,?,?)",
                         (gid, *_goal_values(t)))
        return dict(db.execute("SELECT * FROM team_goals WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{gid}/goals/{tid}")
def update_goal(gid: int, tid: int, t: GoalIn) -> dict:
    with get_db() as db:
        cur = db.execute("UPDATE team_goals SET title=?, due_date=?, status=?, note=?, url=?,"
                         " updated_at=datetime('now','localtime') WHERE id=? AND group_id=?", (*_goal_values(t), tid, gid))
        if cur.rowcount == 0:
            raise HTTPException(404, "目標が見つかりません")
        return dict(db.execute("SELECT * FROM team_goals WHERE id = ?", (tid,)).fetchone())


@router.delete("/{gid}/goals/{tid}", status_code=204)
async def delete_goal(gid: int, tid: int, body: PasswordIn) -> Response:
    """目標の削除（パスワード必須）"""
    await _require_password(body)
    with get_db() as db:
        if db.execute("DELETE FROM team_goals WHERE id=? AND group_id=?", (tid, gid)).rowcount == 0:
            raise HTTPException(404, "目標が見つかりません")
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
