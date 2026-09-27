"use strict";

// 共有資料: 資料名・目的・作成日時・資料リンク 2 つ
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
function render() {
  const q = state.q.trim().toLowerCase();
  const list = state.docs.filter((d) =>
    (!state.area || d.areas.includes(state.area)) &&
    (!q || [d.title, d.purpose, ...d.areas, ...LINKS.map((n) => d[`link${n}_label`])].some((v) => (v || "").toLowerCase().includes(q))));
  $("#doc-count").textContent = `${list.length} 件${list.length !== state.docs.length ? `（全 ${state.docs.length} 件）` : ""}`;
  const tbody = $("#doc-list");
  tbody.innerHTML = "";
  if (!list.length) {
    const tr = el("tr", "empty-row");
    const td = el("td", "", state.docs.length ? "条件に合う資料はありません。" : "まだ資料がありません。「＋ 資料を追加」から登録してください。");
    td.colSpan = 6;
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const d of list) {
    const tr = el("tr");
    const td = (child) => { const x = el("td"); if (child) x.append(child); tr.append(x); return x; };
    td(el("div", "doc-name", d.title));
    td(d.purpose ? el("div", "doc-purpose", d.purpose) : el("span", "none", "—"));
    const tags = el("div", "area-tags");
    for (const a of d.areas) {
      const t = el("span", "area-tag", a);
      t.style.setProperty("--c", areaColor(a));
      tags.append(t);
    }
    td(d.areas.length ? tags : el("span", "none", "—"));
    td(el("span", "doc-date", d.created_date.replaceAll("-", "/")));
    const links = el("div", "doc-links");
    for (const n of LINKS) {
      const label = d[`link${n}_label`];
      const u = safeUrl(d[`link${n}_url`]);
      if (!u) continue;
      const a = el("a", "doc-link", `${label || `リンク${n}`} ↗`);
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = u;
      links.append(a);
    }
    if (!links.children.length) links.append(el("span", "none", "未登録"));
    td(links);
    const edit = el("button", "edit-btn", "✎ 編集");
    edit.addEventListener("click", () => openDialog(d));
    td(edit);
    tbody.append(tr);
  }
}

// ------------------------------------------------------------ 追加・編集
const form = $("#form-doc");
const LINKS = [1, 2, 3, 4]; // 資料リンクは最大 4 つ
const FIELDS = ["title", "purpose", ...LINKS.flatMap((n) => [`link${n}_label`, `link${n}_url`])];

function openDialog(d = null) {
  state.editing = d;
  form.reset();
  for (const k of FIELDS) form[k].value = d?.[k] || "";
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

$("#btn-add").addEventListener("click", () => openDialog());
$("#dlg-doc [data-close]").addEventListener("click", () => $("#dlg-doc").close());
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of FIELDS) body[k] = form[k].value.trim();
  body.created_date = form.created_date.value.replace("T", " ");
  body.areas = [...form.querySelectorAll('input[name="areas"]:checked')].map((i) => i.value);
  for (const k of LINKS.map((n) => `link${n}_url`)) {
    if (body[k] && !safeUrl(body[k])) { $("#doc-error").textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
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
