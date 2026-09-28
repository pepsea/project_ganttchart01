"use strict";

// グループ目標: 左にグループ一覧、右に選んだグループ（グループ名・リーダー・メンバー・全体目標・目標）。リーダーはデータ上は pl 列
const DAY_MS = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
const state = { groups: [], goals: [], achievements: [], statuses: [], current: null, services: [], platforms: [],
  year: null, currentYear: null, years: [] }; // year: 表示中の年度（"" = すべての年度）
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
// 年度（4 月始まり）
const fiscalYearOf = (s) => {
  if (!s) return null;
  const [y, m] = s.split("-").map(Number);
  return m >= 4 ? y : y - 1;
};
const yearLabel = (y) => (y ? `${y}年度` : "すべての年度");
const yearQuery = () => (state.year ? `?year=${state.year}` : "");
function yearOptions(select, value, withAll = false) {
  select.innerHTML = "";
  if (withAll) select.append(new Option("すべての年度", ""));
  const ys = [...new Set([...state.years, value].filter(Boolean))].sort((a, b) => b - a);
  for (const y of ys) select.append(new Option(`${y}年度${y === state.currentYear ? "（今年度）" : ""}`, y));
  select.value = value ?? "";
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
  if (g.pl) line.append(el("span", "role", "リーダー"), el("b", "", g.pl));
  if (g.members) line.append(el("span", "role", "メンバー"), el("span", "", people(g).join("・")));
  if (!g.pl && !g.members) line.append(el("span", "hint", "リーダー・メンバー未設定"));
  return line;
}

// ------------------------------------------------------------ 一覧
// グループの色: id から決める（並べ替え・追加削除で他のグループの色が変わらない）
const groupColor = (g) => `hsl(${(210 + g.id * 67) % 360} 62% 50%)`;

function renderList() {
  const ul = $("#gp-items");
  ul.innerHTML = "";
  if (!state.groups.length) {
    ul.append(el("li", "hint gp-empty", "まだグループがありません。「＋ グループ追加」から登録してください。"));
    return;
  }
  for (const g of state.groups) {
    const li = el("li", "gp-item");
    li.style.setProperty("--gc", groupColor(g));
    li.classList.toggle("on", g.id === state.current);
    li.append(el("span", "ttl", g.name));
    const meter = el("div", "meter");
    const bar = el("i");
    bar.style.width = g.goal_total ? `${(g.goal_done / g.goal_total) * 100}%` : "0";
    meter.append(bar);
    const meta = el("div", "meta", `目標 ${g.goal_done}/${g.goal_total}`);
    // next_due = 未達成（達成・保留以外）の目標で一番早い期限
    if (g.next_due && daysLeft(g.next_due) < 0) meta.append(el("span", "over-badge", "期限超過あり"));
    li.append(meter, meta);
    const team = [g.pl && `リーダー ${g.pl}`, g.members && `メンバー ${people(g).join("・")}`].filter(Boolean).join(" ／ ");
    if (team) li.append(el("div", "team", team));
    li.addEventListener("click", () => select(g.id));
    ul.append(li);
  }
}

async function select(id) {
  state.current = id;
  history.replaceState(null, "", `/groups?id=${id}&year=${state.year || "all"}`);
  [state.goals, state.achievements] = await Promise.all([
    api(`/api/groups/${id}/goals${yearQuery()}`), api(`/api/groups/${id}/achievements${yearQuery()}`),
  ]);
  renderList();
  renderDetail();
}

