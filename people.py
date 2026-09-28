"""個人ごとの担当（表示のみ）

個人の画面（/people）で、人ごとに担当領域・担当基盤技術・担当案件・担当グループ・担当サービス・
ガントチャートのタスクを表示するための集計 API。データは各画面のテーブルから読むだけで、新しいテーブルは持たない。
人の一覧は、タスクの担当者・案件の PL / 担当者・基盤の PL / メンバー・サービスの PL / 担当者・グループの PL / メンバーから集める。
"""

import json
import re
from datetime import date, timedelta

from fastapi import APIRouter

from db import get_db

router = APIRouter(prefix="/api/people", tags=["個人の担当"])

SOON_DAYS = 3  # ガントチャートと同じ: 終了日の 3 日前からオレンジ


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

        groups = [{"id": r["id"], "name": r["name"], "role": role}
                  for r in db.execute("SELECT id, name, pl, members FROM team_groups ORDER BY created_at DESC, id DESC")
                  if (role := _role(name, r["pl"], r["members"]))]

    counts = {}
    for t in tasks:
        counts[t["state"]] = counts.get(t["state"], 0) + 1
    return {"name": name, "areas": list(areas), "tasks": tasks, "task_counts": counts, "cases": cases,
            "platforms": platforms, "services": services, "groups": groups}
