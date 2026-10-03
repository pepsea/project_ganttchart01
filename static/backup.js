"use strict";

// バックアップ画面: 全データのバックアップ・復元と、データごとの CSV エクスポート・インポート
const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 4000 : 2200);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: options.body ? { "Content-Type": "application/json" } : {}, ...options });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("ログインが必要です");
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const d = await res.json();
      if (typeof d.detail === "string") msg = d.detail;
      else if (Array.isArray(d.detail)) msg = d.detail.map((x) => x.msg).join("\n");
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// ガントチャートと同じ領域の色

// ------------------------------------------------------------ バックアップ・復元
const KIND_LABEL = { auto: "自動（毎日 0 時）", manual: "手動", "pre-restore": "復元前", startup: "起動時", upload: "アップロード" };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtTime = (s) => s.replace("T", " ").slice(0, 16);
let restoreTarget = null; // { file } または { name }

async function loadBackups() {
  const d = await api("/api/admin/backup/summary");
  const sum = $("#backup-summary");
  sum.innerHTML = "";
  for (const t of d.tables.filter((x) => x.rows > 0 || !x.label.startsWith("（旧）"))) {
    const s = el("span");
    s.append(`${t.label} `, el("b", "", String(t.rows)));
    sum.append(s);
  }
  $("#auto-keep").textContent = `（毎日 夜 12 時に自動保存。作成から約 1 か月（${d.keep_days} 日）で自動削除。最新の 1 つは残す）`;
  const ul = $("#server-backups");
  ul.innerHTML = "";
  if (!d.server_backups.length) ul.append(el("li", "empty", "まだありません"));
  for (const b of d.server_backups) {
    const li = el("li");
    li.append(el("span", "when", fmtTime(b.created_at)), el("span", `kind ${b.kind}`, KIND_LABEL[b.kind] || b.kind),
      el("span", "size", fmtSize(b.size)));
    const exp = el("span", "expires", `〜 ${b.expires_at.slice(0, 10).replaceAll("-", "/")} に自動削除`);
    exp.title = "作成から約 1 か月で自動的に削除されます（残したいときはダウンロードして手元に保存）";
    li.append(exp);
    const dl = el("a", "button", "ダウンロード");
    dl.href = `/api/admin/backups/${encodeURIComponent(b.name)}`;
    const rs = el("button", "", "復元");
    rs.addEventListener("click", () => openRestore({ name: b.name }, `サーバーのバックアップ: ${fmtTime(b.created_at)}（${KIND_LABEL[b.kind] || b.kind}）`));
    const del = el("button", "danger-link", "削除");
    del.title = "サーバーから削除（パスワードが必要）";
    del.addEventListener("click", () => openBackupDelete(b));
    li.append(dl, rs, del);
    ul.append(li);
  }
}

// 手元のバックアップファイルをサーバーにアップロード（保存のみ。復元は一覧の「復元」から）
$("#btn-upload").addEventListener("click", () => {
  $("#upload-file").value = "";
  $("#upload-file").click();
});
$("#upload-file").addEventListener("change", async () => {
  const file = $("#upload-file").files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/admin/backups/upload", { method: "POST", body: fd });
    const d = await res.json();
    if (!res.ok) throw new Error(typeof d.detail === "string" ? d.detail : `${res.status} ${res.statusText}`);
    await loadBackups();
    toast(`「${file.name}」をサーバーに保存しました（データは変わっていません。戻すときは一覧の「復元」から）`);
  } catch (ex) {
    toast(`アップロードできませんでした: ${ex.message}`, true);
  }
});

$("#btn-server-save").addEventListener("click", async () => {
  try {
    await api("/api/admin/backups", { method: "POST" });
    await loadBackups();
    toast("サーバーにバックアップを保存しました");
  } catch (ex) { toast(ex.message, true); }
});

