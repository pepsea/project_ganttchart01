#!/usr/bin/env bash
# アプリの更新（Linux サーバー用）: 更新前のバックアップ → git pull → 作り直して起動
#
# データ（DB）・バックアップ・.env には一切触れない:
#   - git clean / git reset / git checkout -- . は使わない（git 管理外のデータを消さないため）
#   - git stash は「git 管理のプログラムの変更だけ」を対象にし、data/・backups/・.env は含めない（-u / -a は使わない）
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
# 競合（unmerged）したファイルが残っていると pull できない。直し方を案内して止める
if [ -n "$(git ls-files -u)" ]; then
  echo "中止: 競合したまま残っているファイルがあります（Unmerged）。DEPLOY_LINUX.md の「unmerged files」の手順で直してください:" >&2
  git ls-files -u | cut -f2 | sort -u >&2
  exit 1
fi
# サーバー側でプログラムを書き換えた変更（git 管理のファイルだけ）があれば、stash に退避してから pull する。
#   stash に入れるのは「git で管理しているプログラム」の変更だけ。
#   データ（data/・DATA_PATH）・backups/・.env・*.db は対象外（-u / -a は使わず、範囲も明示して除外）。
STASHED=0
if ! git diff --quiet HEAD -- . ':(exclude)data' ':(exclude)backups' ':(exclude).env'; then
  git stash push -m "update.sh $(date +%Y%m%d-%H%M%S)" -- . ':(exclude)data' ':(exclude)backups' ':(exclude).env'
  STASHED=1
fi
git pull --ff-only
if [ "$STASHED" = 1 ]; then
  echo "注意: サーバー側で書き換えたプログラムの変更を stash に退避しました。必要なら  git stash list / git stash pop  で戻せます。" >&2
fi

# 3) 作り直して起動（起動時にもバックアップ startup-*.json が保存される）
docker compose up -d --build
docker compose ps
