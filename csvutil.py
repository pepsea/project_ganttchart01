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


def csv_response(rows: list[list], prefix: str):
    """BOM 付き UTF-8（Excel で文字化けしない）の CSV を返す"""
    import csv
    import io

    from fastapi import Response

    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    filename = f"{prefix}_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return Response(buf.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def read_csv(raw: bytes, required: list[str]) -> list[tuple[int, dict]]:
    """CSV を (行番号, {列名: 値}) のリストで返す。空行は飛ばす。必須列が無ければエラー"""
    import csv
    import io

    reader = csv.DictReader(io.StringIO(decode_csv(raw)))
    if not reader.fieldnames:
        raise HTTPException(422, "CSV にヘッダー行がありません")
    headers = [h.strip() for h in reader.fieldnames]
    missing = [h for h in required if h not in headers]
    if missing:
        raise HTTPException(422, "必須列がありません: " + "、".join(missing))
    out = []
    for line, raw_row in enumerate(reader, start=2):
        row = {(k or "").strip(): (v or "").strip() for k, v in raw_row.items() if k}
        if any(row.values()):
            out.append((line, row))
    return out


def split_list(value: str) -> list[str]:
    """「A、B」「A B」「A;B」などを配列に"""
    import re

    return [x for x in re.split(r"[\s　;；、,/／]+", value or "") if x]
