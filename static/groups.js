"use strict";

// グループ目標: 左にグループ一覧、右に選んだグループ（グループ名・PL・メンバー・全体目標・目標）
const DAY_MS = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
const state = { groups: [], goals: [], statuses: [], current: null, services: [], platforms: [] };
const serviceName = (no) => state.services.find((s) => s.service_no === no)?.name || "";
const platformName = (no) => state.platforms.find((p) => p.name === no)?.title || "";

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
const daysLeft = (s) => Math.round((parseDate(s) - todayMs()) / DAY_MS);
const slashDate = (s) => s.replaceAll("-", "/");
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");
const people = (g) => (g.members ? g.members.split(" ") : []);

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

// 目標の期限状態（達成・保留は対象外）: 超過 = 赤、14 日以内 = オレンジ
function goalDue(g) {
  if (!g.due_date || g.status === "達成" || g.status === "保留") return "";
  const left = daysLeft(g.due_date);
  if (left < 0) return "overdue";
  if (left <= 14) return "soon";
  return "";
}

function teamLine(g) {
  const line = el("div", "team-line");
  if (g.pl) line.append(el("span", "role", "PL"), el("b", "", g.pl));
  if (g.members) line.append(el("span", "role", "メンバー"), el("span", "", people(g).join("・")));
  if (!g.pl && !g.members) line.append(el("span", "hint", "PL・メンバー未設定"));
  return line;
}

// ------------------------------------------------------------ 一覧
function renderList() {
  const ul = $("#gp-items");
  ul.innerHTML = "";
  if (!state.groups.length) {
    ul.append(el("li", "hint gp-empty", "まだグループがありません。「＋ グループ追加」から登録してください。"));
    return;
  }
  for (const g of state.groups) {
    const li = el("li", "gp-item");
    li.classList.toggle("on", g.id === state.current);
    li.append(el("span", "ttl", g.name));
    const meter = el("div", "meter");
    const bar = el("i");
    bar.style.width = g.goal_total ? `${(g.goal_done / g.goal_total) * 100}%` : "0";
    meter.append(bar);
    li.append(meter, el("div", "meta", `目標 ${g.goal_done}/${g.goal_total}`));
    const team = [g.pl && `PL ${g.pl}`, g.members && `メンバー ${people(g).join("・")}`].filter(Boolean).join(" ／ ");
    if (team) li.append(el("div", "team", team));
    li.addEventListener("click", () => select(g.id));
    ul.append(li);
  }
}

async function select(id) {
  state.current = id;
  history.replaceState(null, "", `/groups?id=${id}`);
  state.goals = await api(`/api/groups/${id}/goals`);
  renderList();
  renderDetail();
}

