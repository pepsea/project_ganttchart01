"""サービスメニュー API

サービスごとに、サービス名・番号・PL・担当者・領域・リンク（BOX / 紹介資料 日英）・関連する基盤技術・
ゴール・課題を管理する。タスクはガントチャートのタスク（PJ名 = 関連する基盤番号）を表示する。
"""

import asyncio
import csv
import io
import json
import re
import sqlite3
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator

import auth
import groups
from csvutil import decode_csv
from db import ensure_master, get_db

router = APIRouter(prefix="/api/services", tags=["サービス"])

URL_FIELDS = ("box_url", "intro_ja_url", "intro_en_url")
COLS = ("service_no", "name", "pl", "members", "areas", "box_url", "intro_ja_url", "intro_en_url",
        "platforms", "goal", "issues")


# ---------------------------------------------------------------- DB

def init_db() -> None:
    with get_db() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS services (
                   id           INTEGER PRIMARY KEY AUTOINCREMENT,
                   service_no   TEXT NOT NULL UNIQUE,      -- サービス番号
                   name         TEXT NOT NULL,             -- サービス名
                   pl           TEXT NOT NULL DEFAULT '',  -- PL
                   members      TEXT NOT NULL DEFAULT '',  -- 担当者（半角スペース区切り）
                   areas        TEXT NOT NULL DEFAULT '[]',-- 領域（JSON 配列）
                   box_url      TEXT NOT NULL DEFAULT '',
                   intro_ja_url TEXT NOT NULL DEFAULT '',  -- サービス紹介資料（日本語）
                   intro_en_url TEXT NOT NULL DEFAULT '',  -- サービス紹介資料（英語）
                   platforms    TEXT NOT NULL DEFAULT '[]',-- 関連する基盤番号（JSON 配列）
                   goal         TEXT NOT NULL DEFAULT '',  -- サービスのゴール
                   issues       TEXT NOT NULL DEFAULT '',  -- 課題
                   created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )
        # 画面の設定値（キーと値）。サービス画面の親リンクなど
        db.execute("""CREATE TABLE IF NOT EXISTS app_settings (
                          key   TEXT PRIMARY KEY,
                          value TEXT NOT NULL DEFAULT ''
                      )""")
        # 追加リンク（サービス紹介資料・パッケージ資料に、名前つきで何個でも）。kind = 'service' / 'package'、ref_id = services.id / service_packages.id
        db.execute("""CREATE TABLE IF NOT EXISTS service_links (
                          id         INTEGER PRIMARY KEY AUTOINCREMENT,
                          kind       TEXT NOT NULL,
                          ref_id     INTEGER NOT NULL,
                          label      TEXT NOT NULL DEFAULT '',  -- リンクの名前
                          url        TEXT NOT NULL,
                          sort_order INTEGER NOT NULL DEFAULT 0,
                          created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
                      )""")
        db.execute(
            """CREATE TABLE IF NOT EXISTS service_packages (
                   id           INTEGER PRIMARY KEY AUTOINCREMENT,
                   name         TEXT NOT NULL,             -- パッケージ名
                   intro_ja_url TEXT NOT NULL DEFAULT '',  -- パッケージ資料（日本語）
                   intro_en_url TEXT NOT NULL DEFAULT '',  -- パッケージ資料（英語）
                   box_url      TEXT NOT NULL DEFAULT '',
                   services     TEXT NOT NULL DEFAULT '[]',-- 関連サービス（サービス番号の JSON 配列）
                   sort_order   INTEGER NOT NULL DEFAULT 0,
                   created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
                   updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
               )"""
        )


# ---------------------------------------------------------------- Models

def _url(v):
    v = (v or "").strip()
    if v and not re.match(r"^https?://", v, re.I):
        raise ValueError("リンクは http:// または https:// で始まる URL を入力してください")
    return v


def _list(v: list[str]) -> list[str]:
    return list(dict.fromkeys(x.strip() for x in v if x and x.strip()))


