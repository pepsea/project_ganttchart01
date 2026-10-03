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
| `customers` | id, name | 企業名（旧「顧客」。案件管理で選択） |

## ガントチャート

| テーブル | 列 | 内容 |
|---|---|---|
| `tasks` | id | |
| | area | 領域（`areas.name`） |
| | project | PJ名 = 案件番号（`case_nos.name`）または基盤番号（`platforms.name`）。空欄可 |
| | task / assignee / priority | タスク名 / 担当者（複数は半角スペース区切り。1 人ならこれまで通り名前だけ） / 優先度（高・中・低） |
| | start_date / end_date | 開始日 / 終了日 |
| | detail | 詳細 |
| | completed_at | 完了にした日時（空 = 未完了）。完了したタスクはグレーアウトして一番下に表示し、完了から 1 週間（7 日）たつと自動で削除する（起動時・一覧の取得時）。削除しても `task_history` に写しが残る |
| `task_history` | id, task_id (一意) | ガントチャートの履歴。完了したタスク・削除したタスク（完了から 1 週間の自動削除、CSV の「置き換え」を含む）の写しを永続保管する。task_id = 元の `tasks.id`（削除後も残す） |
| | area / project / task / assignee / priority / start_date / end_date / detail | 写した時点のタスクの内容（`tasks` と同じ意味） |
| | completed_at / deleted_at / saved_at | 完了日時 / 削除日時（空 = まだガントチャートにある）/ 写しを保存・更新した日時。完了したタスクを編集すると写しも更新。起動時・復元後に、完了済みのタスクを毎回写す |

「ガントチャート履歴」CSV（`/api/export-history.csv`）は、今のタスク（未完了・完了）と `task_history` の削除済みタスクをすべて出力する。

## 案件管理

| テーブル | 列 | 内容 |
|---|---|---|
| `cases` | id, case_no | 案件番号（`case_nos.name`）。**同じ案件番号の案件を複数登録できる**（試験が複数ある場合）。以前の「一意」の制約は起動時に 1 回だけ外した（列・データはそのまま） |
| | contact | 顧客名（個人名。自由記載）。空欄可 |
| | created_at / finished_at | 登録日時（自動） / 終了日時（状況をアーカイブにした日時。自動。アーカイブ以外に戻すと空欄） |
| | status_changed_at | 状況を変えた日時（自動。状況が変わるたびに上書きし、増やさない。空 = 登録してから変えていない）。案件の一覧・カンバンはこの新しい順 → 登録の新しい順で並ぶ。CSV の「状況変更日」列 |
| | trial | 試験名（同じ案件番号の案件を区別。案件番号＋試験名の組み合わせは重ならない）。空欄可。同じ案件番号があるのに空欄で登録すると、自動で番号 "2", "3", … が入る（表示は C-2026-001-2） |
| | customer / name / status | 企業名（画面の表示名。以前の「顧客名」と同じ列） / 案件名 / 状況（顧客開発〜実施中、アフターフォロー・その他、キャンセル、アーカイブ＝終了した案件。以前の「QC」「アフターフォロー」は起動時に「アフターフォロー・その他」へ読み替える） |
| | pl / assignees | PL / 担当者（半角スペース区切り） |
| | areas | 領域（JSON 配列） |
| | start_date / end_date | 開始日 / 終了予定日（空欄可） |
| | box_url / teams_url / overview_url / plan_url | 各リンク |
| | detail | 案件詳細 |
| | link1_label / link1_url / link2_label / link2_url | （未使用）旧・自由リンク 2 つ。`case_links` 作成時に 1 回だけ引き継ぎ済み |
| | created_at / updated_at | 作成・更新日時 |
| | project | （未使用。旧 PJ名。PJ名 = 案件番号に統一） |
| `case_links` | id, case_id, label, url, sort_order, created_at | 案件の自由リンク（何個でも。名前と URL）。`case_links` を含まない古いバックアップを復元したときは、復元した cases の旧列から作り直す |
| `case_notes` | id, case_id, week, body, updated_at | （未使用）旧・週次進捗メモ（week = その週の月曜日。案件×週で一意）。`case_progress` 作成時に 1 回だけ引き継ぎ済み |
| `case_progress` | id, case_id, note_date, body, created_at, updated_at | 進捗メモ（note_date = 日付。同じ日に複数可）。`case_progress` を含まない古いバックアップを復元したときは、復元した `case_notes` から作り直す |
| `case_monthly` | id, case_id, month, body, updated_at | 案件の月報（案件×月で一意） |
| `case_history` | id, case_id (一意) | 案件の履歴。終了（アーカイブ）した案件・削除した案件の写しを単独で永続保管する（`cases` を参照しない。案件を削除しても残る）。case_id = 元の `cases.id` |
| | case_no / trial / name / status | 写した時点の案件番号 / 試験名 / 案件名 / 状況 |
| | created_at / finished_at / deleted_at | 案件の登録日時 / 終了日時 / 削除日時（空 = 削除していない） |
| | data | 写し（JSON。案件の全項目・自由リンク links・進捗メモ progress・月報 monthly） |
| | saved_at | 写しを保存・更新した日時。終了した案件の内容・進捗メモ・月報を変えると写しも更新。状況を戻しても履歴は残る。起動時・復元後に、終了済みの案件を毎回写す |