$("#btn-restore-file").addEventListener("click", () => {
  $("#restore-file").value = "";
  $("#restore-file").click();
});
$("#restore-file").addEventListener("change", async () => {
  const file = $("#restore-file").files[0];
  if (!file) return;
  let info = file.name;
  try {
    const d = JSON.parse(await file.text());
    if (d.format !== "gantt-pm-backup") throw new Error();
    const rows = Object.values(d.tables).reduce((n, r) => n + r.length, 0);
    info = `ファイル: ${file.name}\nバックアップ日時: ${fmtTime(d.created_at || "")}（${rows} 件の記録）`;
  } catch (_) {
    return toast("このシステムのバックアップファイル（JSON）ではありません", true);
  }
  openRestore({ file }, info);
});

// サーバー上のバックアップの削除
let backupDeleting = null;
function openBackupDelete(b) {
  backupDeleting = b;
  const f = $("#form-backup-delete");
  f.reset();
  $("#backup-delete-target").textContent = `${fmtTime(b.created_at)}（${KIND_LABEL[b.kind] || b.kind}）  ${fmtSize(b.size)}`;
  $("#backup-delete-error").textContent = "";
  $("#dlg-backup-delete").showModal();
  f.password.focus();
}
$("#dlg-backup-delete [data-close]").addEventListener("click", () => $("#dlg-backup-delete").close());
$("#form-backup-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api(`/api/admin/backups/${encodeURIComponent(backupDeleting.name)}`, {
      method: "DELETE", body: JSON.stringify({ password: f.password.value }),
    });
    $("#dlg-backup-delete").close();
    await loadBackups();
    toast("バックアップを削除しました");
  } catch (ex) {
    $("#backup-delete-error").textContent = ex.message;
    f.password.select();
  } finally {
    btn.disabled = false;
  }
});

