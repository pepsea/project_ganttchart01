# データ構造（SQLite: `data/gantt.db`）

このシステムの基礎となるデータ構造です。**今後の機能追加でも既存のテーブル・列は変えず、追加だけで拡張します**（下の「変更のルール」）。
バックアップ（JSON）はこのテーブル・列をそのまま出力したものです。

日付は `YYYY-MM-DD`、月は `YYYY-MM`、日時は `YYYY-MM-DD HH:MM:SS`（ローカル時刻）の文字列で保存します。

## 選択肢（マスタ） — 管理サイトで登録・修正・削除

| テーブル | 列 | 内容 |
|---|---|---|
| `areas` | id, name | 領域。id の順が表示順・色の順 |
| `case_nos` | id, name | 案件番号（= ガントチャートの PJ名〔案件〕） |
| `platforms` | id, name, … | 基盤番号（= ガントチャートの PJ名〔基盤〕）と基盤の情報（下記） |
| `customers` | id, name | 顧客 |

## ガントチャート

| テーブル | 列 | 内容 |
|---|---|---|
| `tasks` | id | |
| | area | 領域（`areas.name`） |
| | project | PJ名 = 案件番号（`case_nos.name`）または基盤番号（`platforms.name`）。空欄可 |
| | task / assignee / priority | タスク名 / 担当者 / 優先度（高・中・低） |
| | start_date / end_date | 開始日 / 終了日 |
| | detail | 詳細 |

## 案件管理

| テーブル | 列 | 内容 |
|---|---|---|
| `cases` | id, case_no (一意) | 案件番号（`case_nos.name`） |
| | customer / name / status | 顧客名 / 案件名 / 状況（顧客開発〜アフターフォロー、キャンセル） |
| | pl / assignees | PL / 担当者（半角スペース区切り） |
| | areas | 領域（JSON 配列） |
| | start_date / end_date | 開始日 / 終了予定日（空欄可） |
| | box_url / teams_url / overview_url / plan_url | 各リンク |
| | detail | 案件詳細 |
| | created_at / updated_at | 作成・更新日時 |
| | project | （未使用。旧 PJ名。PJ名 = 案件番号に統一） |
| `case_notes` | id, case_id, week, body, updated_at | 週次進捗メモ（week = その週の月曜日。案件×週で一意） |
| `case_monthly` | id, case_id, month, body, updated_at | 案件の月報（案件×月で一意） |

`case_notes` / `case_monthly` は `cases.id` を参照し、案件の削除時に一緒に削除されます。

## 基盤技術

| テーブル | 列 | 内容 |
|---|---|---|
| `platforms` | id, name (一意) | 基盤番号 |
| | title / owner / members | 基盤名 / PL / メンバー（半角スペース区切り） |
| | areas | 領域（JSON 配列。1 つ目が一覧のグループ） |
| | vision | 全体目標 |
| | plan_url / box_url / teams_url | 研究計画 / BOX / Teams のリンク |
| | updated_at | 基本情報の更新日時 |
| | area | （未使用。旧・単一領域。起動時に areas へ引き継ぎ） |
| `platform_goals` | id, platform, title, due_date, status, note, url, created_at, updated_at | 目標（状態: 未着手・取組中・達成・保留。url は目標のリンク） |
| `platform_topics` | id, platform, meeting_date, title, body, created_at, updated_at | ディスカッション |
| `platform_monthly` | id, platform, month, body, updated_at | 基盤の月報（基盤×月で一意） |

`platform` 列は `platforms.name`（基盤番号）で紐づけます。基盤番号を管理サイトで修正すると、これらも自動で書き換わります。

## グループ目標

