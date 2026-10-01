"use strict";

// 共有資料: 資料名・目的・作成日時・資料リンク（何個でも。URL またはフォルダのパス）
const $ = (sel, root = document) => root.querySelector(sel);
const state = { docs: [], areas: [], q: "", area: "", editing: null };
// 領域の色（ほかの画面と同じ）
const areaColor = (a) => {
  let i = state.areas.indexOf(a);
  if (i < 0) i = state.areas.length;
  return `hsl(${(210 + i * 67) % 360} 62% 50%)`;
};

function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
// フォルダのパス（\\サーバー\共有、C:\…、/…、~/…、file://…）。ブラウザからは開けないので、クリックでパスをコピーする
const isPath = (u) => /^(file:\/\/|\\\\|[A-Za-z]:[\\/]|\/|~\/)/i.test(u || "");
const pathLabel = (u, n) => (u.replace(/^file:\/\//i, "").split(/[\\/]+/).filter(Boolean).pop() || `リンク${n}`);
const pad = (n) => String(n).padStart(2, "0");
const nowLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function api(path, options = {}) {
  const res = await fetch(path, { headers: options.body ? { "Content-Type": "application/json" } : {}, ...options });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
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

// ------------------------------------------------------------ 一覧
const CATEGORIES = ["group", "other"]; // group = グループ資料（左）/ other = その他参考資料（右）

function render() {
  const q = state.q.trim().toLowerCase();
  for (const cat of CATEGORIES) {
    const all = state.docs.filter((d) => (d.category || "group") === cat);
    const list = all.filter((d) =>
      (!state.area || d.areas.includes(state.area)) &&
      (!q || [d.title, d.purpose, ...d.areas, ...(d.links || []).map((l) => l.label)].some((v) => (v || "").toLowerCase().includes(q))));
    $(`#count-${cat}`).textContent = `${list.length} 件${list.length !== all.length ? ` / ${all.length}` : ""}`;
    const ul = $(`#list-${cat}`);
    ul.innerHTML = "";
    if (!list.length) {
      ul.append(el("li", "empty-li", all.length ? "条件に合う資料はありません" : "まだ資料がありません。「＋ 追加」から登録してください。"));
      continue;
    }
    // 順番はドラッグ＆ドロップで入れ替え（検索・絞り込み中は不可）
    const filtering = !!(q || state.area);
    for (const d of list) {
      const li = renderDoc(d);
      const handle = dragHandle(!filtering);
      li.prepend(handle);
      if (!filtering) {
        enableDragSort(li, handle, {
          group: `doc-${cat}`, id: d.id, ids: () => all.map((x) => x.id),
          onDrop: (ids) => reorder(cat, ids),
        });
      }
      ul.append(li);
    }
  }
}

// 1 件 = 1 行: 資料名・領域・資料リンク・作成日時・編集（目的は資料名にマウスを置くと表示）
async function reorder(category, ids) {
  try {
    state.docs = await api("/api/documents/reorder", { method: "POST", body: JSON.stringify({ category, ids }) });
    render();
  } catch (err) { toast(err.message, true); }
}

function renderDoc(d) {
  const li = el("li", "doc-row");
  const name = el("span", "doc-name", d.title);
  name.title = d.purpose ? `${d.title}\n目的: ${d.purpose}` : d.title;
  li.append(name);
  const tags = el("span", "area-tags");
  for (const a of d.areas) {
    const t = el("span", "area-tag", a);
    t.style.setProperty("--c", areaColor(a));
    tags.append(t);
  }
  li.append(tags);
  const links = el("span", "doc-links");
  (d.links || []).forEach((lk, i) => {
    const u = safeUrl(lk.url);
    const name = lk.label || (isPath(lk.url) ? pathLabel(lk.url, i + 1) : `リンク${i + 1}`);
    if (u) {
      const a = el("a", "doc-link", `${name} ↗`);
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `${name}: ${u}`;
      links.append(a);
    } else if (isPath(lk.url)) {
      const b = el("button", "doc-link path", `📁 ${name}`);
      b.type = "button";
      b.title = `${name}: ${lk.url}\n（クリックでパスをコピー）`;
      b.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(lk.url);
          toast(`パスをコピーしました: ${lk.url}`);
        } catch (_) {
          prompt("このパスをコピーしてください", lk.url);
        }
      });
      links.append(b);
    }
  });
  if (!links.children.length) links.append(el("span", "none", "リンクなし"));
  li.append(links);
  li.append(el("span", "doc-date", d.created_date.slice(0, 10).replaceAll("-", "/")));
  li.lastChild.title = `作成日時: ${d.created_date.replaceAll("-", "/")}`;
  const edit = el("button", "edit-btn", "✎");
  edit.title = "編集";
  edit.addEventListener("click", () => openDialog(d));
  li.append(edit);
  return li;
}

// ------------------------------------------------------------ 追加・編集
const form = $("#form-doc");
const FIELDS = ["title", "purpose"];