`case_links` / `case_notes` / `case_progress` / `case_monthly` は `cases.id` を参照し、案件の削除時に一緒に削除されます。`case_history` は削除されません。

「案件履歴」CSV（`/api/cases/export-history.csv`）は、今ある案件（進行中・終了・キャンセル）と `case_history` の削除済み案件をすべて、登録日の順に出力する（進捗メモ・月報も 1 セルずつ含む）。

## 基盤技術

| テーブル | 列 | 内容 |
|---|---|---|
| `platforms` | id, name (一意) | 基盤番号 |
| | title / owner / members | 基盤名 / PL / メンバー（半角スペース区切り） |
| | areas | 領域（JSON 配列。1 つ目が一覧のグループ） |
| | vision | 全体目標 |
| | plan_url / box_url / teams_url | 研究計画 / BOX / Teams のリンク |
| | sort_order | 基盤一覧の並び順（ドラッグ＆ドロップで入れ替え。0 = 未設定 → 起動時に基盤番号順で最後に並べる） |
| | link_label / link_url | （未使用）旧・自由リンク 1 つ。`platform_links` 作成時に 1 回だけ引き継ぎ済み |
| `platform_links` | id, platform, label, url, sort_order, created_at | 基盤の自由リンク（何個でも。platform = 基盤番号）。`platform_links` を含まない古いバックアップを復元したときは、復元した platforms の旧列から作り直す |
| | updated_at | 基本情報の更新日時 |
| | area | （未使用。旧・単一領域。起動時に areas へ引き継ぎ） |
| `platform_goals` | id, platform, title, due_date, status, note, url, sort_order, created_at, updated_at | 目標（状態: 未着手・取組中・達成・保留。note は画面では「内容」と表示（CSV の列名は「メモ」のまま）。url は目標のリンク。sort_order は項目の並び順 = ドラッグ＆ドロップで入れ替え。0 = 未設定） |
| `platform_goal_tasks` | id, platform, goal_id, title, progress, owner, due_date, note, created_at, updated_at | 目標達成に必要な項目（`platform_goals`）の中の実施内容（リスト）。goal_id = `platform_goals.id`、progress = 進捗率（％。0〜100）。項目の削除時に一緒に削除。画面の「メモ」は「内容」と表示（列名は note のまま） |
| `platform_goal_notes` | id, platform, goal_id, note_date, body, created_at, updated_at | 目標達成に必要な項目（`platform_goals`）ごとの定期的な議論の記録（画面: 項目の詳細の「議論の記録」）。goal_id = `platform_goals.id`、note_date = 議論の日付（同じ日に複数可）。項目の削除時に一緒に削除 |
| `platform_topics` | id, platform, meeting_date, title, body, created_at, updated_at | ディスカッション |
| `platform_monthly` | id, platform, month, body, updated_at | 基盤の月報（基盤×月で一意） |

`platform` 列は `platforms.name`（基盤番号）で紐づけます。基盤番号を管理サイトで修正すると、これらも自動で書き換わります。

## グループ目標

| テーブル | 列 | 内容 |
|---|---|---|
| `team_groups` | id, name (一意) | グループ名 |
| | pl / members | リーダー（画面の表示名。列名は pl のまま） / メンバー（半角スペース区切り） |
| | vision | 大目標 |
| | kpi | （未使用。旧・今年度の達成指標の文章。起動時に `team_kpis` へ 1 行ずつ引き継ぐ） |
| | services / platforms | 関連サービス（サービス番号の JSON 配列）/ 関連基盤技術（基盤番号の JSON 配列） |
| | sort_order / created_at / updated_at | 表示順 / 作成・更新日時 |
| `team_kpis` | id, group_id | 今年度の達成指標（**画面では非表示**。データは保持。`team_groups.id` を参照） |
| | title / owner / progress | 指標 / 担当者 / 進捗（0〜100 %） |
| | sort_order / created_at / updated_at | 表示順 / 作成・更新日時 |
| `team_goals` | id, group_id | 目標（`team_groups.id` を参照。グループの削除時に一緒に削除） |
| | title / due_date / status / note / url | 目標 / 期限 / 状態（未着手・取組中・達成・保留）/ メモ / リンク |
| | criteria / period | 達成基準 / 時期（自由記述。例: 2026 年度下期） |
| | sort_order | 項目の並び順（ドラッグ＆ドロップで入れ替え。0 = 未設定 → 状態・期限の順で並び、新しい項目は一番下） |
| | fiscal_year | 年度（4 月始まり。例: 2026 = 2026/4〜2027/3）。未設定の行は起動時に期限（無ければ作成日）から設定 |
| `team_goal_notes` | id, group_id, goal_id, note_date, body, created_at, updated_at | 目標達成に必要な項目（`team_goals`）ごとの定期的な議論の記録（画面: 項目の詳細の「議論の記録」）。group_id = `team_groups.id`、goal_id = `team_goals.id`、note_date = 議論の日付（同じ日に複数可）。項目・グループの削除時に一緒に削除 |
| `team_achievements` | id, group_id | 年度ごとの達成したいこと（`team_groups.id` を参照。グループの削除時に一緒に削除） |
| | title / owner / note / url | 達成したいこと / 担当者（半角スペース区切り）/ メモ / リンク |
| | achieved_on | （未使用）旧・達成日。`quarter` 追加時に 1 回だけ、入っていた日付から達成時期を引き継ぎ済み |
| | quarter | 達成時期（年度の四半期。Q1 = 4〜6 月、Q2 = 7〜9 月、Q3 = 10〜12 月、Q4 = 1〜3 月。空 = 未設定） |
| | progress | 達成度（％。0〜100。色は画面で変わる。これまでの達成したいことは 100） |
| | goal_id | 関連する「目標達成に必要な項目」（`team_goals.id`。0 = どの項目にも結びついていない）。項目を削除すると 0 に戻る。画面では項目の右の窓に表示 |
| | fiscal_year | 年度（4 月始まり）。未設定の行は起動時に達成日（無ければ作成日）から設定 |
| `team_years` | year | グループ目標の年度の選択肢（4 月始まり）。画面の「年度の登録」で追加・削除（目標・達成したいことがある年度は削除不可）。目標・達成したいことを保存すると、その年度は自動で登録 |
| | created_at | 登録日時 |
| | created_at / updated_at | 作成・更新日時 |
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

