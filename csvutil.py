"""CSV インポート共通処理"""

from datetime import date, datetime

from fastapi import HTTPException


def parse_date(value: str, line: int, col: str) -> date:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            pass
    raise HTTPException(422, f"{line} 行目: {col}「{value}」を日付として解釈できません（YYYY-MM-DD 形式）")


def decode_csv(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    raise HTTPException(422, "CSV の文字コードを判別できません（UTF-8 または Shift_JIS で保存してください）")