// 資料リンク: 1 つずつ追加（表示名 + URL またはフォルダのパス。✕ で削除）
function addLinkRow(label = "", url = "") {
  const row = el("div", "link-row");
  const n = el("input");
  n.placeholder = "表示名（例: 日本語版）";
  n.value = label;
  const u = el("input");
  u.placeholder = "https://… またはフォルダのパス";
  u.value = url;
  const del = el("button", "link-del", "✕");
  del.type = "button";
  del.title = "このリンクを削除（保存で確定）";
  del.addEventListener("click", () => row.remove());
  row.append(n, u, del);
  row._get = () => ({ label: n.value.trim(), url: u.value.trim() });
  $("#doc-link-rows").append(row);
  return n;
}
$("#btn-add-link").addEventListener("click", () => addLinkRow().focus());
const docLinks = () => [...$("#doc-link-rows").children].map((r) => r._get()).filter((l) => l.url);
const linkOk = (u) => safeUrl(u) || isPath(u);

function openDialog(d = null, category = "group") {
  state.editing = d;
  form.reset();
  form.category.value = d?.category || category;
  for (const k of FIELDS) form[k].value = d?.[k] || "";
  $("#doc-link-rows").innerHTML = "";
  for (const lk of d?.links || []) addLinkRow(lk.label, lk.url);
  // 領域（複数選択）
  const box = $("#doc-areas");
  box.innerHTML = "";
  const selected = d?.areas || (state.area ? [state.area] : []);
  for (const a of [...state.areas, ...selected.filter((x) => !state.areas.includes(x))]) {
    const lab = el("label");
    lab.style.setProperty("--c", areaColor(a));
    const cb = el("input");
    cb.type = "checkbox";
    cb.name = "areas";
    cb.value = a;
    cb.checked = selected.includes(a);
    lab.classList.toggle("on", cb.checked);
    cb.addEventListener("change", () => lab.classList.toggle("on", cb.checked));
    lab.append(cb, a);
    box.append(lab);
  }
  form.created_date.value = d ? d.created_date.replace(" ", "T") + (d.created_date.length === 10 ? "T00:00" : "") : nowLocal();
  $("#doc-title").textContent = d ? "資料の編集" : "資料を追加";
  $("#doc-submit").textContent = d ? "保存" : "追加";
  $("#doc-delete").hidden = !d;
  $("#doc-error").textContent = "";
  $("#dlg-doc").showModal();
  form.title.focus();
}

document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => openDialog(null, b.dataset.add)));
$("#dlg-doc [data-close]").addEventListener("click", () => $("#dlg-doc").close());
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of FIELDS) body[k] = form[k].value.trim();
  body.created_date = form.created_date.value.replace("T", " ");
  body.areas = [...form.querySelectorAll('input[name="areas"]:checked')].map((i) => i.value);
  body.category = form.category.value;
  body.links = docLinks();
  if (body.links.some((l) => !linkOk(l.url))) {
    $("#doc-error").textContent = "リンクは http:// https:// で始まる URL か、フォルダのパス（例: \\\\サーバー\\共有、C:\\資料、/Volumes/共有）で入力してください";
    return;
  }
  const d = state.editing;
  try {
    await api(d ? `/api/documents/${d.id}` : "/api/documents", { method: d ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-doc").close();
    await reload();
    toast(d ? "保存しました" : "資料を追加しました");
  } catch (err) {
    $("#doc-error").textContent = err.message;
  }
});

// ---- 削除（パスワード必須）
$("#doc-delete").addEventListener("click", () => {
  const d = state.editing;
  if (!d) return;
  $("#dlg-doc").close();
  const f = $("#form-doc-delete");
  f.reset();
  $("#doc-delete-target").textContent = d.title;
  $("#doc-delete-error").textContent = "";
  $("#dlg-doc-delete").showModal();
  f.password.focus();
});
$("#dlg-doc-delete [data-close]").addEventListener("click", () => $("#dlg-doc-delete").close());
$("#form-doc-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api(`/api/documents/${state.editing.id}`, { method: "DELETE", body: JSON.stringify({ password: f.password.value }) });
    $("#dlg-doc-delete").close();
    await reload();
    toast("資料を削除しました");
  } catch (err) {
    $("#doc-delete-error").textContent = err.message;
    f.password.select();
  }
});

// ------------------------------------------------------------ 読み込み
async function reload() {
  const [docs, areas] = await Promise.all([api("/api/documents"), api("/api/masters/areas")]);
  state.docs = docs;
  state.areas = areas;
  const fa = $("#f-area");
  fa.innerHTML = "";
  fa.append(new Option("すべて", ""));
  for (const a of areas) fa.append(new Option(a, a));
  if (!areas.includes(state.area)) state.area = "";
  fa.value = state.area;
  render();
}
$("#f-area").addEventListener("change", (e) => { state.area = e.target.value; render(); });
$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
reload().catch((err) => toast(`読み込みに失敗しました: ${err.message}`, true));
