"use strict";

// 記録: アイディア・メモの保管庫。タグ・優先（★）・並べ替え・検索・自動保存つき
// （別アプリ task_management01 の IDEA と同じ構造: 登録 → 一覧（⋮⋮ ★ タイトル タグ）→ 開くと編集欄・自動保存）
(() => {
  const $ = (sel) => document.querySelector(sel);
  const enc = encodeURIComponent;
  const AUTOSAVE_MS = 800;
  const SEARCH_MS = 300;

  function h(tag, cls = "", text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  async function call(path, options = {}) {
    const res = await fetch(path, { headers: options.body ? { "Content-Type": "application/json" } : {}, ...options });
    if (res.status === 401) { location.href = `/login?next=${enc(location.pathname + location.search)}`; throw new Error("ログインが必要です"); }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j.detail) msg = typeof j.detail === "string" ? j.detail : msg; } catch (_) { /* そのまま */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }
  function say(msg, isErr = true) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("err", isErr);
    t.classList.add("show");
    clearTimeout(say._t);
    say._t = setTimeout(() => t.classList.remove("show"), isErr ? 4000 : 2200);
  }
  const stamp = (s) => (s ? s.slice(0, 16).replaceAll("-", "/") : "");
  // 一覧に出す更新日（今年なら 月/日、ほかの年は 年/月/日）
  const shortDate = (s) => {
    if (!s) return "";
    const [y, m, d] = s.slice(0, 10).split("-");
    return Number(y) === new Date().getFullYear() ? `${Number(m)}/${Number(d)}` : `${y}/${Number(m)}/${Number(d)}`;
  };
  // タグの色（名前から決める）
  const tagColor = (name) => {
    let n = 0;
    for (const ch of name) n = (n * 31 + ch.codePointAt(0)) % 360;
    return `hsl(${n} 55% 45%)`;
  };

  let records = [];
  let selectedId = null;
  let selectedTags = [];
  let saveTimer = null;
  let searchTimer = null;
  let preview = false;
  let archivedView = false; // true = アーカイブした記録を見ている
  let sortMode = "manual"; // manual = 手動の並び / updated = 更新日の新しい順
  try { sortMode = localStorage.getItem("records.sort") === "updated" ? "updated" : "manual"; } catch (_) { /* 記憶できなくても使える */ }

  const list = $("#rec-list");
  const editor = $("#rec-editor");
  const placeholder = $("#rec-placeholder");
  const titleInput = $("#rec-title");
  const body = $("#rec-body");
  const rendered = $("#rec-rendered");
  const status = $("#rec-status");
  const search = $("#rec-search");
  const tagFilter = $("#rec-tag-filter");
  const tagInput = $("#rec-tag-input");
  const base = "/api/records";

  function setEditorVisible(v) {
    editor.hidden = !v;
    placeholder.hidden = v;
    if (!v) history.replaceState(null, "", "/records"); // 閉じたら、アドレスから記録の指定を外す
  }

  function chip(name, onRemove) {
    const c = h("span", "rec-chip", name);
    c.style.setProperty("--c", tagColor(name));
    if (onRemove) {
      const x = h("button", "rec-chip-x", "×");
      x.type = "button";
      x.title = "タグを外す";
      x.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
      c.append(x);
    }
    return c;
  }

  function renderList() {
    list.innerHTML = "";
    if (!records.length) {
      const filtered = search.value.trim() || tagFilter.value;
      list.append(h("li", "empty", filtered ? "該当なし" : archivedView ? "アーカイブした記録はありません" : "記録はまだありません"));
      return;
    }
    for (const r of records) {
      const li = h("li", `${r.id === selectedId ? "selected" : ""}${r.prioritized ? " prioritized" : ""}`);
      li.title = r.id === selectedId ? "もう一度クリックで閉じる" : "";
      li.addEventListener("click", () => (r.id === selectedId ? close() : select(r.id)));
      const handle = dragHandle(true);
      handle.title = "ドラッグで並べ替え（★ の付いたものと付いていないものの間はまたげません）";
      const star = h("button", `rec-star${r.prioritized ? " on" : ""}`, r.prioritized ? "★" : "☆");
      star.type = "button";
      star.title = r.prioritized ? "優先を外す" : "優先にする（先頭に並びます）";
      star.addEventListener("click", (e) => { e.stopPropagation(); togglePriority(r); });
      const canDrag = sortMode === "manual"; // 日付のときは、手動の並べ替えはしない（現在・アーカイブとも同じ）
      handle.classList.toggle("off", !canDrag);
      if (!canDrag) handle.title = "「並び順」を「手動」にすると、ドラッグで入れ替えられます";
      li.append(handle, star);
      li.append(h("span", "rec-title-text", r.title));
      // 更新日（現在・アーカイブとも同じ表記。マウスを重ねると日時。アーカイブした記録はアーカイブした日時も）
      const when = h("span", "rec-date", shortDate(r.updated_at));
      when.title = `更新 ${stamp(r.updated_at)}（作成 ${stamp(r.created_at)}）${archivedView && r.archived_at ? `・アーカイブ ${stamp(r.archived_at)}` : ""}`;
      li.append(when);
      if (r.tags.length) {
        const tags = h("span", "rec-chips");
        for (const t of r.tags) tags.append(chip(t));
        li.append(tags);
      }
      li.querySelector(".rec-title-text").title = r.title;
      const group = r.prioritized ? "rec-p1" : "rec-p0";
      if (canDrag) enableDragSort(li, handle, {
        group, id: r.id,
        ids: () => records.filter((x) => x.prioritized === r.prioritized).map((x) => x.id), // ★ の有無をまたがない
        onDrop: async (ids) => {
          try { await call(`${base}/reorder`, { method: "POST", body: JSON.stringify({ ids }) }); } catch (err) { say(err.message); }
          await refresh();
        },
      });
      list.append(li);
    }
  }

  async function loadTags() {
    const tags = await call(`${base}/tags`);
    const cur = tagFilter.value;
    tagFilter.innerHTML = "";
    tagFilter.append(new Option("すべてのタグ", ""));
    for (const t of tags) tagFilter.append(new Option(t, t));
    tagFilter.value = tags.includes(cur) ? cur : "";
    const dl = $("#rec-tag-options");
    dl.innerHTML = "";
    for (const t of tags) dl.append(new Option("", t)); // datalist の候補（値だけ）
  }

  async function refresh() {
    try {
      await loadTags();
      const q = new URLSearchParams({ q: search.value.trim(), tag: tagFilter.value, archived: archivedView, sort: sortMode });
      records = await call(`${base}?${q}`);
      renderList();
    } catch (err) { say(err.message); }
  }

  async function togglePriority(r) {
    try {
      await call(`${base}/${r.id}`, { method: "PUT", body: JSON.stringify({ prioritized: !r.prioritized }) });
      await refresh();
    } catch (err) { say(err.message); }
  }

  function renderTags() {
    const box = $("#rec-tag-chips");
    box.innerHTML = "";
    for (const t of selectedTags) box.append(chip(t, () => saveTags(selectedTags.filter((x) => x !== t))));
  }
  async function saveTags(names) {
    if (selectedId === null) return;
    try {
      const u = await call(`${base}/${selectedId}`, { method: "PUT", body: JSON.stringify({ tags: names }) });
      selectedTags = u.tags;
      renderTags();
      await refresh();
    } catch (err) { say(err.message); }
  }

  function renderPreview() {
    rendered.innerHTML = window.mdToHtml(body.value, { interactive: true });
    rendered.hidden = !preview;
    body.hidden = preview;
    $("#rec-preview").textContent = preview ? "編集" : "表示";
  }

  async function save() {
    saveTimer = null;
    if (selectedId === null) return;
    const title = titleInput.value.trim();
    if (!title) { status.textContent = "タイトルは必須です（未保存）"; return; }
    try {
      const u = await call(`${base}/${selectedId}`, { method: "PUT", body: JSON.stringify({ title, body: body.value }) });
      status.textContent = "保存済み";
      $("#rec-stamp").textContent = `作成 ${stamp(u.created_at)} ・ 更新 ${stamp(u.updated_at)}`;
      const i = records.findIndex((x) => x.id === u.id);
      if (i >= 0) { records[i] = u; renderList(); }
    } catch (_) {
      status.textContent = "保存失敗（次の入力で再試行します）";
    }
  }
  function scheduleSave() {
    status.textContent = "編集中…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, AUTOSAVE_MS);
  }
  async function flush() {
    if (saveTimer !== null) { clearTimeout(saveTimer); await save(); }
  }

  async function select(id) {
    await flush();
    try {
      const r = await call(`${base}/${id}`);
      selectedId = r.id;
      titleInput.value = r.title;
      body.value = r.body;
      selectedTags = r.tags;
      renderTags();
      tagInput.value = "";
      status.textContent = "";
      $("#rec-stamp").textContent = `作成 ${stamp(r.created_at)} ・ 更新 ${stamp(r.updated_at)}`;
      preview = !!r.body; // 本文があるときは、まず表示（Markdown 変換後）で開く
      renderPreview();
      setEditorVisible(true);
      history.replaceState(null, "", `/records?id=${r.id}`); // 開いている記録のアドレス（「リンク」でコピーできる）
      renderList();
    } catch (err) { say(err.message); }
  }
  async function close() {
    await flush();
    selectedId = null;
    setEditorVisible(false);
    renderList();
  }

  titleInput.addEventListener("input", scheduleSave);
  body.addEventListener("input", scheduleSave);
  enableMarkdownEditing(body); // 箇条書きの Enter・Tab などの入力補助
  $("#rec-close").addEventListener("click", close);
  editor.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中は何もしない
    if (e.key === "Escape") close();
    // Ctrl+Enter（Mac は ⌘+Enter）で、今すぐ保存
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearTimeout(saveTimer);
      preview = true; // 保存と同時に、Markdown を変換した表示にする（「編集」で書く状態に戻る）
      renderPreview();
      save().then(() => say("保存しました", false));
    }
  });
  tagFilter.addEventListener("change", refresh);
  // 並び順: クリックで切り替え（手動 / 日付）。「現在」「アーカイブ」の隣
  function syncSortButtons() {
    $("#rec-sort-manual").classList.toggle("on", sortMode === "manual");
    $("#rec-sort-updated").classList.toggle("on", sortMode === "updated");
  }
  for (const [id, mode] of [["#rec-sort-manual", "manual"], ["#rec-sort-updated", "updated"]]) {
    $(id).addEventListener("click", () => {
      if (sortMode === mode) return;
      sortMode = mode;
      try { localStorage.setItem("records.sort", sortMode); } catch (_) { /* 記憶できなくても並びは変わる */ }
      syncSortButtons();
      refresh();
    });
  }
  syncSortButtons();
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(refresh, SEARCH_MS); });
  // 表示の中のチェックボックスを押すと、本文の「[ ]」「[x]」を書き換えて保存する
  rendered.addEventListener("change", (e) => {
    const box = e.target.closest("input.md-check[data-line]");
    if (!box) return;
    const lines = body.value.split("\n");
    const n = Number(box.dataset.line);
    const re = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;
    if (!re.test(lines[n] || "")) return;
    lines[n] = lines[n].replace(re, (_, pre) => `${pre}[${box.checked ? "x" : " "}]`);
    body.value = lines.join("\n");
    renderPreview();
    scheduleSave();
  });
  // 表示（Markdown 変換後）をダブルクリックすると、編集に切り替える（チェックボックス・リンクの上は除く）
  rendered.addEventListener("dblclick", (e) => {
    if (e.target.closest("input, a")) return;
    preview = false;
    renderPreview();
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);
    getSelection()?.removeAllRanges(); // ダブルクリックで選ばれた単語の選択を消す
  });
  $("#rec-preview").addEventListener("click", () => { preview = !preview; renderPreview(); if (!preview) body.focus(); });
  $("#rec-save").addEventListener("click", async () => { clearTimeout(saveTimer); await save(); });
  tagInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return; // 日本語入力の確定の Enter では追加しない
    e.preventDefault();
    const name = tagInput.value.trim();
    if (!name) return;
    tagInput.value = "";
    if (selectedTags.includes(name)) return;
    saveTags([...selectedTags, name]);
  });

  const addForm = $("#rec-add");
  addForm.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.isComposing || e.keyCode === 229)) e.preventDefault(); });
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = addForm.elements.namedItem("title");
    const title = input.value.trim();
    if (!title) return;
    try {
      const r = await call(base, { method: "POST", body: JSON.stringify({ title, body: "" }) });
      input.value = "";
      search.value = "";
      tagFilter.value = "";
      await refresh();
      await select(r.id);
      preview = false;
      renderPreview();
      body.focus(); // 続けて本文を書けるように
      say(`「${r.title}」を登録しました`, false);
    } catch (err) { say(err.message); }
  });

  // コピー: メモ全体（見出しにしたタイトル + 本文）を Markdown のままコピー。編集中の内容がそのまま入る
  $("#rec-copy").addEventListener("click", async () => {
    if (selectedId === null) return;
    const text = `# ${titleInput.value.trim()}\n\n${body.value.replace(/\s+$/, "")}\n`;
    // 書式つき（HTML）も一緒にコピーする。Teams・Outlook・Word に貼ると見出し・太字・箇条書きなどが反映され、
    // メモ帳などの文字だけの欄に貼ると Markdown の文字のままになる
    const html = window.mdToHtml(text)
      .replace(/<input type="checkbox" class="md-check" checked[^>]*>/g, "☑")
      .replace(/<input type="checkbox" class="md-check"[^>]*>/g, "☐")
      .replace(/<code>/g, '<code style="background:#efd0d5;color:#8b1e2d;padding:1px 5px;border-radius:3px;font-family:Consolas,monospace">')
      .replace(/<pre><code style="[^"]*">/g, '<pre style="background:#e3e7ee;padding:6px 8px"><code style="font-family:Consolas,monospace">');
    if (await copyRich(text, `<meta charset="utf-8">${html}`)) say("メモ全体をコピーしました（Teams などには書式つきで、メモ帳などには Markdown の文字で貼れます）", false);
  });

  // リンク: このメモを直接開くアドレスをコピー（開くと、その記録が開く。アーカイブした記録は「アーカイブ」の表示で開く）
  $("#rec-link").addEventListener("click", async () => {
    if (selectedId === null) return;
    const url = `${location.origin}/records?id=${selectedId}`;
    if (await copyText(url)) say(`このメモへのリンクをコピーしました: ${url}`, false);
  });

  // タスク化: ガントチャートでタスクの追加画面を開く（タスク名 = 記録のタイトル、詳細 = 記録の本文）。
  // 本文は長いことがあるので、アドレスには入れず、ブラウザの一時保存（sessionStorage）で渡す
  $("#rec-to-task").addEventListener("click", async () => {
    if (selectedId === null) return;
    await flush();
    try {
      sessionStorage.setItem("gantt.newtask", JSON.stringify({ title: titleInput.value.trim(), detail: body.value.replace(/\s+$/, "") }));
    } catch (_) { /* 渡せなくてもタスク名だけは入る */ }
    location.href = `/?newtask=${enc(titleInput.value.trim())}`;
  });

  // アーカイブ（一覧から外してサーバーに保管）/ 戻す（アーカイブした記録を一覧に戻す）
  function syncArchiveButton() {
    const b = $("#rec-archive");
    b.textContent = archivedView ? "戻す" : "アーカイブ";
    b.title = archivedView ? "アーカイブから一覧（現在）に戻します" : "一覧から外してサーバーに保管します（「アーカイブ」で見られ、戻せます）";
    $("#rec-add").hidden = archivedView;
    $("#rec-view-now").classList.toggle("on", !archivedView);
    $("#rec-view-arch").classList.toggle("on", archivedView);
  }
  $("#rec-archive").addEventListener("click", async () => {
    if (selectedId === null) return;
    await flush();
    try {
      await call(`${base}/${selectedId}`, { method: "PUT", body: JSON.stringify({ archived: !archivedView }) });
      say(archivedView ? `「${titleInput.value}」を一覧に戻しました` : `「${titleInput.value}」をアーカイブしました（サーバーに保管）`, false);
      selectedId = null;
      setEditorVisible(false);
      await refresh();
    } catch (err) { say(err.message); }
  });
  async function switchView(archived) {
    if (archivedView === archived) return;
    await flush();
    archivedView = archived;
    selectedId = null;
    setEditorVisible(false);
    syncArchiveButton();
    await refresh();
  }
  $("#rec-view-now").addEventListener("click", () => switchView(false));
  $("#rec-view-arch").addEventListener("click", () => switchView(true));
  syncArchiveButton();

  // 削除（パスワードで確認）。アーカイブと違い、完全に削除する（元に戻せない）
  const dlg = $("#dlg-rec-delete");
  $("#rec-delete").addEventListener("click", () => {
    if (selectedId === null) return;
    const f = $("#form-rec-delete");
    f.reset();
    $("#rec-delete-target").textContent = titleInput.value;
    $("#rec-delete-error").textContent = "";
    dlg.showModal();
    f.password.focus();
  });
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  $("#form-rec-delete").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      clearTimeout(saveTimer);
      saveTimer = null;
      await call(`${base}/${selectedId}`, { method: "DELETE", body: JSON.stringify({ password: e.target.password.value }) });
      dlg.close();
      selectedId = null;
      setEditorVisible(false);
      await refresh();
      say("記録を削除しました", false);
    } catch (err) {
      $("#rec-delete-error").textContent = err.message;
      e.target.password.select();
    }
  });

  window.addEventListener("beforeunload", () => { if (saveTimer !== null) save(); });
  // リンク（/records?id=番号）で開いたとき: その記録を開く（アーカイブした記録なら、アーカイブの表示で）
  (async () => {
    const want = Number(new URLSearchParams(location.search).get("id"));
    if (!want) { await refresh(); return; }
    try {
      const r = await call(`${base}/${want}`);
      if (r.archived) await switchView(true); else await refresh();
      await select(want);
    } catch (err) {
      say("このリンクのメモは見つかりません（削除された可能性があります）");
      history.replaceState(null, "", "/records");
      await refresh();
    }
  })();
})();