| テーブル | 列 | 内容 |
|---|---|---|
| `team_groups` | id, name (一意) | グループ名 |
| | pl / members | PL / メンバー（半角スペース区切り） |
| | vision | 大目標 |
| | kpi | （未使用。旧・今年度の達成指標の文章。起動時に `team_kpis` へ 1 行ずつ引き継ぐ） |
| | services / platforms | 関連サービス（サービス番号の JSON 配列）/ 関連基盤技術（基盤番号の JSON 配列） |
| | sort_order / created_at / updated_at | 表示順 / 作成・更新日時 |
| `team_kpis` | id, group_id | 今年度の達成指標（`team_groups.id` を参照。グループの削除時に一緒に削除） |
| | title / owner / progress | 指標 / 担当者 / 進捗（0〜100 %） |
| | sort_order / created_at / updated_at | 表示順 / 作成・更新日時 |
| `team_goals` | id, group_id | 目標（`team_groups.id` を参照。グループの削除時に一緒に削除） |
| | title / due_date / status / note / url | 目標 / 期限 / 状態（未着手・取組中・達成・保留）/ メモ / リンク |
| | created_at / updated_at | 作成・更新日時 |

## サービス

| テーブル | 列 | 内容 |
|---|---|---|
| `services` | id, service_no (一意) | サービス番号 |
| | name / pl / members | サービス名 / PL / 担当者（半角スペース区切り） |
| | areas | 領域（JSON 配列） |
| | box_url / intro_ja_url / intro_en_url | BOX / サービス紹介資料（日本語）/ （英語）のリンク |
| | platforms | 関連する基盤番号（JSON 配列。`platforms.name`） |
| | goal / issues | サービスのゴール / 課題 |
| | created_at / updated_at | 作成・更新日時 |

| `service_packages` | id | 主要サービスパッケージ |
| | name | パッケージ名 |
| | intro_ja_url / intro_en_url / box_url | パッケージ資料（日本語）/ （英語）/ BOX のリンク |
| | services | 関連サービス（サービス番号の JSON 配列。`services.service_no`） |
| | sort_order / created_at / updated_at | 表示順 / 作成・更新日時 |

サービスのタスクは、ガントチャートの `tasks`（`project` = 関連する基盤番号）を表示する。
サービス番号を変更・削除すると、`service_packages.services` も書き換わる。

## 共有資料

| テーブル | 列 | 内容 |
|---|---|---|
| `documents` | id | |
| | category | 欄: `group` = グループ資料（左） / `other` = その他参考資料（右） |
| | title / purpose | 資料名 / 目的 |
| | created_date | 作成日時（`YYYY-MM-DD HH:MM`。未入力なら登録時刻） |
| | link1_label / link1_url | 資料リンク 1 の表示名 / URL |
| | link2_label / link2_url | 資料リンク 2 の表示名 / URL |
| | link3_label / link3_url, link4_label / link4_url | 資料リンク 3・4 の表示名 / URL（リンクは最大 4 つ） |
| | areas | 領域（JSON 配列） |
| | created_at / updated_at | 登録・更新日時 |

## 参考リンク

| テーブル | 列 | 内容 |
|---|---|---|
| `ref_links` | id | |
| | category | 欄: `tech` = 自社技術リンク / `own` = WEB リンク（自社サービス） / `other` = WEB リンク（その他参考） |
| | title / url / note | 名前 / URL / 説明 |
| | areas | 領域（JSON 配列） |
| | sort_order | 欄の中での表示順 |
| | created_at / updated_at | 登録・更新日時 |

## 画面の設定

| テーブル | 列 | 内容 |
|---|---|---|
| `app_settings` | key (主キー), value | 画面の設定値。`services.parent_link` = サービス画面の親リンク（JSON: label, url） |

## 変更のルール（アップデートでデータを失わないために）

1. **既存のテーブル・列は削除しない・名前を変えない・意味を変えない。** 使わなくなった列は「未使用」として残す。
2. 新しい項目は **列の追加**（`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT …`）か **テーブルの追加** で行う。
   追加処理は各 `init_db()`（`main.py` / `cases.py` / `platforms.py`）に書き、何度実行しても安全にする。
3. データの形を変える必要があるときは、古い列を残したまま新しい列を追加し、起動時に古い列から新しい列へ引き継ぐ
   （例: `platforms.area` → `platforms.areas`）。
4. `init_db()` は起動時と、バックアップの復元後に毎回実行される。これにより **古いバックアップも新しいアプリに取り込める**。
5. サンプルデータ・初期値は新規インストール時（DB ファイルが無い状態での起動）にだけ入る。