// ------------------------------------------------------------ 詳細
function renderDetail() {
  const g = state.groups.find((x) => x.id === state.current);
  const root = $("#detail");
  root.innerHTML = "";
  if (!g) {
    root.append(el("p", "hint gp-empty", "左の一覧からグループを選択してください。"));
    return;
  }
  // 見出し: グループ名・PL・メンバー・サマリー
  const head = el("div", "gp-head");
  const box = el("div");
  box.append(el("h2", "", g.name), teamLine(g));
  const edit = el("button", "", "✎ 編集");
  edit.title = "グループ名・PL・メンバー・大目標・達成指標・関連サービス / 基盤技術を編集";
  edit.addEventListener("click", () => openGroupDialog(g));
  const editRow = el("div");
  editRow.style.marginTop = "8px";
  editRow.append(edit);
  box.append(editRow);
  head.append(box, el("span", "spacer"));
  const open = state.goals.filter((x) => x.status !== "達成" && x.status !== "保留");
  const overdue = open.filter((x) => goalDue(x) === "overdue").length;
  const stat = (k, v, cls = "") => {
    const s = el("div", `stat ${cls}`);
    s.append(el("div", "k", k));
    const vv = el("div", "v");
    vv.innerHTML = v;
    s.append(vv);
    return s;
  };
  const stats = el("div", "stats");
  stats.append(
    stat("目標の達成", `${g.goal_done}<small> / ${g.goal_total}</small>`),
    stat("期限超過の目標", `${overdue}<small> 件</small>`, overdue ? "warn" : ""),
    stat("次の期限", g.next_due ? `${g.next_due.slice(5).replace("-", "/")}<small> （あと ${daysLeft(g.next_due)} 日）</small>` : "—"),
  );
  head.append(stats);
  root.append(head);

  // 大目標・今年度の達成指標（左右に並べる）
  const two = el("div", "gp-two");
  const textSection = (title, hint, text) => {
    const sec = el("section", "gp-section");
    const h = el("h3", "", title);
    h.append(el("span", "hint", hint));
    sec.append(h, el("div", `vision-text${text ? "" : " hint"}`, text || "未記入（「✎ 編集」から入力）"));
    return sec;
  };
  two.append(textSection("大目標", "中長期的に目指すこと", g.vision), textSection("今年度の達成指標", "今年度に達成を測る指標", g.kpi));
  root.append(two);

  // 関連サービス・関連基盤技術（クリックでそれぞれの画面へ）
  const rel = el("section", "gp-section");
  const rh = el("h3", "", "関連サービス・関連基盤技術");
  rh.append(el("span", "hint", "クリックでそれぞれの画面を開く"));
  rel.append(rh);
  const relRow = (label, items, href, nameOf) => {
    const row = el("div", "rel-row");
    row.append(el("span", "lbl", label));
    const chips = el("div", "rel-chips");
    for (const no of items) {
      const a = el("a", "rel-chip");
      a.href = href(no);
      a.append(el("b", "", no), nameOf(no), el("span", "arrow", "↗"));
      chips.append(a);
    }
    if (!items.length) chips.append(el("span", "hint", "なし"));
    row.append(chips);
    return row;
  };
  rel.append(
    relRow("関連サービス", g.services, (no) => `/services#svc-${encodeURIComponent(no)}`, serviceName),
    relRow("関連基盤技術", g.platforms, (no) => `/platforms?id=${encodeURIComponent(no)}`, platformName),
  );
  root.append(rel);

  // 目標
  const gs = el("section", "gp-section");
  const gh = el("h3", "", "目標");
  gh.append(el("span", "count-badge", `${g.goal_done} / ${g.goal_total} 達成`), el("span", "hint", "目標をクリックすると編集できます"));
  const add = el("button", "primary right", "＋ 目標を追加");
  add.addEventListener("click", () => openGoalDialog(g, null));
  gh.append(add);
  gs.append(gh);
  if (!state.goals.length) gs.append(el("p", "hint", "まだ目標がありません。「＋ 目標を追加」から登録してください。"));
  const ul = el("ul", "goal-list");
  for (const t of state.goals) {
    const li = el("li");
    li.tabIndex = 0;
    li.title = "クリックして編集";
    const due = goalDue(t);
    li.classList.toggle("done", t.status === "達成");
    const st = el("span", "status-badge", t.status);
    st.dataset.v = t.status;
    const main = el("div");
    const title = el("div", "g-title", t.title);
    if (safeUrl(t.url)) {
      const a = el("a", "g-link", "リンク ↗");
      a.href = t.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.addEventListener("click", (e) => e.stopPropagation());
      title.append(a);
    }
    main.append(title);
    if (t.note) main.append(el("div", "g-note", t.note));
    const d = el("span", `g-due ${due}`, t.due_date ? slashDate(t.due_date) : "期限なし");
    if (due) d.title = due === "overdue" ? `期限超過（${-daysLeft(t.due_date)} 日経過）` : `期限まであと ${daysLeft(t.due_date)} 日`;
    li.append(st, main, d, el("span", "g-edit", "編集 ›"));
    const openIt = () => openGoalDialog(g, t);
    li.addEventListener("click", openIt);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } });
    ul.append(li);
  }
  gs.append(ul);
  root.append(gs);
}

// ------------------------------------------------------------ グループの追加・編集
let groupEditing = null;
function openGroupDialog(g = null) {
  groupEditing = g;
  const f = $("#form-group");
  f.reset();
  for (const k of ["name", "pl", "members", "vision", "kpi"]) f[k].value = g?.[k] || "";
  // 関連サービス・関連基盤技術（複数選択）
  const chips = (sel, items, selected, name, labelOf) => {
    const box = $(sel);
    box.innerHTML = "";
    for (const v of [...items, ...selected.filter((x) => !items.includes(x))]) {
      const lab = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.name = name;
      cb.value = v;
      cb.checked = selected.includes(v);
      lab.classList.toggle("on", cb.checked);
      cb.addEventListener("change", () => lab.classList.toggle("on", cb.checked));
      lab.append(cb, v);
      if (labelOf(v)) lab.append(" ", el("small", "", labelOf(v)));
      box.append(lab);
    }
    if (!box.children.length) box.append(el("span", "hint", "まだ登録がありません"));
  };
  chips("#group-services", state.services.map((x) => x.service_no), g?.services || [], "services", serviceName);
  chips("#group-platforms", state.platforms.map((x) => x.name), g?.platforms || [], "platforms", platformName);
  $("#group-title").textContent = g ? "グループの編集" : "グループ追加";
  $("#group-submit").textContent = g ? "保存" : "追加";
  $("#group-delete").hidden = !g;
  $("#group-error").textContent = "";
  $("#dlg-group").showModal();
  f.name.focus();
}
$("#btn-group-add").addEventListener("click", () => openGroupDialog());
$("#dlg-group [data-close]").addEventListener("click", () => $("#dlg-group").close());
$("#form-group").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim(), pl: f.pl.value.trim(), members: f.members.value, vision: f.vision.value, kpi: f.kpi.value,
    services: [...f.querySelectorAll('input[name="services"]:checked')].map((i) => i.value),
    platforms: [...f.querySelectorAll('input[name="platforms"]:checked')].map((i) => i.value),
  };
  try {
    const saved = await api(groupEditing ? `/api/groups/${groupEditing.id}` : "/api/groups",
      { method: groupEditing ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-group").close();
    await reload(saved.id);
    toast(groupEditing ? "保存しました" : "グループを追加しました");
  } catch (err) {
    $("#group-error").textContent = err.message;
  }
});
$("#group-delete").addEventListener("click", () => {
  const g = groupEditing;
  $("#dlg-group").close();
  openDelete("グループ", `グループ: ${g.name}（目標 ${g.goal_total} 件も一緒に削除されます）`, `/api/groups/${g.id}`, async () => {
    state.current = null;
    await reload();
  });
});