// ------------------------------------------------------------ 詳細
// 並び: 見出し → 大目標 → 目標（達成基準・時期）→ 年度ごとの達成したこと → 関連基盤技術（目標の達成状況）→ 関連サービス
function renderDetail() {
  const g = state.groups.find((x) => x.id === state.current);
  const root = $("#detail");
  root.innerHTML = "";
  if (!g) {
    root.append(el("p", "hint gp-empty", "左の一覧からグループを選択してください。"));
    return;
  }
  // 見出し: グループ名・リーダー・メンバー・サマリー
  root.style.setProperty("--gc", groupColor(g));
  const head = el("div", "gp-head");
  const box = el("div");
  box.append(el("h2", "", g.name), teamLine(g));
  const edit = el("button", "", "✎ 編集");
  edit.title = "グループ名・リーダー・メンバー・大目標・関連サービス / 基盤技術を編集";
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
    stat(`${state.year ? `${state.year}年度に` : ""}達成したこと`, `${state.achievements.length}<small> 件</small>`),
  );
  head.append(stats);
  root.append(head);

  // 大目標
  const vs = el("section", "gp-section");
  const vh = el("h3", "", "大目標");
  vh.append(el("span", "hint", "中長期的に目指すこと（「✎ 編集」から変更）"));
  vs.append(vh, el("div", `vision-text${g.vision ? "" : " hint"}`, g.vision || "未記入（「✎ 編集」から入力）"));
  root.append(vs);

  root.append(renderGoals(g), renderAchievements(g), renderPlatformRelations(g), renderServiceRelations(g));
}

// ---- 目標（達成基準・時期）: クリックで編集
function renderGoals(g) {
  const gs = el("section", "gp-section");
  const gh = el("h3", "", state.year ? `${state.year}年度の目標` : "目標（すべての年度）");
  gh.append(el("span", "count-badge", `${g.goal_done} / ${g.goal_total} 達成`), el("span", "hint", "目標をクリックすると編集できます"));
  const add = el("button", "primary right", "＋ 目標を追加");
  add.addEventListener("click", () => openGoalDialog(g, null));
  gh.append(add);
  gs.append(gh);
  if (!state.goals.length) gs.append(el("p", "hint", `${yearLabel(state.year)}の目標はまだありません。「＋ 目標を追加」から登録してください。`));
  const ul = el("ul", "goal-list");
  for (const t of state.goals) {
    const li = el("li");
    li.tabIndex = 0;
    li.title = "クリックして編集";
    const due = goalDue(t);
    li.classList.toggle("done", t.status === "達成");
    if (due) li.classList.add(due); // 期限超過 = 赤、14 日以内 = オレンジ（行全体）
    const st = el("span", "status-badge", t.status);
    st.dataset.v = t.status;
    // 1 目標 1 行: [年度] 目標 [リンク] ｜ 達成基準 ｜ 時期（はみ出す分は「…」、全文はマウスを重ねて表示）
    const main = el("div", "g-main");
    if (!state.year) main.append(el("span", "fy-tag", `${t.fiscal_year}年度`));
    const title = el("span", "g-title", t.title);
    title.title = t.title;
    main.append(title);
    if (safeUrl(t.url)) {
      const a = el("a", "g-link", "リンク ↗");
      a.href = t.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.addEventListener("click", (e) => e.stopPropagation());
      main.append(a);
    }
    const fact = (label, text, cls) => {
      const f = el("span", `fact ${cls}`);
      f.append(el("span", "fl", label), el("span", text ? "fv" : "fv none", text ? text.replace(/\s*\n\s*/g, " ") : "未記入"));
      if (text) f.title = `${label}: ${text}`;
      return f;
    };
    main.append(fact("達成基準", t.criteria, "f-criteria"), fact("時期", t.period, "f-period"));
    if (t.note) li.title = `メモ: ${t.note}\n（クリックして編集）`;
    const d = el("span", `g-due ${due}`, t.due_date ? `期限 ${slashDate(t.due_date)}` : "");
    if (due) d.title = due === "overdue" ? `期限超過（${-daysLeft(t.due_date)} 日経過）` : `期限まであと ${daysLeft(t.due_date)} 日`;
    li.append(st, main, d, el("span", "g-edit", "編集 ›"));
    const openIt = () => openGoalDialog(g, t);
    li.addEventListener("click", openIt);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } });
    ul.append(li);
  }
  gs.append(ul);
  return gs;
}

