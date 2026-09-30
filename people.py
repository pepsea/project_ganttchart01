"""個人ごとの担当（表示のみ）

個人の画面（/people）で、人ごとに担当領域・担当基盤技術・担当案件・担当グループ・担当サービス・
ガントチャートのタスクを表示するための集計 API。担当などは各画面のテーブルから読むだけ。
個人のメモ（person_notes）だけはこの画面で書き、人ごとに 1 件保存する。
人の一覧は、タスクの担当者・案件の PL / 担当者・基盤の PL / メンバー・サービスの PL / 担当者・グループの PL / メンバーから集める。
"""

import json
import re
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from db import get_db

router = APIRouter(prefix="/api/people", tags=["個人の担当"])

SOON_DAYS = 3  # ガントチャートと同じ: 終了日の 3 日前からオレンジ


def init_db() -> None:
    with get_db() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS person_notes (
                          name       TEXT PRIMARY KEY,   -- 名前（担当者・PL・メンバーの名前）
                          body       TEXT NOT NULL DEFAULT '',  -- メモ
                          updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                      )""")
        if "areas" not in {r["name"] for r in db.execute("PRAGMA table_info(person_notes)")}:
            # 担当領域（自分で設定。JSON 配列。領域は管理サイトの領域から選ぶ）
            db.execute("ALTER TABLE person_notes ADD COLUMN areas TEXT NOT NULL DEFAULT '[]'")


class MemoIn(BaseModel):
    body: str = ""


class AreasIn(BaseModel):
    areas: list[str] = []


@router.put("/{name}/areas")
def save_areas(name: str, a: AreasIn) -> dict:
    """個人の担当領域を保存（自分で設定。管理サイトに登録済みの領域から選ぶ）"""
    name = name.strip()
    areas = list(dict.fromkeys(x.strip() for x in a.areas if x and x.strip()))
    with get_db() as db:
        known = {r["name"] for r in db.execute("SELECT name FROM areas")}
        bad = [x for x in areas if x not in known]
        if bad:
            raise HTTPException(422, f"領域「{'、'.join(bad)}」は登録されていません（管理サイトで登録）")
        db.execute("""INSERT INTO person_notes(name, areas) VALUES (?, ?)
                      ON CONFLICT(name) DO UPDATE SET areas = excluded.areas, updated_at = datetime('now', 'localtime')""",
                   (name, json.dumps(areas, ensure_ascii=False)))
    return {"areas": areas}


@router.put("/{name}/memo")
def save_memo(name: str, m: MemoIn) -> dict:
    """個人のメモを保存（人ごとに 1 件。上書き）"""
    name = name.strip()
    with get_db() as db:
        db.execute("""INSERT INTO person_notes(name, body) VALUES (?, ?)
                      ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = datetime('now', 'localtime')""",
                   (name, m.body.rstrip()))
        r = db.execute("SELECT body, updated_at FROM person_notes WHERE name = ?", (name,)).fetchone()
    return {"memo": r["body"], "memo_updated_at": r["updated_at"]}


def _names(text: str) -> list[str]:
    return [n for n in re.split(r"[\s　]+", text or "") if n]


def _role(name: str, pl: str, members: str) -> str | None:
    """PL / メンバー / 対象外（None）"""
    if name in _names(pl):
        return "PL"
    if name in _names(members):
        return "メンバー"
    return None


def task_state(start: str, end: str, today: date | None = None) -> str:
    """overdue = 期限超過 / soon = 期限 3 日以内 / active = 実施中 / waiting = 開始前"""
    today = today or date.today()
    s, e = date.fromisoformat(start), date.fromisoformat(end)
    if e < today:
        return "overdue"
    if e <= today + timedelta(days=SOON_DAYS):
        return "soon"
    if s <= today:
        return "active"
    return "waiting"


@router.get("")
def list_people() -> list[dict]:
    """登録されている人の一覧（名前順）と、担当の件数・タスクの状態ごとの件数"""
    names: set[str] = set()
    with get_db() as db:
        for sql in ("SELECT assignee FROM tasks", "SELECT pl || ' ' || assignees FROM cases",
                    "SELECT owner || ' ' || members FROM platforms", "SELECT pl || ' ' || members FROM services",
                    "SELECT pl || ' ' || members FROM team_groups"):
            for r in db.execute(sql):
                names.update(_names(r[0]))
    out = []
    for n in sorted(names):
        d = person(n)
        out.append({"name": n, "task_counts": d["task_counts"], "tasks": len(d["tasks"]), "cases": len(d["cases"]),
                    "platforms": len(d["platforms"]), "services": len(d["services"]), "groups": len(d["groups"])})
    return out


@router.get("/{name}")
def person(name: str) -> dict:
    name = name.strip()
    areas: dict[str, None] = {}  # 順序つきの集合

    def add_areas(items):
        for a in items:
            if a:
                areas.setdefault(a, None)

    with get_db() as db:
        case_names = {r["case_no"]: r["name"] for r in db.execute("SELECT case_no, name FROM cases")}
        pf_titles = {r["name"]: r["title"] for r in db.execute("SELECT name, title FROM platforms")}

        tasks = []
        for r in db.execute("SELECT * FROM tasks ORDER BY end_date, start_date, id"):
            if name not in _names(r["assignee"]):
                continue
            proj = r["project"]
            tasks.append({
                "id": r["id"], "task": r["task"], "area": r["area"], "project": proj,
                "project_name": case_names.get(proj) or pf_titles.get(proj) or "",
                "priority": r["priority"], "start_date": r["start_date"], "end_date": r["end_date"],
                "state": task_state(r["start_date"], r["end_date"]),
            })
            add_areas([r["area"]])

        cases = []
        for r in db.execute("SELECT * FROM cases WHERE status NOT IN ('キャンセル', 'アーカイブ') ORDER BY COALESCE(end_date, '9999'), case_no"):
            role = _role(name, r["pl"], r["assignees"])
            if role:
                a = json.loads(r["areas"] or "[]")
                cases.append({"case_no": r["case_no"], "trial": r["trial"], "name": r["name"], "customer": r["customer"],
                              "status": r["status"], "role": role, "end_date": r["end_date"], "areas": a})
                add_areas(a)

        platforms = []
        for r in db.execute("SELECT * FROM platforms ORDER BY name"):
            role = _role(name, r["owner"], r["members"])
            if role:
                a = json.loads(r["areas"] or "[]")
                platforms.append({"name": r["name"], "title": r["title"], "role": role, "areas": a})
                add_areas(a)

        services = []
        for r in db.execute("SELECT * FROM services ORDER BY service_no"):
            role = _role(name, r["pl"], r["members"])
            if role:
                a = json.loads(r["areas"] or "[]")
                services.append({"service_no": r["service_no"], "name": r["name"], "role": role, "areas": a})
                add_areas(a)

        # グループでは PL を「リーダー」と表示する
        groups = [{"id": r["id"], "name": r["name"], "role": "リーダー" if role == "PL" else role}
                  for r in db.execute("SELECT id, name, pl, members FROM team_groups ORDER BY created_at DESC, id DESC")
                  if (role := _role(name, r["pl"], r["members"]))]

        # 達成したこと: グループ目標の「達成したこと」で担当者にこの人が入っているもの（新しい順）
        achievements = [{"id": r["id"], "group_id": r["group_id"], "group": r["group_name"], "title": r["title"],
                         "goal": r["goal_title"] or "",
                         "achieved_on": r["achieved_on"], "fiscal_year": r["fiscal_year"], "note": r["note"], "url": r["url"]}
                        for r in db.execute("SELECT a.*, g.name AS group_name, tg.title AS goal_title FROM team_achievements a"
                                            " JOIN team_groups g ON g.id = a.group_id"
                                            " LEFT JOIN team_goals tg ON tg.id = a.goal_id AND tg.group_id = a.group_id"
                                            " ORDER BY COALESCE(NULLIF(a.achieved_on, ''), a.created_at) DESC, a.id DESC")
                        if name in _names(r["owner"])]

        memo = db.execute("SELECT body, areas, updated_at FROM person_notes WHERE name = ?", (name,)).fetchone()

    counts = {}
    for t in tasks:
        counts[t["state"]] = counts.get(t["state"], 0) + 1
    # areas = 自分で設定した担当領域、auto_areas = 担当の案件・タスクなどに出てくる領域（参考）
    return {"name": name, "areas": json.loads(memo["areas"] or "[]") if memo else [], "auto_areas": list(areas), "tasks": tasks, "task_counts": counts, "cases": cases,
            "platforms": platforms, "services": services, "groups": groups, "achievements": achievements,
            "memo": memo["body"] if memo else "", "memo_updated_at": memo["updated_at"] if memo else ""}