// ------------------------------------------------------------ 目標の追加・編集
let goalEditing = null; // { group, goal }
function openGoalDialog(g, t) {
  goalEditing = { group: g, goal: t };
  const f = $("#form-goal");
  f.reset();
  f.status.innerHTML = "";
  for (const s of state.statuses) f.status.append(new Option(s, s));
  f.status.value = t ? t.status : "未着手";
  f.title.value = t?.title || "";
  f.due_date.value = t?.due_date || "";
  f.note.value = t?.note || "";
  f.url.value = t?.url || "";
  $("#goal-title").textContent = t ? "目標の編集" : "目標の追加";
  $("#goal-meta").textContent = t ? `${g.name}　／　最終更新 ${t.updated_at.slice(0, 16)}` : g.name;
  $("#goal-submit").textContent = t ? "保存" : "追加";
  $("#goal-delete").hidden = !t;
  $("#goal-error").textContent = "";
  $("#dlg-goal").showModal();
  (t ? f.status : f.title).focus();
}
$("#dlg-goal [data-close]").addEventListener("click", () => $("#dlg-goal").close());
$("#form-goal").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const { group, goal } = goalEditing;
  const body = { title: f.title.value.trim(), status: f.status.value, due_date: f.due_date.value || null, note: f.note.value, url: f.url.value.trim() };
  if (body.url && !safeUrl(body.url)) { $("#goal-error").textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
  try {
    await api(goal ? `/api/groups/${group.id}/goals/${goal.id}` : `/api/groups/${group.id}/goals`,
      { method: goal ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-goal").close();
    await reload(group.id);
    toast(goal ? "目標を保存しました" : "目標を追加しました");
  } catch (err) {
    $("#goal-error").textContent = err.message;
  }
});
$("#goal-delete").addEventListener("click", () => {
  const { group, goal } = goalEditing;
  $("#dlg-goal").close();
  openDelete("目標", `目標: ${goal.title}`, `/api/groups/${group.id}/goals/${goal.id}`, () => reload(group.id));
});

// ------------------------------------------------------------ 削除（パスワード必須）
let deleting = null;
function openDelete(label, summary, url, after) {
  deleting = { label, url, after };
  const f = $("#form-delete");
  f.reset();
  $("#delete-title").textContent = `${label}の削除`;
  $("#delete-lead").textContent = `次の${label}を削除します。`;
  $("#delete-target").textContent = summary;
  $("#delete-error").textContent = "";
  $("#dlg-delete").showModal();
  f.password.focus();
}
$("#dlg-delete [data-close]").addEventListener("click", () => $("#dlg-delete").close());
$("#form-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api(deleting.url, { method: "DELETE", body: JSON.stringify({ password: f.password.value }) });
    $("#dlg-delete").close();
    await deleting.after();
    toast(`${deleting.label}を削除しました`);
  } catch (err) {
    $("#delete-error").textContent = err.message;
    f.password.select();
  }
});

// ------------------------------------------------------------ 読み込み
async function reload(selectId = state.current) {
  state.groups = await api("/api/groups");
  const target = state.groups.find((g) => g.id === selectId) || state.groups[0];
  if (target) await select(target.id);
  else { state.current = null; renderList(); renderDetail(); }
}

(async () => {
  try {
    [state.statuses, state.services, state.platforms] = await Promise.all([
      api("/api/groups/goal-statuses"), api("/api/services"), api("/api/platforms"),
    ]);
    const want = Number(new URLSearchParams(location.search).get("id")) || null;
    await reload(want);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