// ---- 達成したこと（内容・担当者・達成日）: クリックで編集
function renderAchievements(g) {
  const sec = el("section", "gp-section");
  const h = el("h3", "", state.year ? `${state.year}年度に達成したこと` : "達成したこと（すべての年度）");
  h.append(el("span", "hint", "達成したことと担当者を追記"));
  const add = el("button", "primary right", "＋ 追記");
  add.addEventListener("click", () => openAchievementDialog(g, null));
  h.append(add);
  sec.append(h);
  if (!state.achievements.length) {
    sec.append(el("p", "hint", `${yearLabel(state.year)}の記録はまだありません。「＋ 追記」から登録してください。`));
    return sec;
  }
  const ul = el("ul", "ach-list");
  for (const a of state.achievements) {
    const li = el("li");
    li.tabIndex = 0;
    li.title = "クリックして編集";
    const main = el("div", "a-main");
    const at = el("span", "a-title", a.title);
    at.title = a.title;
    if (!state.year) main.append(el("span", "fy-tag", `${a.fiscal_year}年度`));
    main.append(at);
    if (safeUrl(a.url)) {
      const link = el("a", "g-link", "リンク ↗");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (e) => e.stopPropagation());
      main.append(link);
    }
    if (a.note) {
      const n = el("span", "a-note", a.note.replace(/\s*\n\s*/g, " "));
      n.title = a.note; // 一行に収まらない分はマウスを重ねると全文を表示
      main.append(n);
    }
    li.append(el("span", "a-date", a.achieved_on ? slashDate(a.achieved_on) : "—"), main,
      el("span", a.owner ? "a-owner" : "a-owner none", a.owner ? `担当 ${a.owner.split(" ").join("・")}` : "担当未設定"));
    const openIt = () => openAchievementDialog(g, a);
    li.addEventListener("click", openIt);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } });
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

// 関連基盤技術（上）: 基盤ごとに目標の達成状況（達成数・進み具合）と目標の一覧
function renderPlatformRelations(g) {
  const sec = el("section", "gp-section");
  const h = el("h3", "", "関連基盤技術");
  h.append(el("span", "hint", "目標の達成状況（基盤名をクリックで基盤技術の画面を開く。「✎ 編集」から変更）"));
  sec.append(h);
  if (!g.platforms.length) {
    sec.append(el("p", "hint", "なし"));
    return sec;
  }
  const list = el("div", "pf-rel-list");
  for (const no of g.platforms) {
    const pf = state.platforms.find((p) => p.name === no) || { name: no, title: "", goal_done: 0, goal_total: 0 };
    const item = el("div", "pf-rel");
    const top = el("div", "pf-rel-top");
    const a = el("a", "pf-rel-name");
    a.href = `/platforms?id=${encodeURIComponent(no)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.append(el("b", "", no), pf.title || "（基盤名未設定）", el("span", "arrow", "↗"));
    const meter = el("div", "meter");
    const bar = el("i");
    bar.style.width = pf.goal_total ? `${(pf.goal_done / pf.goal_total) * 100}%` : "0";
    meter.append(bar);
    const rate = el("span", "pf-rel-rate", pf.goal_total ? `${pf.goal_done} / ${pf.goal_total} 達成` : "目標なし");
    top.append(a, meter, rate);
    item.append(top);
    // 目標の一覧（読み込み後に表示）
    const ul = el("ul", "pf-rel-goals");
    ul.append(el("li", "hint", "読み込み中…"));
    item.append(ul);
    api(`/api/platforms/${encodeURIComponent(no)}/goals`).then((goals) => {
      ul.innerHTML = "";
      if (!goals.length) {
        ul.append(el("li", "hint", "目標はまだありません"));
        return;
      }
      for (const t of goals) {
        const li = el("li");
        const st = el("span", "status-badge", t.status);
        st.dataset.v = t.status;
        const due = goalDue(t);
        li.classList.toggle("done", t.status === "達成");
        li.append(st, el("span", "g-t", t.title),
          el("span", `g-due ${due}`, t.due_date ? `期限 ${slashDate(t.due_date)}` : ""));
        ul.append(li);
      }
    }).catch(() => { ul.innerHTML = ""; ul.append(el("li", "hint", "目標を読み込めませんでした")); });
    list.append(item);
  }
  sec.append(list);
  return sec;
}

// 関連サービス（下）
function renderServiceRelations(g) {
  const sec = el("section", "gp-section");
  const h = el("h3", "", "関連サービス");
  h.append(el("span", "hint", "クリックでサービスの画面を開く（「✎ 編集」から変更）"));
  sec.append(h);
  const chips = el("div", "rel-chips");
  for (const no of g.services) {
    const a = el("a", "rel-chip");
    a.href = `/services#svc-${encodeURIComponent(no)}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.append(el("b", "", no), serviceName(no), el("span", "arrow", "↗"));
    chips.append(a);
  }
  if (!g.services.length) chips.append(el("span", "hint", "なし"));
  sec.append(chips);
  return sec;
}