function openRestore(target, text) {
  restoreTarget = target;
  const f = $("#form-restore");
  f.reset();
  $("#restore-target").textContent = text;
  $("#restore-error").textContent = "";
  $("#dlg-restore").showModal();
  f.password.focus();
}
$("#dlg-restore [data-close]").addEventListener("click", () => $("#dlg-restore").close());
$("#form-restore").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    let res;
    if (restoreTarget.file) {
      const fd = new FormData();
      fd.append("file", restoreTarget.file);
      fd.append("password", f.password.value);
      res = await fetch("/api/admin/restore", { method: "POST", body: fd });
    } else {
      res = await fetch(`/api/admin/backups/${encodeURIComponent(restoreTarget.name)}/restore`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: f.password.value }),
      });
    }
    if (res.status === 401) { location.href = "/login?next=/backup"; return; }
    const d = await res.json();
    if (!res.ok) throw new Error(typeof d.detail === "string" ? d.detail : "復元に失敗しました");
    $("#dlg-restore").close();
    await loadBackups();
    const rows = d.restored.reduce((n, t) => n + t.rows, 0);
    toast(`復元しました（${rows} 件の記録。復元前の状態はサーバーに保存済み）`);
  } catch (ex) {
    $("#restore-error").textContent = ex.message;
    f.password.select();
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ データごとの CSV エクスポート・インポート
const NOTE_ALL = "空欄のセルは今の値のまま変わりません。削除は行いません。エラーのある行が 1 行でもあれば、何も取り込みません。UTF-8 / Shift_JIS の CSV を取り込めます。";
const DATASETS = [
  {
    name: "ガントチャート（タスク）", desc: "タスク（領域・PJ名・タスク・担当者・優先度・開始日・終了日・詳細）",
    exports: [
      { title: "ガントチャート（今のタスク）", url: "/api/export.csv", desc: "いまガントチャートにあるタスク。インポートすると元に戻せます" },
      { title: "ガントチャート履歴", url: "/api/export-history.csv", desc: "完了したタスク・削除したタスク（完了から 1 週間の自動削除を含む）も含めて、これまでのタスクをすべて出力（区分: 未完了・完了・削除済み）" },
    ],
    importUrl: "/api/import", mode: true,
    notes: ["列: id, 領域, PJ名, タスク, 担当者（複数はスペース区切り）, 優先度, 開始日, 終了日, 詳細",
      "「追加・更新」では id が一致するタスクは上書き、それ以外は追加します。「置き換え」は既存のタスクをすべて削除してから取り込みます"],
    summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件`,
  },
  {
    name: "案件管理", desc: "案件（企業名・顧客名・PL・担当者・領域・日付・リンクなど）と、月報・進捗メモ（日付ごとの列）",
    exports: [
      { title: "全データ（案件一覧＋月報・進捗メモ）", url: "/api/cases/export.csv", desc: "1 案件 1 行。月報・進捗メモをすべて日付ごとの列に展開。インポートすると元に戻せます" },
      { title: "案件一覧のみ", url: "/api/cases/export-list.csv", desc: "案件の情報だけ（月報・進捗メモは含めない）" },
      { title: "案件履歴", url: "/api/cases/export-history.csv", desc: "これまでに登録した案件（終了・削除したものを含む）と進行中の案件をすべて 1 案件 1 行で出力（区分: 進行中・終了・キャンセル・削除済み。進捗メモ・月報も含む）" },
      { title: "月報一覧", url: "/api/cases/export-monthly.csv", period: "月報", desc: "案件 × 月で 1 行。月を指定するとその月の全案件の月報のみ" },
      { title: "進捗メモ一覧", url: "/api/cases/export-notes.csv", period: "進捗メモ", desc: "案件 × 日付で 1 行。月を指定するとその月の進捗メモのみ" },
    ],
    importUrl: "/api/cases/import",
    notes: ["必須列: 案件番号・案件名（列名は CSV エクスポートと同じ）",
      "案件番号（と試験名）が一致する案件は更新、一致しない案件は追加されます",
      "領域は「、」やスペース区切りで複数指定できます。未登録の企業名・PJ名・領域・案件番号は自動登録されます（旧形式の「顧客名」列は企業名として読み込みます）",
      "「月報_2026-09」「進捗_2026-09-21」のような日付の列は、その月の月報・その日の進捗メモとして登録されます（同じ月・日は上書き。旧形式の「週次_」列も読み込めます）",
      "月報一覧（列: 案件番号・試験名・月・月報）と進捗メモ一覧（列: 案件番号・試験名・日付・進捗メモ）も取り込めます（案件番号＋試験名で案件を探し、その月・その日の内容を上書き。案件が無いとエラー）",
      "「状況」の旧い名前（QC・アフターフォロー）は「アフターフォロー・その他」として取り込みます"],
    summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件 / 月報 ${d.monthly} 件 / 進捗メモ ${d.notes} 件`,
  },
  {
    name: "基盤技術", desc: "基盤（基本情報・自由リンク・全体目標）・目標・ディスカッション・月報",
    exports: [
      { title: "全データ（バックアップ用）", url: "/api/platforms/export-backup.csv", desc: "基盤・目標・ディスカッション・月報をすべて 1 ファイルに。インポートすると、データが空の状態からでも元に戻せます" },
      { title: "基盤一覧＋月報", url: "/api/platforms/export.csv", desc: "1 基盤 1 行。全体目標・目標の達成状況に加え、月報をすべて月ごとの列に展開" },
      { title: "月報一覧", url: "/api/platforms/export-monthly.csv", period: "月報", desc: "基盤 × 月で 1 行。月を指定するとその月の全基盤の月報のみ" },
      { title: "目標一覧", url: "/api/platforms/export-goals.csv", desc: "基盤ごとの目標（状態・期限・メモ）" },
      { title: "ディスカッション一覧", url: "/api/platforms/export-topics.csv", desc: "日付・トピック・内容（決定事項・宿題）" },
    ],
    importUrl: "/api/platforms/import",
    notes: ["エクスポートした 5 種類の CSV を取り込めます（種類は列名から自動で判別します）",
      "全データ: 基盤・目標・ディスカッション・月報をすべて復元します（取り込み直しても重複しません）",
      "基盤一覧＋月報: 基盤番号で照合して基盤の情報を更新し、「月報_YYYY-MM」列はその月の月報として登録・上書きします。未登録の基盤番号は新規登録されます",
      "月報一覧: 月＋基盤番号で登録・上書き / 目標一覧: 基盤番号＋目標で照合（なければ追加） / ディスカッション一覧: 基盤番号＋日付＋トピックで照合（なければ追加）"],
    summary: (d) => {
      const label = { backup: "全データ", platforms: "基盤一覧＋月報", monthly: "月報一覧", goals: "目標一覧", topics: "ディスカッション一覧" }[d.kind];
      const parts = [];
      if (d.platforms_added) parts.push(`基盤 新規 ${d.platforms_added}`);
      if (d.platforms_updated) parts.push(`基盤 更新 ${d.platforms_updated}`);
      if (d.monthly) parts.push(`月報 ${d.monthly}`);
      if (d.goals_added || d.goals_updated) parts.push(`目標 追加 ${d.goals_added}・更新 ${d.goals_updated}`);
      if (d.topics_added || d.topics_updated) parts.push(`ディスカッション 追加 ${d.topics_added}・更新 ${d.topics_updated}`);
      return `（${label}）${parts.join(" / ") || "変更なし"}`;
    },
  },
  {
    name: "グループ目標", desc: "グループ・目標・達成したいこと・年度（「種別」列で区別）",
    exports: [{ label: "CSV エクスポート", url: "/api/groups/export.csv" }],
    importUrl: "/api/groups/import",
    notes: ["グループ名が同じグループは更新、無ければ追加します",
      "目標と達成したいことは、同じグループ・年度・内容なら更新、無ければ追加します。エクスポートしたファイルを取り込めば、空の状態からでも元に戻せます"],
    summary: (d) => `グループ 追加 ${d.groups_added} / 更新 ${d.groups_updated}・目標 ${d.goals}・達成したいこと ${d.achievements}・年度 ${d.years}`,
  },
  {
    name: "サービス", desc: "サービス（サービス名・番号・PL・担当者・領域・リンク・関連基盤技術・ゴール・課題）",
    exports: [{ label: "CSV エクスポート", url: "/api/services/export.csv" }],
    importUrl: "/api/services/import",
    notes: ["必須列: サービス番号（新規はサービス名も必須。列名は CSV エクスポートと同じ）",
      "サービス番号が一致するサービスは更新、一致しないものは追加されます",
      "領域・関連する基盤技術は「、」やスペース区切りで複数指定。基盤番号は管理サイトに登録済みのものだけ使えます"],
    summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件`,
  },
  {
    name: "共有資料", desc: "資料（欄・資料名・目的・作成日時・領域・リンク 1〜4）",
    exports: [{ label: "CSV エクスポート", url: "/api/documents/export.csv" }],
    importUrl: "/api/documents/import",
    notes: ["必須列: 資料名。欄（グループ資料 / その他参考資料）と資料名が同じ資料は更新、無ければ追加します"],
    summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件`,
  },
  {
    name: "メモ・議論", desc: "メモ・議論（記録）。現在の記録とアーカイブした記録の両方（状態・タイトル・本文・タグ・優先・日時）",
    exports: [{ label: "CSV エクスポート", url: "/api/records/export.csv" }],
    importUrl: "/api/records/import",
    notes: ["必須列: タイトル。タイトルと作成日時が同じ記録は更新、無ければ追加します。「状態」が「アーカイブ」ならアーカイブとして保存します。エクスポートしたファイルを取り込めば、現在・アーカイブとも元に戻せます"],
    summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件`,
  },
  {
    name: "参考リンク", desc: "リンク（欄・名前・URL・説明・領域・表示順）",
    exports: [{ label: "CSV エクスポート", url: "/api/links/export.csv" }],
    importUrl: "/api/links/import",
    notes: ["必須列: 名前・URL。欄（自社技術リンク / 自社サービス / その他参考）と URL が同じリンクは更新、無ければ欄の最後に追加します"],
    summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件`,
  },
];

// 選択式のエクスポートメニュー（項目ごとに説明つき。「月報一覧」などは月を指定できる）
function exportMenu(ds) {
  const menu = el("details", "export-menu");
  menu.append(el("summary", "button", "CSV エクスポート ▾"));
  const panel = el("div", "export-panel");
  for (const ex of ds.exports) {
    if (ex.period) {
      const item = el("div", "export-item monthly");
      item.append(el("b", "", ex.title), el("span", "", ex.desc));
      const row = el("div", "row");
      const m = document.createElement("input");
      m.type = "month";
      m.title = `${ex.period}を出力する月`;
      m.value = new Date().toISOString().slice(0, 7);
      const one = el("a", "button primary-link", "この月を出力");
      const all = el("a", "button", "全期間を出力");
      all.href = ex.url;
      const sync = () => { one.href = `${ex.url}?month=${m.value}`; };
      m.addEventListener("input", sync);
      sync();
      row.append(m, one, all);
      item.append(row);
      panel.append(item);
    } else {
      const a = el("a", "export-item");
      a.href = ex.url;
      a.append(el("b", "", ex.title), el("span", "", ex.desc));
      panel.append(a);
    }
  }
  menu.append(panel);
  // 項目を選んだらメニューを閉じる。外をクリックしても閉じる
  panel.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setTimeout(() => { menu.open = false; }, 100)));
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.open = false; });
  return menu;
}

