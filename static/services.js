"use strict";

// サービス: 上から順番に 1 サービス 1 行（ブロック）で表示。タスクはガントチャート（PJ名 = 関連する基盤番号）と連携
const DAY_MS = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
const enc = encodeURIComponent;

const state = {
  services: [],
  packages: [],    // 主要サービスパッケージ
  platforms: [],   // { name, title }
  areas: [],
  tasks: [],
  q: "",
  area: "",
  person: "",
  editing: null,   // 編集中のサービス（null なら追加）
};

// ------------------------------------------------------------ utils
function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const parseDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const todayMs = () => {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
};
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const people = (s) => (s.members ? s.members.split(" ") : []);
const areaColor = (a) => {
  let i = state.areas.indexOf(a);
  if (i < 0) i = state.areas.length;
  return `hsl(${(210 + i * 67) % 360} 62% 50%)`;
};
const platformTitle = (no) => state.platforms.find((p) => p.name === no)?.title || "";

async function api(path, options = {}) {
  const res = await fetch(path, { headers: options.body ? { "Content-Type": "application/json" } : {}, ...options });
  if (res.status === 401) {
    location.href = `/login?next=${enc(location.pathname + location.search)}`;
    throw new Error("ログインが必要です");
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const d = await res.json();
      if (typeof d.detail === "string") msg = d.detail;
      else if (Array.isArray(d.detail)) msg = d.detail.map((x) => x.msg.replace(/^Value error, /, "")).join("\n");
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 4000 : 2200);
}

function linkBtn(label, url) {
  const u = safeUrl(url);
  if (!u) {
    const s = el("span", "svc-link", label);
    s.title = `${label}: 未設定`;
    return s;
  }
  const a = el("a", "svc-link", `${label} ↗`);
  a.href = u;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = u;
  return a;
}

// ------------------------------------------------------------ 絞り込み
function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.services.filter((s) =>
    (!state.area || s.areas.includes(state.area)) &&
    (!state.person || s.pl === state.person || people(s).includes(state.person)) &&
    (!q || [s.service_no, s.name, s.pl, s.members, s.goal, ...s.areas, ...s.platforms, ...s.platforms.map(platformTitle)]
      .some((v) => (v || "").toLowerCase().includes(q))));
}

