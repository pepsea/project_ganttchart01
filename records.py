"""記録（アイディア・メモの保管庫）

画面の「記録」タブ。別アプリ（task_management01）の IDEA と同じ構造:
タイトルを入れて登録 → 一覧（⋮⋮ 並べ替え・★ 優先・タイトル・タグ）→ 開くと編集欄（タイトル・Markdown の本文・タグ。自動保存）。
優先（★）は先頭にまとまり、そのあとは手で入れ替えた順。新しい記録は一番上に入る。
"""

import asyncio
import json

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

import auth
from db import get_db

router = APIRouter(prefix="/api/records", tags=["記録"])

ORDER = "ORDER BY prioritized DESC, position, id DESC"  # 優先（★）が先頭 → 手で入れ替えた順 → 新しい順


def init_db() -> None:
    with get_db() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS records (
                          id          INTEGER PRIMARY KEY AUTOINCREMENT,
                          title       TEXT NOT NULL,
                          body        TEXT NOT NULL DEFAULT '',      -- 本文（Markdown）
                          tags        TEXT NOT NULL DEFAULT '[]',    -- タグ（JSON 配列）
                          prioritized INTEGER NOT NULL DEFAULT 0,    -- 優先（★）。優先は先頭にまとまる
                          position    INTEGER NOT NULL DEFAULT 0,    -- 手で入れ替えた並び順（小さいほど上）
                          created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                          updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                      )""")


class RecordCreate(BaseModel):
    title: str = Field(min_length=1)
    body: str = ""


class RecordUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    body: str | None = None
    tags: list[str] | None = None
    prioritized: bool | None = None


class Reorder(BaseModel):
    ids: list[int]


class PasswordIn(BaseModel):
    password: str = ""


def _to_record(row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d["tags"] or "[]")
    d["prioritized"] = bool(d["prioritized"])
    return d


def _fetch(db, rid: int) -> dict:
    row = db.execute("SELECT * FROM records WHERE id = ?", (rid,)).fetchone()
    if row is None:
        raise HTTPException(404, "記録が見つかりません")
    return _to_record(row)


@router.get("")
def list_records(q: str = "", tag: str = "") -> list[dict]:
    with get_db() as db:
        rows = [_to_record(r) for r in db.execute(f"SELECT * FROM records {ORDER}")]
    q = q.strip().lower()
    return [r for r in rows
            if (not q or q in r["title"].lower() or q in r["body"].lower()) and (not tag or tag in r["tags"])]


@router.get("/tags")
def list_tags() -> list[str]:
    """タグの候補（付いているタグ。名前順）"""
    with get_db() as db:
        found = {t for r in db.execute("SELECT tags FROM records") for t in json.loads(r["tags"] or "[]")}
    return sorted(found)


@router.post("", status_code=201)
def create_record(r: RecordCreate) -> dict:
    title = r.title.strip()
    if not title:
        raise HTTPException(422, "タイトルは必須です")
    with get_db() as db:
        top = db.execute("SELECT COALESCE(MIN(position), 0) - 1 FROM records").fetchone()[0]  # 一覧の一番上
        cur = db.execute("INSERT INTO records(title, body, position) VALUES (?,?,?)", (title, r.body, top))
        return _fetch(db, cur.lastrowid)


@router.post("/reorder", status_code=204)
def reorder(r: Reorder) -> Response:
    """画面に出ている順に、並び順の値を割り当て直す（絞り込みで見えていない記録の位置は変わらない）"""
    if len(set(r.ids)) != len(r.ids):
        raise HTTPException(422, "同じ記録が重複しています")
    with get_db() as db:
        mine = [row["id"] for row in db.execute(f"SELECT id FROM records {ORDER}")]
        if not set(r.ids) <= set(mine):
            raise HTTPException(404, "記録が見つかりません")
        pos = {rid: n for n, rid in enumerate(mine)}  # 全体を 0, 1, 2… に振り直す
        slots = sorted(pos[i] for i in r.ids)
        for slot, rid in zip(slots, r.ids):  # 画面に出ていた記録が使っていた位置に、新しい順で割り当てる
            pos[rid] = slot
        for rid, n in pos.items():
            db.execute("UPDATE records SET position = ? WHERE id = ?", (n, rid))
    return Response(status_code=204)


@router.get("/{rid}")
def get_record(rid: int) -> dict:
    with get_db() as db:
        return _fetch(db, rid)


@router.put("/{rid}")
def update_record(rid: int, r: RecordUpdate) -> dict:
    with get_db() as db:
        _fetch(db, rid)
        sets, vals = [], []
        if r.title is not None:
            if not r.title.strip():
                raise HTTPException(422, "タイトルは必須です")
            sets.append("title = ?"); vals.append(r.title.strip())
        if r.body is not None:
            sets.append("body = ?"); vals.append(r.body)
        if r.tags is not None:
            sets.append("tags = ?")
            vals.append(json.dumps(list(dict.fromkeys(t.strip() for t in r.tags if t and t.strip())), ensure_ascii=False))
        if r.prioritized is not None:
            sets.append("prioritized = ?"); vals.append(int(r.prioritized))
        if sets:
            db.execute(f"UPDATE records SET {', '.join(sets)}, updated_at = datetime('now','localtime') WHERE id = ?", (*vals, rid))
        return _fetch(db, rid)


@router.delete("/{rid}", status_code=204)
async def delete_record(rid: int, body: PasswordIn) -> Response:
    """記録の削除（パスワード必須）"""
    if not auth.check_password(body.password):
        await asyncio.sleep(1)
        raise HTTPException(403, "パスワードが正しくないため削除できません")
    with get_db() as db:
        _fetch(db, rid)
        db.execute("DELETE FROM records WHERE id = ?", (rid,))
    return Response(status_code=204)