| `service_links` | id, kind, ref_id, label, url, sort_order, created_at | 追加リンク（名前つき。何個でも）。kind = `service`（ref_id = `services.id`。サービス紹介資料の追加リンク）/ `package`（ref_id = `service_packages.id`。パッケージ資料の追加リンク）。サービス・パッケージの削除時に一緒に削除 |

サービスのタスクは、ガントチャートの `tasks`（`project` = 関連する基盤番号）を表示する。
サービス番号を変更・削除すると、`service_packages.services` も書き換わる。

## 共有資料

| テーブル | 列 | 内容 |
|---|---|---|
| `documents` | id | |
| | category | 欄: `group` = グループ資料（左） / `other` = その他参考資料（右） |
| | sort_order | 手で入れ替えた順番（ドラッグ＆ドロップ。0 = 未設定。未設定の資料は上に、作成日時の新しい順で並ぶ） |
| | title / purpose | 資料名 / 目的 |
| | created_date | 作成日時（`YYYY-MM-DD HH:MM`。未入力なら登録時刻） |
| | link1_label / link1_url | （未使用）旧・資料リンク。`document_links` 作成時に 1 回だけ引き継ぎ済み |
| | link2〜4_label / link2〜4_url | （未使用）旧・資料リンク 2〜4（同上） |
| `document_links` | id, document_id, label, url, sort_order, created_at | 資料のリンク（何個でも。表示名と、URL またはフォルダのパス）。資料の削除時に一緒に削除。`document_links` を含まない古いバックアップを復元したときは、復元した documents の旧列から作り直す |
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

## 個人（people.py）

| テーブル | 列 | 内容 |
|---|---|---|
| `person_notes` | name (主キー), body, areas, updated_at | 個人の画面のメモ（body）と、自分で設定する担当領域（areas = JSON 配列。管理サイトの領域から選ぶ）。人ごとに 1 件。name は担当者・PL・メンバーの名前 |

## メモ・議論（records.py）

| テーブル | 列 | 内容 |
|---|---|---|
| `records` | id, title, body, tags, prioritized, position, archived, archived_at, created_at, updated_at | 「メモ・議論」タブ（アイディア・メモの保管庫。1 件を「記録」と呼ぶ）。body = Markdown、tags = タグの JSON 配列、prioritized = 優先（★。先頭にまとまる）、position = 手で入れ替えた並び順（小さいほど上。新しい記録は一番上）、archived = 1 のものはアーカイブ（一覧から外してサーバーに保管。archived_at = アーカイブした日時）。削除は完全削除 |

## 変更のルール（アップデートでデータを失わないために）

1. **既存のテーブル・列は削除しない・名前を変えない・意味を変えない。** 使わなくなった列は「未使用」として残す。
2. 新しい項目は **列の追加**（`ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT …`）か **テーブルの追加** で行う。
   追加処理は各 `init_db()`（`main.py` / `cases.py` / `platforms.py`）に書き、何度実行しても安全にする。
3. データの形を変える必要があるときは、古い列を残したまま新しい列を追加し、起動時に古い列から新しい列へ引き継ぐ
   （例: `platforms.area` → `platforms.areas`）。
4. `init_db()` は起動時と、バックアップの復元後に毎回実行される。これにより **古いバックアップも新しいアプリに取り込める**。
5. サンプルデータ・初期値は新規インストール時（DB ファイルが無い状態での起動）にだけ入る。