function refreshFilters() {
  const fa = $("#f-area");
  fa.innerHTML = "";
  fa.append(new Option("すべて", ""));
  for (const a of state.areas) fa.append(new Option(a, a));
  if (!state.areas.includes(state.area)) state.area = "";
  fa.value = state.area;
  renderAreaChips();

  const names = [...new Set(state.services.flatMap((s) => [s.pl, ...people(s)]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ja"));
  const fp = $("#f-person");
  fp.innerHTML = "";
  fp.append(new Option("すべて", ""));
  for (const n of names) fp.append(new Option(n, n));
  if (!names.includes(state.person)) state.person = "";
  fp.value = state.person;
}

// ------------------------------------------------------------ 描画（上から順番に行で表示）
function render() {
  const list = filtered();
  $("#svc-count").textContent = `${list.length} 件${list.length !== state.services.length ? `（全 ${state.services.length} 件）` : ""}`;
  const box = $("#svc-list");
  box.innerHTML = "";
  if (!state.services.length) {
    box.append(el("p", "hint", "まだサービスがありません。「＋ サービス追加」から登録してください。"));
    return;
  }
  if (!list.length) box.append(el("p", "hint", "条件に合うサービスはありません。"));
  for (const s of list) box.append(renderRow(s));
}

const expanded = new Set(); // 詳細を開いているサービス番号

// 1 行目の小さなリンク（BOX / 日 / 英）
function miniLink(label, url, title) {
  const u = safeUrl(url);
  if (!u) {
    const x = el("span", "mini-link", label);
    x.title = `${title}: 未設定`;
    return x;
  }
  const a = el("a", "mini-link on", label);
  a.href = u;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = `${title}を開く`;
  a.addEventListener("click", (e) => e.stopPropagation());
  return a;
}

function renderRow(s) {
  const sec = el("section", "svc-row");
  sec.id = `svc-${s.service_no}`;
  sec.style.setProperty("--c", s.areas[0] ? areaColor(s.areas[0]) : "var(--accent)");
  const open = expanded.has(s.service_no);
  sec.classList.toggle("open", open);
  const toggle = () => {
    if (expanded.has(s.service_no)) expanded.delete(s.service_no); else expanded.add(s.service_no);
    sec.replaceWith(renderRow(s));
  };

  // 1 行: 番号・名前・領域・タスクの有無（クリックで詳細を開閉）
  const l1 = el("div", "svc-l1");
  l1.title = open ? "クリックで閉じる" : "クリックで詳細を表示";
  l1.addEventListener("click", toggle);
  l1.append(el("span", "caret", open ? "▼" : "▶"), el("span", "svc-no", s.service_no), el("span", "svc-name", s.name));
  const areas = el("span", "tags");
  for (const a of s.areas) {
    const t = el("span", "area-tag", a);
    t.style.setProperty("--c", areaColor(a));
    areas.append(t);
  }
  if (!s.areas.length) areas.append(el("span", "none", "領域未設定"));
  const taskCount = state.tasks.filter((t) => s.platforms.includes(t.project)).length;
  const tasks = el("span", taskCount ? "task-flag yes" : "task-flag no", taskCount ? `タスク あり（${taskCount} 件）` : "タスク なし");
  l1.append(areas, el("span", "spacer"), tasks);
  const edit = el("button", "edit-btn", "✎ 編集");
  edit.addEventListener("click", (e) => { e.stopPropagation(); openDialog(s); });
  l1.append(edit);
  sec.append(l1);

  // 詳細（開いたときだけ）: PL・担当者・リンク・関連する基盤技術・ゴール・課題・タスク
  if (open) {
    const d = el("div", "svc-detail");
    const block = (label, content) => {
      const row = el("div", "d-row");
      row.append(el("div", "lbl", label));
      const v = el("div", "val");
      if (content instanceof Node) v.append(content);
      else if (content) v.append(el("div", "text", content));
      else v.append(el("span", "none", "未記入"));
      row.append(v);
      return row;
    };
    const team = el("span", "team");
    if (s.pl) team.append(el("span", "role", "PL"), el("b", "", s.pl));
    if (s.members) team.append(el("span", "role", "担当"), el("span", "", people(s).join("・")));
    d.append(block("PL・担当者", s.pl || s.members ? team : null));
    const links = el("span", "mini-links");
    links.append(miniLink("BOX", s.box_url, "BOX"), miniLink("サービス資料（日）", s.intro_ja_url, "サービス資料（日本語）"),
      miniLink("サービス資料（英）", s.intro_en_url, "サービス資料（英語）"));
    d.append(block("リンク", links));
    let pfBox = null;
    if (s.platforms.length) {
      pfBox = el("div", "links");
      for (const no of s.platforms) {
        const a = el("a", "pf-chip");
        a.href = `/platforms?id=${enc(no)}`;
        a.target = "_blank";
        a.rel = "noopener";
        a.title = "基盤技術で開く";
        a.append(el("b", "", no), platformTitle(no) || "", el("span", "arrow", "↗"));
        pfBox.append(a);
      }
    }
    d.append(block("関連する基盤技術", pfBox));
    d.append(block("ゴール", s.goal), block("課題", s.issues), block("タスク", renderTasks(s)));
    sec.append(d);
  }
  return sec;
}

// タスク: ガントチャートで PJ名 = 関連する基盤番号 のタスク（表示のみ）
function renderTasks(s) {
  const box = el("div");
  if (!s.platforms.length) {
    box.append(el("span", "none", "関連する基盤技術を設定すると、その基盤番号のガントチャートのタスクが表示されます"));
    return box;
  }
  const tasks = state.tasks.filter((t) => s.platforms.includes(t.project))
    .sort((a, b) => a.end_date.localeCompare(b.end_date) || a.start_date.localeCompare(b.start_date));
  if (!tasks.length) {
    box.append(el("span", "none", "関連する基盤番号のタスクはまだありません（ガントチャートで PJ名に基盤番号を選んで追加）"));
  } else {
    const table = el("table", "svc-tasks");
    table.innerHTML = "<thead><tr><th>PJ名</th><th>タスク</th><th>領域</th><th>担当者</th><th>優先度</th><th>期間</th><th>終了日</th></tr></thead>";
    const tbody = el("tbody");
    const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    for (const t of tasks) {
      const tr = el("tr");
      const left = Math.round((parseDate(t.end_date) - todayMs()) / DAY_MS);
      const due = left < 0 ? "overdue" : left <= 3 ? "soon" : "";
      const td = (text, cls = "") => { const x = el("td", cls, text); tr.append(x); return x; };
      // PJ名をクリックすると、その PJ名で絞り込んだガントチャートを開く
      const pjTd = el("td", "nowrap");
      const pj = el("a", "pj-link", t.project);
      pj.href = `/?pj=${enc(t.project)}`;
      pj.target = "_blank";
      pj.rel = "noopener";
      pj.title = `ガントチャートで ${t.project} のタスクを表示・編集`;
      pjTd.append(pj);
      tr.append(pjTd);
      const name = td(t.task, due ? `t-name ${due}` : "t-name");
      if (t.detail) name.title = t.detail;
      td(t.area, "nowrap");
      td(t.assignee || "—", "nowrap");
      const pr = td(t.priority, "nowrap prio");
      pr.dataset.v = t.priority;
      td(`${md(t.start_date)} 〜 ${md(t.end_date)}`, "nowrap");
      const end = td(t.end_date.replaceAll("-", "/"), `nowrap ${due}`);
      if (due) end.title = due === "overdue" ? `期限超過（${-left} 日経過）` : `期限まであと ${left} 日`;
      tbody.append(tr);
    }
    table.append(tbody);
    const wrap = el("div", "table-scroll");
    wrap.append(table);
    box.append(wrap);
  }
  return box;
}

// ------------------------------------------------------------ 追加・編集ダイアログ
const form = $("#form-svc");

function chips(boxSel, items, selected, name, labelOf, colorOf) {
  const box = $(boxSel);
  box.innerHTML = "";
  for (const v of items) {
    const lab = el("label");
    lab.style.setProperty("--c", colorOf(v));
    const cb = el("input");
    cb.type = "checkbox";
    cb.name = name;
    cb.value = v;
    cb.checked = selected.includes(v);
    lab.classList.toggle("on", cb.checked);
    cb.addEventListener("change", () => lab.classList.toggle("on", cb.checked));
    lab.append(cb);
    labelOf(lab, v);
    box.append(lab);
  }
  if (!items.length) box.append(el("span", "hint", name === "platforms" ? "基盤番号が未登録です（管理サイトで登録）" : "未登録"));
}

function openDialog(s = null) {
  state.editing = s;
  form.reset();
  for (const k of ["service_no", "name", "pl", "members", "box_url", "intro_ja_url", "intro_en_url", "goal", "issues"]) {
    form[k].value = s?.[k] || "";
  }
  const areas = [...state.areas, ...(s?.areas || []).filter((a) => !state.areas.includes(a))];
  chips("#svc-areas", areas, s?.areas || [], "areas", (lab, v) => lab.append(v), areaColor);
  const pfs = [...state.platforms.map((p) => p.name), ...(s?.platforms || []).filter((n) => !state.platforms.some((p) => p.name === n))];
  chips("#svc-platforms", pfs, s?.platforms || [], "platforms", (lab, v) => {
    lab.append(v);
    if (platformTitle(v)) lab.append(" ", el("small", "", platformTitle(v)));
  }, () => "var(--accent)");
  $("#svc-title").textContent = s ? `サービスの編集（${s.service_no}）` : "サービス追加";
  $("#svc-submit").textContent = s ? "保存" : "追加";
  $("#svc-delete").hidden = !s;
  $("#svc-error").textContent = "";
  $("#dlg-svc").showModal();
  (s ? form.name : form.service_no).focus();
}

$("#btn-add").addEventListener("click", () => openDialog());
$("#dlg-svc [data-close]").addEventListener("click", () => $("#dlg-svc").close());

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ["service_no", "name", "pl", "members", "box_url", "intro_ja_url", "intro_en_url", "goal", "issues"]) {
    body[k] = form[k].value.trim();
  }
  body.areas = [...form.querySelectorAll('input[name="areas"]:checked')].map((i) => i.value);
  body.platforms = [...form.querySelectorAll('input[name="platforms"]:checked')].map((i) => i.value);
  for (const k of ["box_url", "intro_ja_url", "intro_en_url"]) {
    if (body[k] && !safeUrl(body[k])) {
      $("#svc-error").textContent = "リンクは http:// または https:// で始まる URL を入力してください";
      return;
    }
  }
  const s = state.editing;
  try {
    const saved = await api(s ? `/api/services/${s.id}` : "/api/services", { method: s ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-svc").close();
    await reload();
    toast(s ? "保存しました" : "サービスを追加しました");
    flash(saved.service_no);
  } catch (err) {
    $("#svc-error").textContent = err.message;
  }
});

// ------------------------------------------------------------ 親リンク（一番上）
function renderParentLink() {
  const box = $("#parent-link");
  box.innerHTML = "";
  const { label, url } = state.parentLink || {};
  const u = safeUrl(url);
  if (u) {
    const a = el("a", "", `${label || u} ↗`);
    a.href = u;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = u;
    box.append(a);
  } else {
    box.append(el("span", "unset", "未設定（✎ から設定）"));
  }
}
$("#btn-parent-edit").addEventListener("click", () => {
  const f = $("#form-parent");
  f.label.value = state.parentLink?.label || "";
  f.url.value = state.parentLink?.url || "";
  $("#parent-error").textContent = "";
  $("#dlg-parent").showModal();
  f.label.focus();
});
$("#dlg-parent [data-close]").addEventListener("click", () => $("#dlg-parent").close());
$("#form-parent").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { label: f.label.value.trim(), url: f.url.value.trim() };
  if (body.url && !safeUrl(body.url)) { $("#parent-error").textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
  try {
    state.parentLink = await api("/api/services/parent-link", { method: "PUT", body: JSON.stringify(body) });
    renderParentLink();
    $("#dlg-parent").close();
    toast("親リンクを保存しました");
  } catch (err) {
    $("#parent-error").textContent = err.message;
  }
});

// ------------------------------------------------------------ 主要サービスパッケージ（左 1/3）
function renderPackages() {
  const box = $("#pkg-list");
  box.innerHTML = "";
  if (!state.packages.length) {
    box.append(el("p", "pkg-empty", "まだパッケージがありません。「＋ パッケージ追加」から登録してください。"));
    return;
  }
  for (const pkg of state.packages) {
    const card = el("div", "pkg-card");
    const top = el("div", "pkg-top");
    top.append(el("div", "pkg-name", pkg.name));
    const edit = el("button", "edit-btn", "✎");
    edit.title = "パッケージを編集";
    edit.addEventListener("click", () => openPackageDialog(pkg));
    top.append(edit);
    card.append(top);
    const links = el("div", "mini-links");
    links.append(miniLink("パッケージ資料（日）", pkg.intro_ja_url, "パッケージ資料（日本語）"),
      miniLink("パッケージ資料（英）", pkg.intro_en_url, "パッケージ資料（英語）"), miniLink("BOX", pkg.box_url, "BOX"));
    card.append(links);
    // 関連サービスは登録したときだけ表示（未登録なら行ごと出さない）
    const svcs = el("div", "pkg-svcs");
    svcs.append(el("span", "lbl", `関連サービス（${pkg.services.length}）`));
    for (const no of pkg.services) {
      const svc = state.services.find((x) => x.service_no === no);
      const b = el("button", svc ? "pkg-svc" : "pkg-svc missing");
      b.type = "button";
      b.append(el("b", "", no), svc ? svc.name : "（未登録）");
      if (svc) {
        b.title = "右のサービス一覧で表示";
        b.addEventListener("click", () => showService(no));
      }
      svcs.append(b);
    }
    if (pkg.services.length) card.append(svcs);
    box.append(card);
  }
}

// 領域の札（すべて + 各領域）。押すとその領域で絞り込み、もう一度押すと解除
function renderAreaChips() {
  const box = $("#area-chips");
  box.innerHTML = "";
  const counts = Object.fromEntries(state.areas.map((a) => [a, state.services.filter((s) => s.areas.includes(a)).length]));
  const chip = (value, label, n) => {
    const b = el("button", `area-chip${state.area === value ? " on" : ""}`);
    b.type = "button";
    if (value) b.style.setProperty("--c", areaColor(value));
    b.append(label, el("span", "n", String(n)));
    b.addEventListener("click", () => {
      state.area = state.area === value ? "" : value;
      $("#f-area").value = state.area;
      renderAreaChips();
      render();
      syncExport();
    });
    box.append(b);
  };
  chip("", "すべて", state.services.length);
  for (const a of state.areas) if (counts[a]) chip(a, a, counts[a]);
}

// 関連サービスをクリック: 絞り込みで隠れていれば解除して、右側でそのサービスを開く
function showService(no) {
  const svc = state.services.find((x) => x.service_no === no);
  if (!svc) return;
  if (!filtered().includes(svc)) {
    state.q = state.area = state.person = "";
    $("#q").value = "";
    refreshFilters();
    syncExport();
  }
  flash(no);
}

let pkgEditing = null;
function openPackageDialog(pkg = null) {
  pkgEditing = pkg;
  const f = $("#form-pkg");
  f.reset();
  for (const k of ["name", "intro_ja_url", "intro_en_url", "box_url"]) f[k].value = pkg?.[k] || "";
  const nos = [...state.services.map((x) => x.service_no), ...(pkg?.services || []).filter((n) => !state.services.some((x) => x.service_no === n))];
  chips("#pkg-services", nos, pkg?.services || [], "services", (lab, v) => {
    lab.append(v);
    const svc = state.services.find((x) => x.service_no === v);
    if (svc) lab.append(" ", el("small", "", svc.name));
  }, () => "var(--accent)");
  $("#pkg-title").textContent = pkg ? "パッケージの編集" : "パッケージ追加";
  $("#pkg-submit").textContent = pkg ? "保存" : "追加";
  $("#pkg-delete").hidden = !pkg;
  $("#pkg-error").textContent = "";
  $("#dlg-pkg").showModal();
  f.name.focus();
}
$("#btn-pkg-add").addEventListener("click", () => openPackageDialog());
$("#dlg-pkg [data-close]").addEventListener("click", () => $("#dlg-pkg").close());
$("#form-pkg").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {};
  for (const k of ["name", "intro_ja_url", "intro_en_url", "box_url"]) body[k] = f[k].value.trim();
  body.services = [...f.querySelectorAll('input[name="services"]:checked')].map((i) => i.value);
  for (const k of ["intro_ja_url", "intro_en_url", "box_url"]) {
    if (body[k] && !safeUrl(body[k])) { $("#pkg-error").textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
  }
  try {
    await api(pkgEditing ? `/api/services/packages/${pkgEditing.id}` : "/api/services/packages",
      { method: pkgEditing ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-pkg").close();
    await reload();
    toast(pkgEditing ? "パッケージを保存しました" : "パッケージを追加しました");
  } catch (err) {
    $("#pkg-error").textContent = err.message;
  }
});
$("#pkg-delete").addEventListener("click", () => {
  if (!pkgEditing) return;
  $("#dlg-pkg").close();
  const f = $("#form-pkg-delete");
  f.reset();
  $("#pkg-delete-target").textContent = pkgEditing.name;
  $("#pkg-delete-error").textContent = "";
  $("#dlg-pkg-delete").showModal();
  f.password.focus();
});
$("#dlg-pkg-delete [data-close]").addEventListener("click", () => $("#dlg-pkg-delete").close());
$("#form-pkg-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api(`/api/services/packages/${pkgEditing.id}`, { method: "DELETE", body: JSON.stringify({ password: f.password.value }) });
    $("#dlg-pkg-delete").close();
    await reload();
    toast(`パッケージ「${pkgEditing.name}」を削除しました`);
  } catch (err) {
    $("#pkg-delete-error").textContent = err.message;
    f.password.select();
  }
});