// ---- 達成したことの追加・編集
let achEditing = null; // { group, item }
const achForm = $("#form-ach");
function openAchievementDialog(g, a) {
  achEditing = { group: g, item: a };
  achForm.reset();
  achForm.title.value = a?.title || "";
  achForm.owner.value = a?.owner || "";
  achForm.achieved_on.value = a?.achieved_on || "";
  achForm.note.value = a?.note || "";
  achForm.url.value = a?.url || "";
  yearOptions(achForm.fiscal_year, a?.fiscal_year || state.year || state.currentYear);
  $("#ach-title").textContent = a ? "達成したことの編集" : "達成したことを追記";
  $("#ach-meta").textContent = a ? `${g.name}　／　最終更新 ${a.updated_at.slice(0, 16)}` : g.name;
  $("#ach-submit").textContent = a ? "保存" : "追記";
  $("#ach-delete").hidden = !a;
  $("#ach-error").textContent = "";
  $("#dlg-ach").showModal();
  achForm.title.focus();
}
// 達成日を入れたら年度を合わせる
achForm.achieved_on.addEventListener("change", () => {
  const y = fiscalYearOf(achForm.achieved_on.value);
  if (!y) return;
  if (![...achForm.fiscal_year.options].some((o) => Number(o.value) === y)) yearOptions(achForm.fiscal_year, y);
  achForm.fiscal_year.value = y;
});
$("#dlg-ach [data-close]").addEventListener("click", () => $("#dlg-ach").close());
achForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const { group, item } = achEditing;
  const body = { title: achForm.title.value.trim(), owner: achForm.owner.value.trim(), achieved_on: achForm.achieved_on.value || null, note: achForm.note.value, url: achForm.url.value.trim(),
    fiscal_year: Number(achForm.fiscal_year.value) };
  try {
    await api(item ? `/api/groups/${group.id}/achievements/${item.id}` : `/api/groups/${group.id}/achievements`,
      { method: item ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-ach").close();
    await reload(group.id);
    toast(item ? "保存しました" : "追記しました");
  } catch (err) {
    $("#ach-error").textContent = err.message;
  }
});
$("#ach-delete").addEventListener("click", () => {
  const { group, item } = achEditing;
  $("#dlg-ach").close();
  openDelete("記録", `達成したこと: ${item.title}`, `/api/groups/${group.id}/achievements/${item.id}`, () => reload(group.id));
});

