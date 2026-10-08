"""自社リンク・ナレッジ API

自社リンク画面の「自社サイト（tech。もとの自社技術リンク）」「グループサイト（own。もとの WEB リンク（自社サービス））」と、
ナレッジ画面の「ナレッジ（knowledge）」「参考リンク（other。もとの WEB リンク（その他参考））」を管理する。
"""

import asyncio
import json
import re
import sqlite3
from typing import Literal

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator

import auth
from csvutil import csv_response, read_csv, split_list
from db import ensure_master, get_db

router = APIRouter(prefix="/api/links", tags=["自社リンク・ナレッジ"])

Category = Literal["tech", "own", "other", "knowledge"]


def init_db() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS ref_links (
                   id         INTEGER PRIMARY KEY AUTOINCREMENT,
                   category   TEXT NOT NULL DEFAULT 'other',  -- tech = 自社サイト（もと自社技術リンク） / own = グループサイト（もと自社サービスの WEB リンク） / other = 参考リンク / knowledge = ナレッジ
                   title      TEXT NOT NULL,                   -- 名前
                   url        TEXT NOT NULL,
                   note       TEXT NOT NULL DEFAULT '',        -- 説明
                   sort_order INTEGER NOT NULL DEFAULT 0,      -- 表示順（カテゴリ内）
                   created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )
        cols = {r["name"] for r in db.execute("PRAGMA table_info(ref_links)")}
        if "areas" not in cols:  # 領域（複数。JSON 配列）
            db.execute("ALTER TABLE ref_links ADD COLUMN areas TEXT NOT NULL DEFAULT '[]'")