class ExtraLink(BaseModel):
    label: str = ""
    url: str = ""

    @field_validator("label", mode="before")
    @classmethod
    def strip_label(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("url", mode="before")
    @classmethod
    def check_url(cls, v):
        return _url(v)


def attach_links(db: sqlite3.Connection, kind: str, items: list[dict]) -> list[dict]:
    """各項目に追加リンク（extra_links: [{label, url}]。並び順）を付ける"""
    by_ref: dict[int, list[dict]] = {}
    for r in db.execute("SELECT ref_id, label, url FROM service_links WHERE kind = ? ORDER BY ref_id, sort_order, id", (kind,)):
        by_ref.setdefault(r["ref_id"], []).append({"label": r["label"], "url": r["url"]})
    for it in items:
        it["extra_links"] = by_ref.get(it["id"], [])
    return items


def save_links(db: sqlite3.Connection, kind: str, ref_id: int, links: list[ExtraLink] | None) -> None:
    """追加リンクを入力どおりに置き換える（None なら変更しない。URL が空の行は除く）"""
    if links is None:
        return
    db.execute("DELETE FROM service_links WHERE kind = ? AND ref_id = ?", (kind, ref_id))
    n = 0
    for lk in links:
        if lk.url:
            n += 1
            db.execute("INSERT INTO service_links(kind, ref_id, label, url, sort_order) VALUES (?,?,?,?,?)",
                       (kind, ref_id, lk.label, lk.url, n))


class ServiceIn(BaseModel):
    extra_links: list[ExtraLink] | None = None  # サービス紹介資料の追加リンク（何個でも）。None なら変更しない
    service_no: str = Field(min_length=1)
    name: str = Field(min_length=1)
    pl: str = ""
    members: str = ""
    areas: list[str] = []
    box_url: str = ""
    intro_ja_url: str = ""
    intro_en_url: str = ""
    platforms: list[str] = []
    goal: str = ""
    issues: str = ""

    @field_validator("service_no", "name", "pl", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("members", mode="before")
    @classmethod
    def people(cls, v):
        return " ".join(dict.fromkeys(n for n in re.split(r"[\s　]+", v or "") if n))

    @field_validator("areas", "platforms")
    @classmethod
    def uniq(cls, v):
        return _list(v)

    @field_validator(*URL_FIELDS, mode="before")
    @classmethod
    def urls(cls, v):
        return _url(v)

    def values(self) -> tuple:
        return (self.service_no, self.name, self.pl, self.members, json.dumps(self.areas, ensure_ascii=False),
                self.box_url, self.intro_ja_url, self.intro_en_url, json.dumps(self.platforms, ensure_ascii=False),
                self.goal.strip(), self.issues.strip())


class PasswordIn(BaseModel):
    password: str = ""


# ---------------------------------------------------------------- helpers

def to_service(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["areas"] = json.loads(d["areas"] or "[]")
    d["platforms"] = json.loads(d["platforms"] or "[]")
    return d


def fetch(db: sqlite3.Connection, sid: int) -> dict:
    row = db.execute("SELECT * FROM services WHERE id = ?", (sid,)).fetchone()
    if row is None:
        raise HTTPException(404, "サービスが見つかりません")
    return attach_links(db, "service", [to_service(row)])[0]


def check_platforms(db: sqlite3.Connection, s: ServiceIn) -> None:
    unknown = [p for p in s.platforms if not db.execute("SELECT 1 FROM platforms WHERE name = ?", (p,)).fetchone()]
    if unknown:
        raise HTTPException(422, f"基盤番号「{'、'.join(unknown)}」は登録されていません（管理サイトで登録してください）")


def write(db: sqlite3.Connection, sql: str, params: tuple, no: str):
    try:
        return db.execute(sql, params)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"サービス番号「{no}」は既に登録されています")


# ---------------------------------------------------------------- API

@router.get("")
def list_services() -> list[dict]:
    with get_db() as db:
        return attach_links(db, "service", [to_service(r) for r in db.execute("SELECT * FROM services ORDER BY service_no, id")])


# ---------------------------------------------------------------- 親リンク（サービス画面の一番上）

class ParentLinkIn(BaseModel):
    label: str = ""
    url: str = ""

    @field_validator("url", mode="before")
    @classmethod
    def check(cls, v):
        return _url(v)


@router.get("/parent-link")
def get_parent_link() -> dict:
    with get_db() as db:
        row = db.execute("SELECT value FROM app_settings WHERE key = 'services.parent_link'").fetchone()
    data = json.loads(row["value"]) if row and row["value"] else {}
    return {"label": data.get("label", ""), "url": data.get("url", "")}


@router.put("/parent-link")
def set_parent_link(p: ParentLinkIn) -> dict:
    value = json.dumps({"label": p.label.strip(), "url": p.url}, ensure_ascii=False)
    with get_db() as db:
        db.execute("INSERT INTO app_settings(key, value) VALUES ('services.parent_link', ?)"
                   " ON CONFLICT(key) DO UPDATE SET value = excluded.value", (value,))
    return get_parent_link()


# ---------------------------------------------------------------- 主要サービスパッケージ

class PackageIn(BaseModel):
    extra_links: list[ExtraLink] | None = None  # パッケージ資料の追加リンク（何個でも）。None なら変更しない
    name: str = Field(min_length=1)
    intro_ja_url: str = ""
    intro_en_url: str = ""
    box_url: str = ""
    services: list[str] = []

    @field_validator("name", mode="before")
    @classmethod
    def strip(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("intro_ja_url", "intro_en_url", "box_url", mode="before")
    @classmethod
    def urls(cls, v):
        return _url(v)

    @field_validator("services")
    @classmethod
    def uniq(cls, v):
        return _list(v)


def to_package(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["services"] = json.loads(d["services"] or "[]")
    return d


def _replace_in_packages(db: sqlite3.Connection, old: str, new: str | None) -> None:
    for r in db.execute("SELECT id, services FROM service_packages").fetchall():
        items = json.loads(r["services"] or "[]")
        if old in items:
            items = [new if x == old else x for x in items if new is not None or x != old]
            db.execute("UPDATE service_packages SET services = ? WHERE id = ?",
                       (json.dumps(list(dict.fromkeys(items)), ensure_ascii=False), r["id"]))


def _check_services(db: sqlite3.Connection, pkg: PackageIn) -> None:
    unknown = [n for n in pkg.services if not db.execute("SELECT 1 FROM services WHERE service_no = ?", (n,)).fetchone()]
    if unknown:
        raise HTTPException(422, f"サービス番号「{'、'.join(unknown)}」は登録されていません")


def _fetch_package(db: sqlite3.Connection, pid: int) -> dict:
    row = db.execute("SELECT * FROM service_packages WHERE id = ?", (pid,)).fetchone()
    if row is None:
        raise HTTPException(404, "パッケージが見つかりません")
    return attach_links(db, "package", [to_package(row)])[0]


PKG_COLS = ("name", "intro_ja_url", "intro_en_url", "box_url", "services")


def _pkg_values(p: PackageIn) -> tuple:
    return (p.name, p.intro_ja_url, p.intro_en_url, p.box_url, json.dumps(p.services, ensure_ascii=False))


@router.get("/packages")
def list_packages() -> list[dict]:
    with get_db() as db:
        return attach_links(db, "package", [to_package(r) for r in db.execute("SELECT * FROM service_packages ORDER BY sort_order, id")])


@router.post("/packages", status_code=201)
def create_package(p: PackageIn) -> dict:
    with get_db() as db:
        _check_services(db, p)
        order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM service_packages").fetchone()[0]
        cur = db.execute(f"INSERT INTO service_packages({', '.join(PKG_COLS)}, sort_order) VALUES (?,?,?,?,?,?)",
                         (*_pkg_values(p), order))
        save_links(db, "package", cur.lastrowid, p.extra_links)
        return _fetch_package(db, cur.lastrowid)


@router.put("/packages/{pid}")
def update_package(pid: int, p: PackageIn) -> dict:
    with get_db() as db:
        _fetch_package(db, pid)
        _check_services(db, p)
        db.execute(f"UPDATE service_packages SET {', '.join(c + '=?' for c in PKG_COLS)},"
                   " updated_at=datetime('now','localtime') WHERE id=?", (*_pkg_values(p), pid))
        save_links(db, "package", pid, p.extra_links)
        return _fetch_package(db, pid)


@router.delete("/packages/{pid}", status_code=204)
async def delete_package(pid: int, body: PasswordIn) -> Response:
    """パッケージの削除（パスワード必須。サービス自体は削除しない）"""
    if not auth.check_password(body.password):
        await asyncio.sleep(1)
        raise HTTPException(403, "パスワードが正しくないため削除できません")
    with get_db() as db:
        _fetch_package(db, pid)
        db.execute("DELETE FROM service_packages WHERE id = ?", (pid,))
        db.execute("DELETE FROM service_links WHERE kind = 'package' AND ref_id = ?", (pid,))
    return Response(status_code=204)


# ---------------------------------------------------------------- CSV（エクスポート・インポート）
# 列名 -> 項目。エクスポートとインポートで同じ列名を使う
CSV_COLUMNS = [
    ("サービス番号", "service_no"), ("サービス名", "name"), ("PL", "pl"), ("担当者", "members"),
    ("領域", "areas"), ("関連する基盤技術", "platforms"), ("BOXリンク", "box_url"),
    ("サービス資料（日）リンク", "intro_ja_url"), ("サービス資料（英）リンク", "intro_en_url"),
    ("ゴール", "goal"), ("課題", "issues"),
]
SPLIT = re.compile(r"[\s\u3000;；、,/／]+")


def _filtered(area: str, person: str) -> list[dict]:
    def ok(s: dict) -> bool:
        people = (s["members"] or "").split(" ")
        return (not area or area in s["areas"]) and (not person or s["pl"] == person or person in people)
    return [s for s in list_services() if ok(s)]


@router.get("/export.csv")
def export_csv(area: str = "", person: str = "") -> Response:
    """サービス一覧: 1 サービス 1 行（領域・関連する基盤技術は「、」区切り）"""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([c for c, _ in CSV_COLUMNS] + ["更新日時"])
    for s in _filtered(area, person):
        w.writerow([("、".join(s[k]) if k in ("areas", "platforms") else s[k]) for _, k in CSV_COLUMNS] + [s["updated_at"]])
    filename = f"services_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return Response(buf.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/import")
async def import_csv(file: UploadFile = File(...)) -> dict:
    """サービスの CSV を取り込む（サービス番号が一致すれば更新、なければ追加）。

    - 更新時、CSV に無い列・空欄のセルは元の値のまま（誤って消さないため）
    - 関連する基盤技術は登録済みの基盤番号のみ（未登録はエラー）
    - 1 行でもエラーがあれば何も取り込まない
    """
    reader = csv.DictReader(io.StringIO(decode_csv(await file.read())))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    if "サービス番号" not in headers:
        raise HTTPException(422, "「サービス番号」列がありません（サービスのエクスポートと同じ形式の CSV を選んでください）")
    reader.fieldnames = headers
    colmap = {c: k for c, k in CSV_COLUMNS if c in headers}
    added = updated = 0
    seen: set[str] = set()
    with get_db() as db:
        for line, raw in enumerate(reader, start=2):
            r = {k: (raw.get(c) or "").strip() for c, k in colmap.items()}
            if not any(r.values()):
                continue
            no = r.get("service_no", "")
            if not no:
                raise HTTPException(422, f"{line} 行目: サービス番号は必須です")
            if no in seen:
                raise HTTPException(422, f"{line} 行目: サービス番号「{no}」が CSV 内で重複しています")
            seen.add(no)
            row = db.execute("SELECT * FROM services WHERE service_no = ?", (no,)).fetchone()
            data = {k: v for k, v in to_service(row).items() if k in dict(CSV_COLUMNS).values()} if row else {}
            for k, v in r.items():
                if row and not v:
                    continue  # 更新時の空欄は元の値のまま
                data[k] = [x for x in SPLIT.split(v) if x] if k in ("areas", "platforms") else v
            if not data.get("name"):
                raise HTTPException(422, f"{line} 行目（{no}）: サービス名は必須です")
            try:
                svc = ServiceIn(**data)
            except ValidationError as e:
                msg = "; ".join(err["msg"].replace("Value error, ", "") for err in e.errors())
                raise HTTPException(422, f"{line} 行目（{no}）: {msg}")
            try:
                check_platforms(db, svc)
            except HTTPException as e:
                raise HTTPException(422, f"{line} 行目（{no}）: {e.detail}")
            for a in svc.areas:
                ensure_master(db, "areas", a)
            if row:
                new = svc.values()
                old = tuple(row[c] for c in COLS)
                if new != old:  # 変化がなければ更新日時もそのまま
                    db.execute(f"UPDATE services SET {', '.join(c + '=?' for c in COLS)}, updated_at=datetime('now','localtime')"
                               " WHERE id=?", (*new, row["id"]))
                updated += 1
            else:
                db.execute(f"INSERT INTO services({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})", svc.values())
                added += 1
    return {"added": added, "updated": updated}


@router.post("", status_code=201)
def create_service(s: ServiceIn) -> dict:
    with get_db() as db:
        check_platforms(db, s)
        for a in s.areas:
            ensure_master(db, "areas", a)
        cur = write(db, f"INSERT INTO services({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})",
                    s.values(), s.service_no)
        save_links(db, "service", cur.lastrowid, s.extra_links)
        return fetch(db, cur.lastrowid)


@router.put("/{sid}")
def update_service(sid: int, s: ServiceIn) -> dict:
    with get_db() as db:
        old_no = fetch(db, sid)["service_no"]
        check_platforms(db, s)
        for a in s.areas:
            ensure_master(db, "areas", a)
        write(db, f"UPDATE services SET {', '.join(c + '=?' for c in COLS)}, updated_at=datetime('now','localtime')"
                  " WHERE id=?", (*s.values(), sid), s.service_no)
        save_links(db, "service", sid, s.extra_links)
        if old_no != s.service_no:  # パッケージの関連サービスも新しい番号に
            _replace_in_packages(db, old_no, s.service_no)
            groups.replace_service_no(db, old_no, s.service_no)  # グループ目標の関連サービスも
        return fetch(db, sid)


@router.delete("/{sid}", status_code=204)
async def delete_service(sid: int, body: PasswordIn) -> Response:
    """サービスの削除（パスワード必須）"""
    if not auth.check_password(body.password):
        await asyncio.sleep(1)
        raise HTTPException(403, "パスワードが正しくないため削除できません")
    with get_db() as db:
        no = fetch(db, sid)["service_no"]
        db.execute("DELETE FROM services WHERE id = ?", (sid,))
        db.execute("DELETE FROM service_links WHERE kind = 'service' AND ref_id = ?", (sid,))
        _replace_in_packages(db, no, None)  # パッケージの関連サービスからも外す
        groups.replace_service_no(db, no, None)  # グループ目標の関連サービスからも外す
    return Response(status_code=204)