function flash(no) {
  if (!document.getElementById(`svc-${no}`)) return;
  expanded.add(no);
  render();
  const row = document.getElementById(`svc-${no}`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "start" });
  row.classList.remove("flash");
  void row.offsetWidth;
  row.classList.add("flash");
}

// ---- 削除（パスワード必須）
$("#svc-delete").addEventListener("click", () => {
  const s = state.editing;
  if (!s) return;
  $("#dlg-svc").close();
  const f = $("#form-svc-delete");
  f.reset();
  $("#svc-delete-target").textContent = `${s.service_no} ${s.name}`;
  $("#svc-delete-error").textContent = "";
  $("#dlg-svc-delete").showModal();
  f.password.focus();
});
$("#dlg-svc-delete [data-close]").addEventListener("click", () => $("#dlg-svc-delete").close());
$("#form-svc-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const s = state.editing;
  try {
    await api(`/api/services/${s.id}`, { method: "DELETE", body: JSON.stringify({ password: f.password.value }) });
    $("#dlg-svc-delete").close();
    await reload();
    toast(`サービス「${s.name}」を削除しました`);
  } catch (err) {
    $("#svc-delete-error").textContent = err.message;
    f.password.select();
  }
});

// ------------------------------------------------------------ 読み込み・ツールバー
async function reload() {
  const [services, platforms, areas, tasks, packages, parentLink] = await Promise.all([
    api("/api/services"), api("/api/platforms"), api("/api/masters/areas"), api("/api/tasks"), api("/api/services/packages"),
    api("/api/services/parent-link"),
  ]);
  Object.assign(state, { services, platforms, areas, tasks, packages, parentLink });
  renderParentLink();
  refreshFilters();
  render();
  renderPackages();
  syncExport();
}