// ------------------------------------------------------------ グループの追加・編集
let groupEditing = null;
function openGroupDialog(g = null) {
  groupEditing = g;
  const f = $("#form-group");
  f.reset();
  for (const k of ["name", "pl", "members", "vision"]) f[k].value = g?.[k] || "";
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
    name: f.name.value.trim(), pl: f.pl.value.trim(), members: f.members.value, vision: f.vision.value,
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
  f.criteria.value = t?.criteria || "";
  f.period.value = t?.period || "";
  f.due_date.value = t?.due_date || "";
  f.note.value = t?.note || "";
  f.url.value = t?.url || "";
  yearOptions(f.fiscal_year, t?.fiscal_year || state.year || state.currentYear);
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
  const body = {
    title: f.title.value.trim(), criteria: f.criteria.value, period: f.period.value.trim(),
    status: f.status.value, due_date: f.due_date.value || null, note: f.note.value, url: f.url.value.trim(),
    fiscal_year: Number(f.fiscal_year.value),
  };
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

// ------------------------------------------------------------ 年度の切り替え
$("#year-select").addEventListener("change", async (e) => {
  state.year = e.target.value ? Number(e.target.value) : "";
  await reload();
});

// ------------------------------------------------------------ 年度の登録（追加・削除）
let yearRegistered = [];
async function loadYearList() {
  const info = await api("/api/groups/years");
  yearRegistered = info.registered;
  const ul = $("#year-list");
  ul.innerHTML = "";
  for (const y of yearRegistered) {
    const li = el("li");
    const used = y.goals + y.achievements;
    li.append(el("b", "", `${y.year}年度`));
    if (y.year === info.current) li.append(el("span", "cur", "今年度"));
    li.append(el("span", "use", used ? `目標 ${y.goals} 件・達成したこと ${y.achievements} 件` : "未使用"), el("span", "spacer"));
    const del = el("button", "danger-outline", "削除");
    del.type = "button";
    del.disabled = used > 0;
    del.title = used ? "目標・達成したことが登録されている年度は削除できません" : "この年度を選択肢から外す";
    del.addEventListener("click", async () => {
      if (!confirm(`${y.year}年度を年度の選択肢から削除しますか？`)) return;
      try {
        await api(`/api/groups/years/${y.year}`, { method: "DELETE" });
        if (state.year === y.year) state.year = "";
        await loadYearList();
        await reload();
        toast(`${y.year}年度を削除しました`);
      } catch (err) {
        $("#year-error").textContent = err.message;
      }
    });
    li.append(del);
    ul.append(li);
  }
  if (!yearRegistered.length) ul.append(el("li", "hint", "登録された年度はありません"));
}
$("#btn-years").addEventListener("click", async () => {
  $("#form-year").reset();
  $("#year-error").textContent = "";
  await loadYearList();
  $("#dlg-years").showModal();
  $("#form-year").year.focus();
});
$("#dlg-years [data-close]").addEventListener("click", () => $("#dlg-years").close());
$("#form-year").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const year = Number(f.year.value);
  try {
    await api("/api/groups/years", { method: "POST", body: JSON.stringify({ year }) });
    f.reset();
    $("#year-error").textContent = "";
    await loadYearList();
    await reload();
    toast(`${year}年度を登録しました`);
  } catch (err) {
    $("#year-error").textContent = err.message;
  }
});

// ------------------------------------------------------------ 読み込み
async function reload(selectId = state.current) {
  const info = await api("/api/groups/years");
  state.currentYear = info.current;
  state.years = info.years;
  if (state.year === null) state.year = ""; // 初期表示はすべての年度
  yearOptions($("#year-select"), state.year || "", true);
  state.groups = await api(`/api/groups${yearQuery()}`);
  const target = state.groups.find((g) => g.id === selectId) || state.groups[0];
  if (target) await select(target.id);
  else { state.current = null; renderList(); renderDetail(); }
}

(async () => {
  try {
    [state.statuses, state.services, state.platforms] = await Promise.all([
      api("/api/groups/goal-statuses"), api("/api/services"), api("/api/platforms"),
    ]);
    const params = new URLSearchParams(location.search);
    const want = Number(params.get("id")) || null;
    const y = params.get("year");
    if (y === "all") state.year = "";
    else if (Number(y)) state.year = Number(y);
    await reload(want);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();

// ------------------------------------------------------------ CSV エクスポート・インポート
setupCsvTools({
  exportUrl: "/api/groups/export.csv", importUrl: "/api/groups/import",
  note: "・グループ名が同じグループは更新、無ければ追加します\n・目標と達成したことは、同じグループ・年度・内容なら更新、無ければ追加します",
  summary: (d) => `グループ 追加 ${d.groups_added} / 更新 ${d.groups_updated}・目標 ${d.goals}・達成したこと ${d.achievements}・年度 ${d.years}`,
  after: () => reload(), toast,
});
