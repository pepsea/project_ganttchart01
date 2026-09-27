# Linux サーバーへの導入・移行・アップデート手順

ガントチャート・案件管理・基盤技術・管理サイトを Linux サーバーで動かす手順です。
Docker で動かすため、Ubuntu / Debian / RHEL 系などディストリビューションを問いません。

- データ（SQLite の DB とサーバー上のバックアップ）は **ホストのフォルダ（`.env` の `DATA_PATH`）** に保存します。
  **git のフォルダの外（例 `/srv/gantt-pm/data`）に置くことを推奨**します。git pull・git clean・フォルダの入れ替えをしても、データとバックアップは変更されません。
- データ・バックアップ・`.env` は git で管理していません（`.gitignore`）。サーバーで `git pull` しても書き換わりません。
- アプリは起動のたびに、テーブルを更新する前のデータを `DATA_PATH` の `backups/startup-*.json` に自動保存します。
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
git で置く場合（アップデートは `./update.sh` で行えます）:

```bash
sudo git clone https://github.com/pepsea/project_ganttchart01.git /opt/gantt-pm
sudo chown -R $USER /opt/gantt-pm
cd /opt/gantt-pm && git config pull.ff only   # pull でマージ・上書きをしない
```

コピーで置く場合は、このフォルダ一式（`main.py` などと `static/`、`Dockerfile`、`compose.yaml`、`.env.example`）をサーバーにコピーします。

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
| `DATA_PATH` | データ（DB・バックアップ）の保存先。**git のフォルダの外**を推奨（例 `/srv/gantt-pm/data`） |
| `SEED_SAMPLE_DATA` | `0` にするとサンプルデータを入れない（本番は 0） |
| `APP_UID` / `APP_GID` | データフォルダの所有者。`id -u` / `id -g` の値 |
| `COOKIE_SECURE` | https で公開する場合は `1` |

### データフォルダを作る（git のフォルダの外）
```bash
sudo mkdir -p /srv/gantt-pm/data
# APP_UID / APP_GID と所有者を合わせる（例: 1000）
sudo chown -R 1000:1000 /srv/gantt-pm/data
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
cp backup_20260927_190000.json /srv/gantt-pm/data/backups/
docker compose exec gantt python manage.py restore /data/backups/backup_20260927_190000.json
docker compose exec gantt python manage.py status     # 件数を確認
```

## 4. アプリのアップデート（git pull）

サーバーのフォルダを `git clone` で用意している場合は、付属の **`update.sh`** で更新します。

```bash
cd /opt/gantt-pm
./update.sh
```

`update.sh` がすること（データ・バックアップ・`.env` には触れません）:
1. データやバックアップが git の管理下に入っていないか確認（入っていたら中止）
2. 更新前のバックアップを `backups/manual-*.json` に保存（管理サイトの一覧に「手動」として表示）
3. `git pull --ff-only`（サーバー側のファイルを上書き・マージしない）
4. `docker compose up -d --build`（起動時にも `startup-*.json` を保存）

**してはいけないこと**（データやバックアップが消えます）:
- `git clean -x` / `git clean -fdx`（git 管理外のファイル＝`./data` を消す）
- `docker compose down -v`（Docker ボリュームを消す）
- git のフォルダを消して clone し直す（`DATA_PATH=./data` の場合、データも消える）
  → `DATA_PATH` を git のフォルダの外にしておけば、どれを行ってもデータは残ります。

git を使わずにファイルをコピーして更新する場合:

```bash
cd /opt/gantt-pm
docker compose exec gantt python manage.py backup /data/backups/manual-$(date +%Y%m%d-%H%M%S).json
rsync -av --exclude data --exclude .env --exclude __pycache__ 新バージョンのフォルダ/ /opt/gantt-pm/
docker compose up -d --build
```

- 新しいバージョンで項目（列）が増えている場合は、起動時に自動で追加されます。既存のデータは消えません。
- 問題があったら、管理サイトの「サーバーに保存されたバックアップ」から **起動時** の保存を選んで「復元」すると、更新前の状態に戻せます。

### 既に `DATA_PATH=./data` で動かしている場合（git のフォルダの外へ移す）

```bash
cd /opt/gantt-pm
docker compose down                              # -v は付けない
sudo mkdir -p /srv/gantt-pm
sudo mv data /srv/gantt-pm/data                  # DB とバックアップをまとめて移動
sudo chown -R 1000:1000 /srv/gantt-pm/data
sed -i 's#^DATA_PATH=.*#DATA_PATH=/srv/gantt-pm/data#' .env
docker compose up -d --build
docker compose exec gantt python manage.py status   # 件数が以前と同じか確認
```

## 5. 別の場所にバックアップを保管する（推奨）

サーバー上のバックアップは `DATA_PATH` の `backups/`（例 `/srv/gantt-pm/data/backups/`）にあります。サーバーの故障に備えて、定期的に別の場所へコピーしてください。

```bash
# 例: 毎日 3:00 に別ディスクへコピー（crontab -e）
0 3 * * * rsync -a /srv/gantt-pm/data/backups/ /mnt/backup/gantt-pm/
```

管理サイトの「今すぐバックアップをダウンロード」で手元の PC に保存しておくこともできます。

## 6. よく使うコマンド

| やりたいこと | コマンド |
|---|---|
| アップデート（git pull） | `./update.sh` |
| 起動 / 作り直して起動 | `docker compose up -d --build` |
| 停止 | `docker compose down`（**`-v` は付けない**） |
| ログ | `docker compose logs -f` |
| データ件数 | `docker compose exec gantt python manage.py status` |
| バックアップ | `docker compose exec gantt python manage.py backup /data/backups/xxx.json` |
| 復元 | `docker compose exec gantt python manage.py restore /data/backups/xxx.json` |
| パスワード変更 | `.env` の `APP_PASSWORD` を変えて `docker compose up -d` |

## トラブルシューティング

- **起動しない / `Permission denied` が出る**: データフォルダ（`DATA_PATH`）の所有者と `.env` の `APP_UID`・`APP_GID` を合わせる
  （`sudo chown -R 1000:1000 /srv/gantt-pm/data`）。
- **ログインできない**: `.env` の `APP_PASSWORD` を確認。変更後は `docker compose up -d` で反映。
- **データが空になった**: `.env` の `DATA_PATH` が正しいか確認。`DATA_PATH` の `backups/` に自動保存があるので、そこから復元できます。
