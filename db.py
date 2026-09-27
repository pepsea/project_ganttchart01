"""SQLite 接続（ガントチャート・案件管理で共用）"""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

BASE_DIR = Path(__file__).parent
# Docker ではボリュームをマウントした DATA_DIR に DB を置く
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "gantt.db"

# 起動時に DB ファイルが無かった（新規インストール）かどうか。
# 初期データ（領域の初期値・サンプル）は新規インストール時の起動処理でだけ入れる。
# 既存データの更新（アップデート）や復元のあとには入れない。
FRESH_DB = not DB_PATH.exists()
_startup = True


def is_fresh_install() -> bool:
    return FRESH_DB and _startup


def sample_data_enabled() -> bool:
    """サンプルデータを入れるか（新規インストール時のみ。環境変数 SEED_SAMPLE_DATA=0 で入れない）"""
    return is_fresh_install() and os.environ.get("SEED_SAMPLE_DATA", "1") != "0"


def finish_startup() -> None:
    global _startup
    _startup = False


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def ensure_master(db: sqlite3.Connection, table: str, name: str) -> None:
    if name:
        db.execute(f"INSERT OR IGNORE INTO {table}(name) VALUES (?)", (name,))
