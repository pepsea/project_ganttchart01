"use strict";

// 参考リンク: 自社サービスの WEB リンク / その他の参考リンク
const $ = (sel, root = document) => root.querySelector(sel);
const state = { links: [], areas: [], q: "", area: "", editing: null };
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
  for (const cat of ["tech", "own", "other"]) {
    const all = state.links.filter((l) => l.category === cat);
    const list = all.filter((l) => (!state.area || l.areas.includes(state.area)) &&
      (!q || [l.title, l.note, l.url, ...l.areas].some((v) => (v || "").toLowerCase().includes(q))));
    const filtering = !!(q || state.area);
    const ul = $(`#list-${cat}`);
    ul.innerHTML = "";
    if (!list.length) {
      ul.append(el("li", "empty-li", all.length ? "条件に合うリンクはありません" : "まだリンクがありません。「＋ 追加」から登録してください。"));
      continue;
    }
    list.forEach((l) => {
      const li = el("li");
      const main = el("div", "l-main");
      const a = el("a", "l-title", `${l.title} ↗`);
      const u = safeUrl(l.url);
      if (u) {
        a.href = u;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = u; // URL は画面に出さず、マウスを重ねたときだけ表示
      }
      main.append(a);
      if (l.note) {
        const n = el("span", "l-note", l.note.replace(/\s*\n\s*/g, " "));
        n.title = l.note; // 一行に収まらない分はマウスを重ねると全文を表示
        main.append(n);
      }
      if (l.areas.length) {
        const tags = el("div", "l-areas");
        for (const a of l.areas) {
          const t = el("span", "area-tag", a);
          t.style.setProperty("--c", areaColor(a));
          tags.append(t);
        }
        main.append(tags);
      }
      const ops = el("div", "l-ops");
      const i = all.indexOf(l);
      const up = el("button", "", "↑");
      up.title = "上へ";
      up.disabled = i === 0 || filtering;
      up.addEventListener("click", () => move(l, "up"));
      const down = el("button", "", "↓");
      down.title = "下へ";
      down.disabled = i === all.length - 1 || filtering;
      down.addEventListener("click", () => move(l, "down"));
      const edit = el("button", "", "✎");
      edit.title = "編集";
      edit.addEventListener("click", () => openDialog(l));
      ops.append(up, down, edit);
      li.append(main, ops);
      ul.append(li);
    });
  }
}

async function move(l, direction) {
  try {
    state.links = await api(`/api/links/${l.id}/move`, { method: "POST", body: JSON.stringify({ direction }) });
    render();
  } catch (err) { toast(err.message, true); }
}

// ------------------------------------------------------------ 追加・編集
const form = $("#form-link");
function openDialog(l = null, category = "own") {
  state.editing = l;
  form.reset();
  form.category.value = l?.category || category;
  form.title.value = l?.title || "";
  form.url.value = l?.url || "";
  form.note.value = l?.note || "";
  // 領域（複数選択）
  const box = $("#link-areas");
  box.innerHTML = "";
  const selected = l?.areas || (state.area ? [state.area] : []);
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
  $("#link-title").textContent = l ? "リンクの編集" : "リンクを追加";
  $("#link-submit").textContent = l ? "保存" : "追加";
  $("#link-delete").hidden = !l;
  $("#link-error").textContent = "";
  $("#dlg-link").showModal();
  form.title.focus();
}
document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => openDialog(null, b.dataset.add)));
$("#dlg-link [data-close]").addEventListener("click", () => $("#dlg-link").close());
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    category: form.category.value, title: form.title.value.trim(), url: form.url.value.trim(), note: form.note.value,
    areas: [...form.querySelectorAll('input[name="areas"]:checked')].map((i) => i.value),
  };
  if (!safeUrl(body.url)) { $("#link-error").textContent = "URL は http:// または https:// で始まるものを入力してください"; return; }
  const l = state.editing;
  try {
    await api(l ? `/api/links/${l.id}` : "/api/links", { method: l ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-link").close();
    await reload();
    toast(l ? "保存しました" : "リンクを追加しました");
  } catch (err) {
    $("#link-error").textContent = err.message;
  }
});

// ---- 削除（パスワード必須）
$("#link-delete").addEventListener("click", () => {
  const l = state.editing;
  if (!l) return;
  $("#dlg-link").close();
  const f = $("#form-link-delete");
  f.reset();
  $("#link-delete-target").textContent = `${l.title}\n${l.url}`;
  $("#link-delete-error").textContent = "";
  $("#dlg-link-delete").showModal();
  f.password.focus();
});
$("#dlg-link-delete [data-close]").addEventListener("click", () => $("#dlg-link-delete").close());
$("#form-link-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api(`/api/links/${state.editing.id}`, { method: "DELETE", body: JSON.stringify({ password: f.password.value }) });
    $("#dlg-link-delete").close();
    await reload();
    toast("リンクを削除しました");
  } catch (err) {
    $("#link-delete-error").textContent = err.message;
    f.password.select();
  }
});

// ------------------------------------------------------------ 読み込み
async function reload() {
  const [links, areas] = await Promise.all([api("/api/links"), api("/api/masters/areas")]);
  state.links = links;
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

// ------------------------------------------------------------ CSV エクスポート・インポート
setupCsvTools({
  exportUrl: "/api/links/export.csv", importUrl: "/api/links/import",
  note: "・欄と URL が同じリンクは更新、無ければ追加します",
  summary: (d) => `追加 ${d.added} 件 / 更新 ${d.updated} 件`,
  after: reload, toast,
});
