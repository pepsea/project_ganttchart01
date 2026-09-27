"""共有資料リンク API

資料名・目的・領域・作成日時と、資料へのリンクを最大 4 つ（それぞれ表示名つき）管理する。
"""

import asyncio
import json
import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, HTTPException, Response
from typing import Literal

from pydantic import BaseModel, Field, field_validator

import auth
from db import ensure_master, get_db

router = APIRouter(prefix="/api/documents", tags=["共有資料"])

LINK_COUNT = 4  # 資料リンクの最大数
COLS = ("title", "purpose", "created_date", "link1_label", "link1_url", "link2_label", "link2_url", "areas",
        "link3_label", "link3_url", "link4_label", "link4_url", "category")
Category = Literal["group", "other"]  # group = グループ資料（左）/ other = その他参考資料（右）


def init_db() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS documents (
                   id           INTEGER PRIMARY KEY AUTOINCREMENT,
                   title        TEXT NOT NULL,             -- 資料名
                   purpose      TEXT NOT NULL DEFAULT '',  -- 目的
                   created_date TEXT NOT NULL DEFAULT '',  -- 作成日時（YYYY-MM-DD HH:MM）
                   link1_label  TEXT NOT NULL DEFAULT '',  -- 資料リンク 1 の表示名
                   link1_url    TEXT NOT NULL DEFAULT '',
                   link2_label  TEXT NOT NULL DEFAULT '',  -- 資料リンク 2 の表示名
                   link2_url    TEXT NOT NULL DEFAULT '',
                   created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )
        cols = {r["name"] for r in db.execute("PRAGMA table_info(documents)")}
        if "areas" not in cols:  # 領域（複数。JSON 配列）
            db.execute("ALTER TABLE documents ADD COLUMN areas TEXT NOT NULL DEFAULT '[]'")
        for col in ("link3_label", "link3_url", "link4_label", "link4_url"):  # 資料リンク 3・4
            if col not in cols:
                db.execute(f"ALTER TABLE documents ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
        if "category" not in cols:  # 欄（既存の資料はグループ資料）
            db.execute("ALTER TABLE documents ADD COLUMN category TEXT NOT NULL DEFAULT 'group'")


def _url(v):
    v = (v or "").strip()
    if v and not re.match(r"^https?://", v, re.I):
        raise ValueError("リンクは http:// または https:// で始まる URL を入力してください")
    return v


class DocumentIn(BaseModel):
    title: str = Field(min_length=1)
    purpose: str = ""
    created_date: str = Field(default="", validate_default=True)  # 未入力でも検証して現在日時を入れる
    link1_label: str = ""
    link1_url: str = ""
    link2_label: str = ""
    link2_url: str = ""
    link3_label: str = ""
    link3_url: str = ""
    link4_label: str = ""
    link4_url: str = ""
    areas: list[str] = []   # 領域（複数可）
    category: Category = "group"

    @field_validator("areas")
    @classmethod
    def uniq_areas(cls, v):
        return list(dict.fromkeys(a.strip() for a in v if a and a.strip()))

    @field_validator("title", "link1_label", "link2_label", "link3_label", "link4_label", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("link1_url", "link2_url", "link3_url", "link4_url", mode="before")
    @classmethod
    def urls(cls, v):
        return _url(v)

    @field_validator("created_date", mode="before")
    @classmethod
    def when(cls, v):
        """作成日時: 未入力なら現在日時。YYYY-MM-DD / YYYY-MM-DD HH:MM / YYYY-MM-DDTHH:MM を受け付ける"""
        v = (v or "").strip().replace("T", " ").replace("/", "-")
        if not v:
            return datetime.now().strftime("%Y-%m-%d %H:%M")
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(v, fmt).strftime("%Y-%m-%d %H:%M" if " " in v else "%Y-%m-%d")
            except ValueError:
                pass
        raise ValueError("作成日時は YYYY-MM-DD HH:MM の形式で入力してください")

    def values(self) -> tuple:
        return (self.title, self.purpose.strip(), self.created_date, self.link1_label, self.link1_url,
                self.link2_label, self.link2_url, json.dumps(self.areas, ensure_ascii=False),
                self.link3_label, self.link3_url, self.link4_label, self.link4_url, self.category)


class PasswordIn(BaseModel):
    password: str = ""


def _to_doc(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["areas"] = json.loads(d.get("areas") or "[]")
    return d


def _fetch(db: sqlite3.Connection, did: int) -> dict:
    row = db.execute("SELECT * FROM documents WHERE id = ?", (did,)).fetchone()
    if row is None:
        raise HTTPException(404, "資料が見つかりません")
    return _to_doc(row)


@router.get("")
def list_documents() -> list[dict]:
    with get_db() as db:
        return [_to_doc(r) for r in db.execute("SELECT * FROM documents ORDER BY created_date DESC, id DESC")]


@router.post("", status_code=201)
def create_document(d: DocumentIn) -> dict:
    with get_db() as db:
        for a in d.areas:
            ensure_master(db, "areas", a)
        cur = db.execute(f"INSERT INTO documents({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})", d.values())
        return _fetch(db, cur.lastrowid)


@router.put("/{did}")
def update_document(did: int, d: DocumentIn) -> dict:
    with get_db() as db:
        _fetch(db, did)
        for a in d.areas:
            ensure_master(db, "areas", a)
        db.execute(f"UPDATE documents SET {', '.join(c + '=?' for c in COLS)}, updated_at=datetime('now','localtime')"
                   " WHERE id=?", (*d.values(), did))
        return _fetch(db, did)


@router.delete("/{did}", status_code=204)
async def delete_document(did: int, body: PasswordIn) -> Response:
    """資料の削除（パスワード必須。リンク先の資料そのものは削除されない）"""
    if not auth.check_password(body.password):
        await asyncio.sleep(1)
        raise HTTPException(403, "パスワードが正しくないため削除できません")
    with get_db() as db:
        _fetch(db, did)
        db.execute("DELETE FROM documents WHERE id = ?", (did,))
    return Response(status_code=204)