function renderCsvList() {
  const box = $("#csv-list");
  box.innerHTML = "";
  for (const ds of DATASETS) {
    const row = el("div", "csv-row");
    const info = el("div", "csv-info");
    info.append(el("b", "", ds.name), el("span", "hint", ds.desc));
    const ops = el("div", "csv-ops");
    // エクスポート: 種類が複数あるデータは選択式のメニュー、1 種類だけならボタン
    if (ds.exports.length > 1) ops.append(exportMenu(ds));
    else {
      const a = el("a", "button", "CSV エクスポート");
      a.href = ds.exports[0].url;
      ops.append(a);
    }
    const imp = el("button", "primary", "CSV インポート");
    imp.type = "button";
    imp.addEventListener("click", () => startImport(ds));
    ops.append(imp);
    row.append(info, ops);
    box.append(row);
  }
}

// インポート: ファイルを選ぶ → 説明つきの確認画面 → 取り込み
let importDs = null;
const importFile = document.createElement("input");
importFile.type = "file";
importFile.accept = ".csv,text/csv";
importFile.hidden = true;
document.body.append(importFile);

function startImport(ds) {
  importDs = ds;
  importFile.value = "";
  importFile.click();
}
importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  if (!file || !importDs) return;
  const ds = importDs;
  $("#import-title").textContent = `${ds.name} CSV インポート`;
  $("#import-filename").textContent = file.name;
  $("#import-error").textContent = "";
  const ul = $("#import-notes");
  ul.innerHTML = "";
  for (const n of [...ds.notes, NOTE_ALL]) ul.append(el("li", "", n));
  const f = $("#form-import");
  $("#import-mode").hidden = !ds.mode;
  f.querySelector('input[value="append"]').checked = true;
  f.confirm.value = "";
  $("#replace-confirm").hidden = true;
  $("#dlg-import").showModal();
});
$("#form-import").addEventListener("change", (e) => {
  if (e.target.name === "mode") $("#replace-confirm").hidden = e.target.value !== "replace";
});
$("#dlg-import [data-close]").addEventListener("click", () => $("#dlg-import").close());
$("#form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ds = importDs;
  const f = e.target;
  let url = ds.importUrl;
  if (ds.mode) {
    const mode = new FormData(f).get("mode");
    const confirmText = f.confirm.value.trim();
    if (mode === "replace" && confirmText !== "置き換え") {
      $("#import-error").textContent = "置き換えを実行するには確認欄に「置き換え」と入力してください";
      return;
    }
    url += `?mode=${mode}&confirm=${encodeURIComponent(confirmText)}`;
  }
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  const fd = new FormData();
  fd.append("file", importFile.files[0]);
  try {
    const res = await fetch(url, { method: "POST", body: fd });
    if (res.status === 401) { location.href = "/login?next=/backup"; return; }
    const d = await res.json();
    if (!res.ok) throw new Error(typeof d.detail === "string" ? d.detail : "取り込みに失敗しました");
    $("#dlg-import").close();
    await loadBackups(); // 件数の表示を更新
    toast(`${ds.name} インポート完了: ${ds.summary(d)}`);
  } catch (err) {
    $("#import-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

renderCsvList();
loadBackups().catch((e) => toast(`バックアップ情報の読み込みに失敗しました: ${e.message}`, true));
