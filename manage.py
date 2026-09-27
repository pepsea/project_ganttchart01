"""サーバー管理用コマンド（Docker コンテナ内で実行）

  バックアップを書き出す:  docker compose exec gantt python manage.py backup /data/backups/manual.json
  バックアップから復元:    docker compose exec gantt python manage.py restore /data/backups/xxxx.json
                          （復元の直前の状態は /data/backups/pre-restore-*.json に自動保存）
  データの件数を表示:      docker compose exec gantt python manage.py status
"""

import json
import sys

import backup
import main  # noqa: F401  テーブルの作成・更新を実行し、復元後の更新処理を登録する


def cmd_backup(path: str) -> None:
    data = backup.dump()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"保存しました: {path}（{sum(len(r) for r in data['tables'].values())} 件）")


def cmd_restore(path: str) -> None:
    with open(path, encoding="utf-8-sig") as f:
        data = json.load(f)
    saved = backup.save_to_server("pre-restore")
    result = backup.restore(data)
    print(f"復元しました: {path}（{sum(t['rows'] for t in result)} 件）。復元前の状態: {backup.BACKUP_DIR / saved}")


def cmd_status() -> None:
    for t in backup.summary(backup.dump()):
        print(f"{t['rows']:>6}  {t['label']}（{t['table']}）")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["backup"] and len(args) == 2:
        cmd_backup(args[1])
    elif args[:1] == ["restore"] and len(args) == 2:
        cmd_restore(args[1])
    elif args[:1] == ["status"]:
        cmd_status()
    else:
        print(__doc__)
        sys.exit(1)