$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#f-area").addEventListener("change", (e) => { state.area = e.target.value; render(); syncExport(); });
$("#f-person").addEventListener("change", (e) => { state.person = e.target.value; render(); syncExport(); });

// ---- CSV エクスポート（領域・メンバーの絞り込みを反映）
function syncExport() {
  const params = new URLSearchParams();
  if (state.area) params.set("area", state.area);
  if (state.person) params.set("person", state.person);
  const q = params.toString();
  $("#btn-export").href = `/api/services/export.csv${q ? `?${q}` : ""}`;
}

// ---- CSV インポート（サービス番号で追加・更新）
$("#btn-import").addEventListener("click", () => {
  $("#import-file").value = "";
  $("#import-file").click();
});
$("#import-file").addEventListener("change", () => {
  const file = $("#import-file").files[0];
  if (!file) return;
  $("#import-filename").textContent = file.name;
  $("#import-error").textContent = "";
  $("#dlg-import").showModal();
});
$("#dlg-import [data-close]").addEventListener("click", () => $("#dlg-import").close());
$("#form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  const fd = new FormData();
  fd.append("file", $("#import-file").files[0]);
  try {
    const res = await fetch("/api/services/import", { method: "POST", body: fd });
    if (res.status === 401) { location.href = "/login?next=/services"; return; }
    const d = await res.json();
    if (!res.ok) throw new Error(typeof d.detail === "string" ? d.detail : "取り込みに失敗しました");
    $("#dlg-import").close();
    await reload();
    toast(`インポート完了: 追加 ${d.added} 件 / 更新 ${d.updated} 件`);
  } catch (err) {
    $("#import-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  try {
    await reload();
    // /services#svc-S-001 のようなリンクで来た場合はそのサービスへ移動
    const target = decodeURIComponent(location.hash.replace(/^#svc-/, ""));
    if (target) flash(target);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
