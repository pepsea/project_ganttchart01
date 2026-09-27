# Linux サーバーへの導入・移行・アップデート手順

ガントチャート・案件管理・基盤技術・管理サイトを Linux サーバーで動かす手順です。
Docker で動かすため、Ubuntu / Debian / RHEL 系などディストリビューションを問いません。

- データ（SQLite の DB とサーバー上のバックアップ）は **ホストの `data/` フォルダ** に保存します。
  アプリのコードを入れ替えても（アップデートしても）データは残ります。
- アプリは起動のたびに、テーブルを更新する前のデータを `data/backups/startup-*.json` に自動保存します。
  さらに毎週日曜日に `auto-*.json` を保存します（直近 26 週分。日曜に止まっていた場合は次に起動したときに保存）。

---

## 1. 準備（初回のみ）

### Docker のインストール
Docker Engine と Compose プラグインを入れます（公式手順: https://docs.docker.com/engine/install/ ）。

```bash
docker --version
docker compose version
```

### アプリのファイルを置く
このフォルダ一式（`main.py` などと `static/`、`Dockerfile`、`compose.yaml`、`.env.example`）をサーバーにコピーします。

```bash
# 例: Mac から scp でコピー（data/ や .env はコピーしない）
rsync -av --exclude data --exclude .env --exclude __pycache__ ./ user@server:/opt/gantt-pm/
```

以降はサーバー上の `/opt/gantt-pm` で作業する例です。

### 設定ファイル（.env）を作る
```bash
cd /opt/gantt-pm
cp .env.example .env
nano .env        # APP_PASSWORD を必ず変更する
```

| 設定 | 内容 |
|---|---|
| `APP_PASSWORD` | ログインパスワード（目標・月報の削除、復元にも使う） |
| `PORT` | 公開するポート（既定 5005） |
| `DATA_PATH` | データの保存先。`./data` のままでよい |
| `SEED_SAMPLE_DATA` | `0` にするとサンプルデータを入れない（本番は 0） |
| `APP_UID` / `APP_GID` | データフォルダの所有者。`id -u` / `id -g` の値 |
| `COOKIE_SECURE` | https で公開する場合は `1` |

### データフォルダを作る
```bash
mkdir -p data
# APP_UID / APP_GID と所有者を合わせる（例: 1000）
sudo chown -R 1000:1000 data
```

## 2. 起動

```bash
docker compose up -d --build
docker compose ps          # STATUS が Up になっていれば OK
docker compose logs -f     # ログを見る（Ctrl+C で抜ける）
```

ブラウザで `http://サーバーのアドレス:5005/` を開き、`.env` のパスワードでログインします。
サーバー再起動後も自動で起動します（`restart: unless-stopped`）。

ファイアウォールを使っている場合はポートを開けます（例: `sudo ufw allow 5005/tcp`）。
社外に公開する場合は nginx などのリバースプロキシで https にし、`.env` の `COOKIE_SECURE=1` にしてください。

## 3. 今のデータを移す（Mac などからの移行）

1. **移行元**の管理サイト（`/admin`）の一番下「バックアップ」で **「今すぐバックアップをダウンロード」**
   → `backup_YYYYMMDD_HHMMSS.json` が保存される
2. **移行先（Linux）**の管理サイトを開き、「バックアップ」の **「ファイルから復元…」** でそのファイルを選ぶ
3. **移行先のパスワード**を入力して「復元する」

すべての記録（ガントチャート・案件・週次メモ・月報・基盤の目標／ディスカッション／月報・選択肢）が移ります。
ファイルが大きい場合や画面が使えない場合は、コマンドでも復元できます:

```bash
cp backup_20260927_190000.json data/backups/
docker compose exec gantt python manage.py restore /data/backups/backup_20260927_190000.json
docker compose exec gantt python manage.py status     # 件数を確認
```

## 4. アプリのアップデート

新しいバージョンのファイルをサーバーに上書きコピーしてから、作り直して起動するだけです。
**`data/` と `.env` は上書き・削除しないでください。**

```bash
cd /opt/gantt-pm
# （念のため）今のデータを手元にも保存
docker compose exec gantt python manage.py backup /data/backups/before-update.json

# 新しいファイルをコピー（例）
rsync -av --exclude data --exclude .env --exclude __pycache__ 新バージョンのフォルダ/ /opt/gantt-pm/

docker compose up -d --build
```

- 起動時に、更新前のデータが `data/backups/startup-*.json` に自動保存されます。
- 新しいバージョンで項目（列）が増えている場合は、起動時に自動で追加されます。既存のデータは消えません。
- 問題があったら、管理サイトの「サーバーに保存されたバックアップ」から **起動時** の保存を選んで「復元」すると、更新前の状態に戻せます。

## 5. 別の場所にバックアップを保管する（推奨）

サーバー上のバックアップは `data/backups/` にあります。サーバーの故障に備えて、定期的に別の場所へコピーしてください。

```bash
# 例: 毎日 3:00 に別ディスクへコピー（crontab -e）
0 3 * * * rsync -a /opt/gantt-pm/data/backups/ /mnt/backup/gantt-pm/
```

管理サイトの「今すぐバックアップをダウンロード」で手元の PC に保存しておくこともできます。

## 6. よく使うコマンド

| やりたいこと | コマンド |
|---|---|
| 起動 / 更新して起動 | `docker compose up -d --build` |
| 停止 | `docker compose down`（**`-v` は付けない**） |
| ログ | `docker compose logs -f` |
| データ件数 | `docker compose exec gantt python manage.py status` |
| バックアップ | `docker compose exec gantt python manage.py backup /data/backups/xxx.json` |
| 復元 | `docker compose exec gantt python manage.py restore /data/backups/xxx.json` |
| パスワード変更 | `.env` の `APP_PASSWORD` を変えて `docker compose up -d` |

## トラブルシューティング

- **起動しない / `Permission denied` が出る**: `data/` の所有者と `.env` の `APP_UID`・`APP_GID` を合わせる
  （`sudo chown -R 1000:1000 data`）。
- **ログインできない**: `.env` の `APP_PASSWORD` を確認。変更後は `docker compose up -d` で反映。
- **データが空になった**: `DATA_PATH` が正しいか確認。`data/backups/` に自動保存があるので、そこから復元できます。
