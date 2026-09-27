#!/usr/bin/env bash
# アプリの更新（Linux サーバー用）: 更新前のバックアップ → git pull → 作り直して起動
#
# データ（DB）・バックアップ・.env には一切触れない:
#   - git clean / git reset / git checkout -- . は使わない（git 管理外のデータを消さないため）
#   - git pull は fast-forward のみ（サーバー側のファイルを上書き・マージしない）
#   - docker compose down -v は使わない（Docker ボリュームのデータを消さないため）
#
# 使い方:  cd /opt/gantt-pm && ./update.sh
set -euo pipefail
cd "$(dirname "$0")"

# 0) データやバックアップ、.env が git の管理下に入っていないか確認（入っていると pull で書き換わる恐れがある）
tracked=$(git ls-files -- .env data backups '*.db' '*.db-*' | head -n 5)
if [ -n "$tracked" ]; then
  echo "中止: 次のファイルが git の管理下にあります。pull で変更される恐れがあるため更新しません:" >&2
  echo "$tracked" >&2
  exit 1
fi

# 1) 更新前のバックアップ（アプリが動いていれば。管理サイトの一覧に「手動」として表示される）
if [ -n "$(docker compose ps --status running -q gantt 2>/dev/null)" ]; then
  name="manual-$(date +%Y%m%d-%H%M%S).json"
  docker compose exec -T gantt python manage.py backup "/data/backups/$name"
fi

# 2) 新しいバージョンを取り込む（fast-forward のみ）
git pull --ff-only

# 3) 作り直して起動（起動時にもバックアップ startup-*.json が保存される）
docker compose up -d --build
docker compose ps
