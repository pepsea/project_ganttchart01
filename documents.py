"""共有資料リンク API

資料名・目的・領域・作成日時と、資料へのリンクを最大 4 つ（それぞれ表示名つき）管理する。
"""

import asyncio
import json
import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

import auth
from csvutil import csv_response, read_csv, split_list
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
        if "sort_order" not in cols:  # 手で入れ替えた順番（0 = 未設定。未設定の資料は上に、作成日時の新しい順で並ぶ）
            db.execute("ALTER TABLE documents ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")


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
        return [_to_doc(r) for r in db.execute("SELECT * FROM documents ORDER BY (sort_order <> 0), sort_order, created_date DESC, id DESC")]


# ---------------------------------------------------------------- CSV（エクスポート・インポート）

CATEGORY_LABELS = {"group": "グループ資料", "other": "その他参考資料"}
EXPORT_HEADERS = ["欄", "資料名", "目的", "作成日時", "領域",
                  *(h for i in range(1, LINK_COUNT + 1) for h in (f"リンク{i}の名前", f"リンク{i}"))]


@router.get("/export.csv")
def export_csv() -> Response:
    """全資料を 1 資料 1 行で出力（このファイルをインポートすれば元に戻せる）"""
    rows = [EXPORT_HEADERS]
    for d in list_documents():
        rows.append([CATEGORY_LABELS.get(d["category"], d["category"]), d["title"], d["purpose"], d["created_date"],
                     "、".join(d["areas"]),
                     *(d[f"link{i}_{k}"] for i in range(1, LINK_COUNT + 1) for k in ("label", "url"))])
    return csv_response(rows, "documents")


@router.post("/import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """資料 CSV を取り込む。欄と資料名が同じ資料は更新（空欄のセルは今の値のまま）、無ければ追加。
    1 行でもエラーがあれば何も取り込まない。"""
    rows = read_csv(await file.read(), ["資料名"])
    cat_by_label = {v: k for k, v in CATEGORY_LABELS.items()} | {k: k for k in CATEGORY_LABELS}
    added = updated = 0
    with get_db() as db:
        for line, r in rows:
            cat = cat_by_label.get(r.get("欄") or "グループ資料")
            if not cat:
                raise HTTPException(422, f"{line} 行目: 欄は「グループ資料」か「その他参考資料」にしてください")
            row = db.execute("SELECT * FROM documents WHERE title = ? AND category = ? ORDER BY id LIMIT 1",
                             (r.get("資料名", ""), cat)).fetchone()
            data = _to_doc(row) if row else {}
            data = {k: data.get(k) for k in COLS if k in data} | {"category": cat}
            for col, key in (("資料名", "title"), ("目的", "purpose"), ("作成日時", "created_date"),
                             *((f"リンク{i}の名前", f"link{i}_label") for i in range(1, LINK_COUNT + 1)),
                             *((f"リンク{i}", f"link{i}_url") for i in range(1, LINK_COUNT + 1))):
                if r.get(col):
                    data[key] = r[col]
            if r.get("領域"):
                data["areas"] = split_list(r["領域"])
            try:
                d = DocumentIn(**data)
            except ValidationError as e:
                msg = "; ".join(err["msg"].replace("Value error, ", "") for err in e.errors())
                raise HTTPException(422, f"{line} 行目（{r.get('資料名', '')}）: {msg}")
            for a in d.areas:
                ensure_master(db, "areas", a)
            if row:
                db.execute(f"UPDATE documents SET {', '.join(c + '=?' for c in COLS)}, updated_at=datetime('now','localtime')"
                           " WHERE id=?", (*d.values(), row["id"]))
                updated += 1
            else:
                db.execute(f"INSERT INTO documents({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})", d.values())
                added += 1
    return {"added": added, "updated": updated}


class ReorderIn(BaseModel):
    category: Category
    ids: list[int]


@router.post("/reorder")
def reorder_documents(r: ReorderIn) -> list[dict]:
    """欄（グループ資料 / その他参考資料）の中の順番をまとめて保存（ドラッグ＆ドロップ）"""
    with get_db() as db:
        current = {row["id"] for row in db.execute("SELECT id FROM documents WHERE category = ?", (r.category,))}
        if set(r.ids) != current or len(r.ids) != len(current):
            raise HTTPException(409, "資料の一覧が変わっています。画面を読み込み直してから並べ替えてください")
        for n, did in enumerate(r.ids, start=1):
            db.execute("UPDATE documents SET sort_order = ? WHERE id = ?", (n, did))
    return list_documents()


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