class LinkIn(BaseModel):
    category: Category = "other"
    title: str = Field(min_length=1)
    url: str = Field(min_length=1)
    note: str = ""
    areas: list[str] = []   # 領域（複数可）

    @field_validator("areas")
    @classmethod
    def uniq_areas(cls, v):
        return list(dict.fromkeys(a.strip() for a in v if a and a.strip()))

    @field_validator("title", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("url", mode="before")
    @classmethod
    def check_url(cls, v):
        v = (v or "").strip()
        if not re.match(r"^https?://", v, re.I):
            raise ValueError("URL は http:// または https:// で始まるものを入力してください")
        return v


class MoveIn(BaseModel):
    direction: Literal["up", "down"]


class PasswordIn(BaseModel):
    password: str = ""


def _to_link(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["areas"] = json.loads(d.get("areas") or "[]")
    return d


def _fetch(db: sqlite3.Connection, lid: int) -> dict:
    row = db.execute("SELECT * FROM ref_links WHERE id = ?", (lid,)).fetchone()
    if row is None:
        raise HTTPException(404, "リンクが見つかりません")
    return _to_link(row)


@router.get("")
def list_links() -> list[dict]:
    with get_db() as db:
        return [_to_link(r) for r in db.execute("SELECT * FROM ref_links ORDER BY category, sort_order, id")]


# ---------------------------------------------------------------- CSV（エクスポート・インポート）

CATEGORY_LABELS = {"tech": "自社サイト", "own": "グループサイト", "other": "その他参考", "knowledge": "ナレッジ"}
EXPORT_HEADERS = ["欄", "名前", "URL", "説明", "領域", "表示順"]


@router.get("/export.csv")
def export_csv() -> Response:
    """全リンクを 1 リンク 1 行で出力（このファイルをインポートすれば元に戻せる）"""
    rows = [EXPORT_HEADERS]
    for l in list_links():
        rows.append([CATEGORY_LABELS[l["category"]], l["title"], l["url"], l["note"], "、".join(l["areas"]), l["sort_order"]])
    return csv_response(rows, "links")


@router.post("/import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """リンク CSV を取り込む。欄と URL が同じリンクは更新（空欄のセルは今の値のまま）、無ければ欄の最後に追加。
    1 行でもエラーがあれば何も取り込まない。"""
    rows = read_csv(await file.read(), ["名前", "URL"])
    cat_by_label = {v: k for k, v in CATEGORY_LABELS.items()} | {k: k for k in CATEGORY_LABELS} | {
        "WEB リンク（自社サービス）": "own", "自社技術リンク": "tech", "自社サービス": "own", "WEB リンク（その他参考）": "other", "参考リンク": "other"}
    added = updated = 0
    with get_db() as db:
        for line, r in rows:
            cat = cat_by_label.get(r.get("欄") or "その他参考")
            if not cat:
                raise HTTPException(422, f"{line} 行目: 欄は「自社サイト」「グループサイト」「その他参考」「ナレッジ」のいずれかにしてください")
            row = db.execute("SELECT * FROM ref_links WHERE category = ? AND url = ? ORDER BY id LIMIT 1",
                             (cat, r.get("URL", ""))).fetchone()
            cur = _to_link(row) if row else {}
            data = {"category": cat, "title": r.get("名前") or cur.get("title", ""), "url": r.get("URL", ""),
                    "note": r.get("説明") or cur.get("note", ""),
                    "areas": split_list(r["領域"]) if r.get("領域") else cur.get("areas", [])}
            try:
                l = LinkIn(**data)
            except ValidationError as e:
                msg = "; ".join(err["msg"].replace("Value error, ", "") for err in e.errors())
                raise HTTPException(422, f"{line} 行目（{r.get('名前', '')}）: {msg}")
            try:
                order = int(r["表示順"]) if r.get("表示順") else None
            except ValueError:
                raise HTTPException(422, f"{line} 行目: 表示順は数字にしてください")
            for a in l.areas:
                ensure_master(db, "areas", a)
            areas = json.dumps(l.areas, ensure_ascii=False)
            if row:
                db.execute("UPDATE ref_links SET title=?, note=?, areas=?, sort_order=COALESCE(?, sort_order),"
                           " updated_at=datetime('now','localtime') WHERE id=?", (l.title, l.note.strip(), areas, order, row["id"]))
                updated += 1
            else:
                if order is None:
                    order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ref_links WHERE category = ?",
                                       (cat,)).fetchone()[0]
                db.execute("INSERT INTO ref_links(category, title, url, note, sort_order, areas) VALUES (?,?,?,?,?,?)",
                           (cat, l.title, l.url, l.note.strip(), order, areas))
                added += 1
    return {"added": added, "updated": updated}


@router.post("", status_code=201)
def create_link(l: LinkIn) -> dict:
    with get_db() as db:
        order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ref_links WHERE category = ?",
                           (l.category,)).fetchone()[0]
        for a in l.areas:
            ensure_master(db, "areas", a)
        cur = db.execute("INSERT INTO ref_links(category, title, url, note, sort_order, areas) VALUES (?,?,?,?,?,?)",
                         (l.category, l.title, l.url, l.note.strip(), order, json.dumps(l.areas, ensure_ascii=False)))
        return _fetch(db, cur.lastrowid)


@router.put("/{lid}")
def update_link(lid: int, l: LinkIn) -> dict:
    with get_db() as db:
        cur = _fetch(db, lid)
        order = cur["sort_order"]
        if cur["category"] != l.category:  # 欄を移したら移動先の最後に
            order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM ref_links WHERE category = ?",
                               (l.category,)).fetchone()[0]
        for a in l.areas:
            ensure_master(db, "areas", a)
        db.execute("UPDATE ref_links SET category=?, title=?, url=?, note=?, sort_order=?, areas=?,"
                   " updated_at=datetime('now','localtime') WHERE id=?",
                   (l.category, l.title, l.url, l.note.strip(), order, json.dumps(l.areas, ensure_ascii=False), lid))
        return _fetch(db, lid)


class ReorderIn(BaseModel):
    category: Category
    ids: list[int]


@router.post("/reorder")
def reorder_links(r: ReorderIn) -> list[dict]:
    """欄の中の順番をまとめて保存（ドラッグ＆ドロップ）。ids はその欄の全リンクを新しい順番で"""
    with get_db() as db:
        current = {row["id"] for row in db.execute("SELECT id FROM ref_links WHERE category = ?", (r.category,))}
        if set(r.ids) != current or len(r.ids) != len(current):
            raise HTTPException(409, "リンクの一覧が変わっています。画面を読み込み直してから並べ替えてください")
        for n, rid in enumerate(r.ids, start=1):
            db.execute("UPDATE ref_links SET sort_order = ? WHERE id = ?", (n, rid))
    return list_links()


@router.post("/{lid}/move")
def move_link(lid: int, m: MoveIn) -> list[dict]:
    """同じ欄の中で 1 つ上／下と入れ替える"""
    with get_db() as db:
        cur = _fetch(db, lid)
        rows = [dict(r) for r in db.execute("SELECT id, sort_order FROM ref_links WHERE category = ? ORDER BY sort_order, id",
                                            (cur["category"],))]
        ids = [r["id"] for r in rows]
        i = ids.index(lid)
        j = i - 1 if m.direction == "up" else i + 1
        if 0 <= j < len(ids):
            ids[i], ids[j] = ids[j], ids[i]
            for n, rid in enumerate(ids, start=1):  # 並び順を振り直す
                db.execute("UPDATE ref_links SET sort_order = ? WHERE id = ?", (n, rid))
    return list_links()


@router.delete("/{lid}", status_code=204)
async def delete_link(lid: int, body: PasswordIn) -> Response:
    """リンクの削除（パスワード必須）"""
    if not auth.check_password(body.password):
        await asyncio.sleep(1)
        raise HTTPException(403, "パスワードが正しくないため削除できません")
    with get_db() as db:
        _fetch(db, lid)
        db.execute("DELETE FROM ref_links WHERE id = ?", (lid,))
    return Response(status_code=204)
