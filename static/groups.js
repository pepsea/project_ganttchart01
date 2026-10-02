"use strict";

// グループ目標: 左にグループ一覧、右に選んだグループ（グループ名・リーダー・メンバー・全体目標・目標）。リーダーはデータ上は pl 列
const DAY_MS = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
const state = { groups: [], goals: [], achievements: [], achAll: [], statuses: [], current: null, services: [], platforms: [],
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
    li.addEventListener("click", () => {
      if (g.id === state.current) return;
      if (!confirmDiscard()) return; // 書きかけがあれば確認
      state.panelGoal = null;
      state.panelEdit = null;
      state.orphanEdit = null;
      select(g.id);
    });
    ul.append(li);
  }
}

async function select(id) {
  state.current = id;
  history.replaceState(null, "", `/groups?id=${id}&year=${state.year || "all"}`);
  [state.goals, state.goalsAll, state.achAll, state.goalNotes] = await Promise.all([
    api(`/api/groups/${id}/goals${yearQuery()}`), api(`/api/groups/${id}/goals`), api(`/api/groups/${id}/achievements`),
    api(`/api/groups/${id}/goal-notes`),
  ]);
  // 達成したいことは結びついたタスクの中に表示（年度に関わらず）。件数・タスクなしの一覧は選択中の年度で絞る
  state.achievements = state.year ? state.achAll.filter((a) => a.fiscal_year === state.year) : state.achAll;
  renderList();
  renderDetail();
  renderPanel();
}

// ------------------------------------------------------------ 詳細
// 並び: 見出し → 大目標 → 目標（達成基準・時期）→ 年度ごとの達成したいこと → 関連基盤技術（目標の達成状況）→ 関連サービス
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
    stat("項目の達成", `${g.goal_done}<small> / ${g.goal_total}</small>`),
    stat("期限超過の項目", `${overdue}<small> 件</small>`, overdue ? "warn" : ""),
    stat(`${state.year ? `${state.year}年度に` : ""}達成したいこと`, `${state.achievements.length}<small> 件</small>`),
  );
  head.append(stats);
  root.append(head);

  // 大目標
  const vs = el("section", "gp-section");
  const vh = el("h3", "", "大目標");
  vh.append(el("span", "hint", "中長期的に目指すこと（Markdown で書けます。「✎ 編集」から変更）"));
  const vbody = el("div", `vision-text${g.vision ? " md" : " hint"}`);
  if (g.vision) vbody.innerHTML = window.mdToHtml(g.vision); // Markdown で書いた大目標を表示用に変換（HTML はエスケープ済み）
  else vbody.textContent = "未記入（「✎ 編集」から入力）";
  vs.append(vh, vbody);
  root.append(vs);

  const goalSec = renderGoals(g);
  const orphans = renderAchievements(g); // タスクに結びついていない達成したいこと（あれば）
  if (orphans) goalSec.append(orphans);
  root.append(goalSec, renderPlatformRelations(g), renderServiceRelations(g));
}

// ---- 目標（達成基準・時期）: クリックで編集
function renderGoals(g) {
  const gs = el("section", "gp-section");
  const gh = el("h3", "", state.year ? `${state.year}年度の目標達成に必要な項目` : "目標達成に必要な項目（すべての年度）");
  gh.append(el("span", "count-badge", `${g.goal_done} / ${g.goal_total} 達成`), el("span", "hint", "大目標を達成するための項目です。クリックすると編集できます"));
  const add = el("button", "primary right", "＋ 項目を追加");
  add.addEventListener("click", () => openGoalPanel("new", { kind: "goal", id: null }));
  gh.append(add);
  gs.append(gh);
  if (!state.goals.length) gs.append(el("p", "hint", `${yearLabel(state.year)}の項目はまだありません。「＋ 項目を追加」から登録してください。`));
  const ul = el("ul", "goal-list");
  for (const t of state.goals) {
    const li = el("li");
    li.tabIndex = 0;
    li.dataset.gid = String(t.id);
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
    // このタスクに関連した達成項目の概要（詳細は、カードをクリックで開く右の窓）
    const mine = state.achAll.filter((x) => x.goal_id === t.id);
    const box = el("div", "t-ach");
    const avg = mine.length ? Math.round(mine.reduce((n, x) => n + x.progress, 0) / mine.length) : 0;
    box.append(el("div", "lbl", mine.length ? `達成項目 ${mine.length} 件・${avg}%` : "達成項目なし"));
    if (mine.length) box.append(progBar(avg));
    li.title = t.note ? `メモ: ${t.note}\n（クリックで詳細）` : "クリックで詳細";
    const d = el("span", `g-due ${due}`, t.due_date ? `期限 ${slashDate(t.due_date)}` : "");
    if (due) d.title = due === "overdue" ? `期限超過（${-daysLeft(t.due_date)} 日経過）` : `期限まであと ${daysLeft(t.due_date)} 日`;
    // 並び替え: 行の左のつまみ（⠿）をドラッグして好きな位置へ
    const handle = dragHandle(true);
    handle.title = "ドラッグして順番を入れ替え";
    enableDragSort(li, handle, {
      group: "goals", id: t.id, ids: () => state.goals.map((x) => x.id),
      onDrop: (ids) => reorderGoals(g, ids),
    });
    li.append(handle, st, main, box, d);
    const openIt = () => { if (state.panelGoal !== t.id) openGoalPanel(t.id); };
    li.classList.toggle("sel", state.panelGoal === t.id);
    li.addEventListener("click", openIt);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); } });
    ul.append(li);
  }
  gs.append(ul);
  return gs;
}

// ---- 達成したいこと（内容・担当者・達成時期）: クリックで編集
function renderAchievements(g) {
  const list = state.achievements.filter((a) => !a.goal_id); // どのタスクにも結びついていないもの
  if (!list.length) return null;
  const sec = el("div", "ach-block");
  const h = el("h4", "", "項目に結びついていない達成したいこと");
  h.append(el("span", "count-badge", `${list.length} 件`), el("span", "hint", "クリックするとその場で編集できます。「関連項目」を選ぶと項目の中に移ります"));
  sec.append(h);
  const ul = el("ul", "ach-list ach-cards"); // 目標達成に必要な項目と同じカード（最大 4 列で折り返し）
  for (const a of list) {
    const li = el("li");
    li.tabIndex = 0;
    li.title = a.note ? `メモ: ${a.note}\n（クリックして編集）` : "クリックして編集";
    const top = el("div", "g-top");
    top.append(el("span", "status-badge", "達成"), el("span", "a-date", `${a.fiscal_year}年度${a.quarter ? ` ${a.quarter}` : ""}`));
    li.append(top);
    const main = el("div", "a-main");
    if (!state.year) main.append(el("span", "fy-tag", `${a.fiscal_year}年度`));
    main.append(el("span", "a-title", a.title));
    if (safeUrl(a.url)) {
      const link = el("a", "g-link", "リンク ↗");
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (e) => e.stopPropagation());
      main.append(link);
    }
    li.append(main);
    li.append(el("div", a.owner ? "a-owner" : "a-owner none", a.owner ? `担当 ${a.owner.split(" ").join("・")}` : "担当未設定"));
    if (a.note) li.append(el("div", "a-note", a.note.replace(/\s*\n\s*/g, "　").trim()));
    if (state.orphanEdit === a.id) {
      // その場で編集（カードの位置に入力欄を出す）
      li.classList.add("editing");
      li.tabIndex = -1;
      li.title = "";
      li.innerHTML = "";
      const done = () => { state.orphanEdit = null; };
      li.append(achForm(g, a, 0, {
        key: `orphan:${a.id}`,
        onCancel: () => { if (confirmDiscard([`orphan:${a.id}`])) { done(); renderDetail(); } },
        onSaved: done,
      }));
      ul.append(li);
      continue;
    }
    const openIt = () => {
      const prev = state.orphanEdit ? [`orphan:${state.orphanEdit}`] : [];
      if (!confirmDiscard(prev)) return;
      state.orphanEdit = a.id;
      renderDetail();
    };
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
  h.append(el("span", "hint", "目標の達成状況（基盤名をクリックで基盤技術の画面へ。「✎ 編集」から変更）"));
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
    // 同じタブで基盤技術へ移り、基盤技術の「← グループに戻る」で同じグループに戻る
    a.href = `/platforms?id=${encodeURIComponent(no)}&from=groups&group=${g.id}&year=${state.year || "all"}`;
    a.append(el("b", "", no), pf.title || "（基盤名未設定）", el("span", "arrow", "→"));
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


// ---- 項目の詳細（右の窓）: 項目の内容・達成したいこと（バー = 達成度。％で色が変わる）・定期的な議論の記録。
// 編集はポップアップを開かず、窓の中でその場に書く（state.panelEdit = 編集中のもの { kind: "goal" | "ach" | "note", id }）
state.panelGoal = null; // 開いている項目の id（"new" = 項目の追加）
state.openAch = null;
state.panelEdit = null;
state.goalNotes = [];
state.orphanEdit = null; // 項目に結びついていない達成したいことで、その場で編集中のもの（id）
const progClass = (p) => (p >= 100 ? "p3" : p >= 70 ? "p2" : p >= 30 ? "p1" : "p0");
function progBar(p) {
  const bar = el("div", `prog ${progClass(p)}`);
  const fill = el("i");
  fill.style.width = `${p}%`;
  bar.append(fill);
  return bar;
}
function openGoalPanel(id, edit = null) {
  if (state.panelGoal !== id && !confirmDiscard(panelKeys())) return;
  state.panelGoal = id;
  state.openAch = null;
  state.panelEdit = edit;
  renderPanel();
  renderGoalsMark();
}
// 窓の中の書きかけ（項目に結びついていない達成したいことの書きかけは除く）
const panelKeys = () => [...panelDrafts.keys()].filter((k) => !k.startsWith("orphan:"));
function setPanelEdit(next) {
  if (!confirmDiscard(state.panelEdit ? [editKey(state.panelEdit)] : [])) return;
  state.panelEdit = next;
  renderPanel();
}
function renderGoalsMark() {
  document.querySelectorAll(".goal-list li").forEach((li) => li.classList.toggle("sel", li.dataset.gid === String(state.panelGoal)));
}
function closeGoalPanel() { openGoalPanel(null); }
const quarterOptions = [["", "（未設定）"], ["Q1", "Q1（4〜6月）"], ["Q2", "Q2（7〜9月）"], ["Q3", "Q3（10〜12月）"], ["Q4", "Q4（1〜3月）"]];

// 項目（目標）の入力欄。t = null なら追加
function goalForm(g, t) {
  const key = editKey({ kind: "goal", id: t?.id });
  const form = el("form", "gpn-form");
  form.autocomplete = "off";
  const status = panelInput("status", { tag: "select" });
  for (const s of state.statuses) status.append(new Option(s, s));
  const fy = panelInput("fiscal_year", { tag: "select", required: true });
  yearOptions(fy, t?.fiscal_year || state.year || state.currentYear);
  const title = panelInput("title", { required: true, placeholder: "例: 英語版レポートの標準化" });
  const g1 = el("div", "gpn-grid");
  g1.append(panelField("状態", status), panelField("期限", panelInput("due_date", { type: "date" })));
  const g2 = el("div", "gpn-grid");
  g2.append(panelField("年度 *", fy), panelField("時期", panelInput("period", { placeholder: "例: 下期、9 月末まで" })));
  form.append(g1, panelField("項目 *", title),
    panelField("達成基準", panelInput("criteria", { tag: "textarea", rows: 2, placeholder: "例: 全案件で英語版レポートを納品" })), g2,
    panelField("メモ", panelInput("note", { tag: "textarea", rows: 3, placeholder: "補足など" })),
    panelField("リンク", panelInput("url", { type: "url", placeholder: "https://" })));
  const cancel = () => (t ? setPanelEdit(null) : closeGoalPanel());
  const err = panelActions(form, {
    submitLabel: t ? "保存" : "追加", onCancel: cancel,
    onDelete: t && (() => openDelete("項目", `項目: ${t.title}`, `/api/groups/${g.id}/goals/${t.id}`, () => reload(g.id))),
  });
  bindPanelForm(form, key, { status: t ? t.status : "未着手", title: t?.title, due_date: t?.due_date, criteria: t?.criteria,
    period: t?.period, note: t?.note, url: t?.url, fiscal_year: String(t?.fiscal_year || fy.value) }, cancel);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (n) => form.elements.namedItem(n).value;
    const body = { title: v("title").trim(), criteria: v("criteria"), period: v("period").trim(), status: v("status"),
      due_date: v("due_date") || null, note: v("note"), url: v("url").trim(), fiscal_year: Number(v("fiscal_year")) };
    if (!body.title) { err.textContent = "項目を入力してください"; return; }
    if (body.url && !safeUrl(body.url)) { err.textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
    try {
      const saved = await api(t ? `/api/groups/${g.id}/goals/${t.id}` : `/api/groups/${g.id}/goals`,
        { method: t ? "PUT" : "POST", body: JSON.stringify(body) });
      panelDrafts.delete(key);
      state.panelGoal = saved.id;
      state.panelEdit = null;
      await reload(g.id);
      toast(t ? "保存しました" : "追加しました");
    } catch (ex) { err.textContent = ex.message; }
  });
  focusLater(t ? status : title);
  return form;
}

// 達成したいことの入力欄。a = null なら追加（goalId の項目に結びつける）。onDone / key は項目に結びついていない一覧で使う
function achForm(g, a, goalId, { key = editKey({ kind: "ach", id: a?.id }), onCancel = () => setPanelEdit(null), onSaved = null } = {}) {
  const form = el("form", "gpn-form");
  form.autocomplete = "off";
  const title = panelInput("title", { required: true, placeholder: "例: 新サービスをリリース" });
  const range = panelInput("progress", { type: "range", min: 0, max: 100, step: 5 });
  const pc = el("b");
  const rl = panelField("達成度 ", range);
  rl.firstChild.append(pc);
  range.addEventListener("input", () => { pc.textContent = `${range.value}%`; });
  const quarter = panelInput("quarter", { tag: "select" });
  for (const [v, l] of quarterOptions) quarter.append(new Option(l, v));
  const fy = panelInput("fiscal_year", { tag: "select", required: true });
  yearOptions(fy, a?.fiscal_year || state.year || state.currentYear);
  const goalSel = panelInput("goal_id", { tag: "select" });
  goalSel.append(new Option("（なし）", "0"));
  for (const t of state.goalsAll || state.goals) goalSel.append(new Option(`${t.fiscal_year}年度 ${t.title}`, String(t.id)));
  const g1 = el("div", "gpn-grid");
  g1.append(panelField("担当者（複数はスペース区切り）", panelInput("owner", { placeholder: "例: 高橋 鈴木" })),
    panelField("達成時期（年度の四半期）", quarter));
  const g2 = el("div", "gpn-grid");
  g2.append(panelField("年度 *", fy), panelField("関連項目", goalSel));
  form.append(panelField("達成したいこと *", title), rl, g1, g2,
    panelField("メモ", panelInput("note", { tag: "textarea", rows: 3, placeholder: "成果の詳細など" })),
    panelField("リンク（報告資料など）", panelInput("url", { type: "url", placeholder: "https://" })));
  const err = panelActions(form, {
    submitLabel: a ? "保存" : "追加", onCancel,
    onDelete: a && (() => openDelete("記録", `達成したいこと: ${a.title}`, `/api/groups/${g.id}/achievements/${a.id}`, () => reload(g.id))),
  });
  bindPanelForm(form, key, { title: a?.title, progress: a ? a.progress : 0, owner: a?.owner, quarter: a?.quarter || "",
    fiscal_year: String(a?.fiscal_year || fy.value), goal_id: String(a ? a.goal_id || 0 : goalId), note: a?.note, url: a?.url }, onCancel);
  pc.textContent = `${range.value}%`;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (n) => form.elements.namedItem(n).value;
    const body = { title: v("title").trim(), owner: v("owner").trim(), quarter: v("quarter"), note: v("note"), url: v("url").trim(),
      fiscal_year: Number(v("fiscal_year")), goal_id: Number(v("goal_id")), progress: Number(v("progress")) };
    if (!body.title) { err.textContent = "達成したいことを入力してください"; return; }
    if (body.url && !safeUrl(body.url)) { err.textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
    try {
      const saved = await api(a ? `/api/groups/${g.id}/achievements/${a.id}` : `/api/groups/${g.id}/achievements`,
        { method: a ? "PUT" : "POST", body: JSON.stringify(body) });
      panelDrafts.delete(key);
      if (onSaved) onSaved(saved);
      else { state.panelEdit = null; state.openAch = saved.id; }
      await reload(g.id);
      toast(a ? "保存しました" : "追加しました");
    } catch (ex) { err.textContent = ex.message; }
  });
  focusLater(title);
  return form;
}

// 議論の記録の入力欄。n = null なら新規（いつも表示しておく）
function goalNoteForm(g, t, n) {
  const key = n ? editKey({ kind: "note", id: n.id }) : `newnote:${t.id}`;
  const form = el("form", "gpn-form gpn-note-form");
  form.autocomplete = "off";
  const date = panelInput("note_date", { type: "date", required: true });
  const body = panelInput("body", { tag: "textarea", rows: n ? 4 : 3, placeholder: "議論の内容・決定事項・宿題（担当者・期限）など" });
  form.append(panelField("日付", date, "gpn-date"), body);
  const cancel = n ? () => setPanelEdit(null) : null;
  const err = panelActions(form, {
    submitLabel: n ? "保存" : "記録を追加", onCancel: cancel,
    onDelete: n && (() => openDelete("議論の記録", `${slashDate(n.note_date)} の記録`, `/api/groups/${g.id}/goal-notes/${n.id}`, () => reload(g.id))),
  });
  const today = new Date(todayMs()).toISOString().slice(0, 10);
  bindPanelForm(form, key, { note_date: n ? n.note_date : today, body: n?.body }, cancel);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { note_date: date.value, body: body.value.trim() };
    if (!data.note_date) { err.textContent = "日付を入力してください"; return; }
    if (!data.body) { err.textContent = "内容を入力してください"; return; }
    try {
      await api(n ? `/api/groups/${g.id}/goal-notes/${n.id}` : `/api/groups/${g.id}/goals/${t.id}/notes`,
        { method: n ? "PUT" : "POST", body: JSON.stringify(data) });
      panelDrafts.delete(key);
      if (n) state.panelEdit = null;
      await reload(g.id);
      toast(n ? "記録を保存しました" : "記録を追加しました");
    } catch (ex) { err.textContent = ex.message; }
  });
  if (n) focusLater(body);
  return form;
}

function renderPanel() {
  const panel = $("#goal-panel");
  const box = $("#goal-panel-body");
  const g = state.groups.find((x) => x.id === state.current);
  const isNew = state.panelGoal === "new";
  const t = !isNew && state.panelGoal && (state.goalsAll || []).find((x) => x.id === state.panelGoal);
  panel.hidden = !g || (!t && !isNew);
  if (panel.hidden) {
    state.panelEdit = null;
    panelKeys().forEach((k) => panelDrafts.delete(k));
    return;
  }
  const ed = state.panelEdit;
  // 編集中のものが消えていたら（削除など）編集をやめる
  if ((ed?.kind === "ach" && ed.id && !state.achAll.some((x) => x.id === ed.id)) ||
      (ed?.kind === "note" && ed.id && !state.goalNotes.some((x) => x.id === ed.id))) {
    panelDrafts.delete(editKey(ed));
    state.panelEdit = null;
  }
  const editing = (kind, id) => state.panelEdit?.kind === kind && (state.panelEdit.id ?? null) === (id ?? null);
  const scroll = box.scrollTop;
  box.innerHTML = "";

  const head = el("div", "gpn-head");
  if (t) {
    const st = el("span", "status-badge", t.status);
    st.dataset.v = t.status;
    head.append(st, el("span", "gpn-fy", `${t.fiscal_year}年度`));
  } else head.append(el("b", "", "項目の追加"));
  const close = el("button", "gpn-close", "✕");
  close.type = "button";
  close.title = "閉じる";
  close.addEventListener("click", closeGoalPanel);
  head.append(el("span", "spacer"), close);
  box.append(head);

  if (!t) {
    box.append(el("p", "hint", g.name), goalForm(g, null));
    box.scrollTop = 0;
    return;
  }

  if (editing("goal", t.id)) {
    box.append(el("p", "hint", `最終更新 ${t.updated_at.slice(0, 16)}`), goalForm(g, t));
  } else {
    const due = goalDue(t);
    const facts = el("dl", "gpn-facts");
    const fact = (k, v, cls = "") => { if (v) facts.append(el("dt", "", k), el("dd", cls, v)); };
    fact("期限", t.due_date ? `${slashDate(t.due_date)}${due === "overdue" ? `（${-daysLeft(t.due_date)} 日超過）` : t.status !== "達成" ? `（あと ${daysLeft(t.due_date)} 日）` : ""}` : "", due);
    fact("達成基準", t.criteria, "pre");
    fact("時期", t.period);
    fact("メモ", t.note, "pre");
    box.append(el("h3", "gpn-title", t.title), facts);
    if (safeUrl(t.url)) {
      const a = el("a", "g-link", "リンク ↗");
      a.href = t.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.append(a, " ");
    }
    const edit = el("button", "gpn-edit", "✎ 項目を編集");
    edit.type = "button";
    edit.addEventListener("click", () => setPanelEdit({ kind: "goal", id: t.id }));
    box.append(edit);
  }

  // 達成したいこと（バー）
  const mine = state.achAll.filter((x) => x.goal_id === t.id);
  const avg = mine.length ? Math.round(mine.reduce((n, x) => n + x.progress, 0) / mine.length) : 0;
  const ah = el("div", "gpn-ah");
  ah.append(el("b", "", "達成したいこと"), el("span", "count-badge", `${mine.length} 件${mine.length ? `・平均 ${avg}%` : ""}`), el("span", "spacer"));
  const add = el("button", "primary", "＋ 達成項目を追加");
  add.type = "button";
  add.disabled = editing("ach", null);
  add.addEventListener("click", () => setPanelEdit({ kind: "ach", id: null }));
  ah.append(add);
  box.append(ah);
  if (editing("ach", null)) box.append(achForm(g, null, t.id));
  if (mine.length) {
    const legend = el("div", "gpn-legend");
    legend.innerHTML = '<span class="p0"><i></i>〜29%</span><span class="p1"><i></i>30〜69%</span><span class="p2"><i></i>70〜99%</span><span class="p3"><i></i>100%</span>';
    box.append(legend);
  } else if (!editing("ach", null)) {
    box.append(el("p", "hint", "まだ達成項目がありません。「＋ 達成項目を追加」から登録してください。"));
  }
  for (const x of mine) {
    const item = el("div", "gpn-ach");
    if (editing("ach", x.id)) {
      item.append(achForm(g, x, t.id));
      box.append(item);
      continue;
    }
    const row = el("button", `gpn-bar ${progClass(x.progress)}`);
    row.type = "button";
    row.title = "クリックで詳細";
    const lab = el("span", "lab");
    lab.append(el("span", "nm", x.title), el("span", "pc", `${x.progress}%`));
    row.append(lab, progBar(x.progress));
    row.addEventListener("click", () => { state.openAch = state.openAch === x.id ? null : x.id; renderPanel(); });
    item.append(row);
    if (state.openAch === x.id) {
      const d = el("div", "gpn-ach-detail");
      const dl = el("dl", "gpn-facts");
      const f2 = (k, v, cls = "") => { if (v) dl.append(el("dt", "", k), el("dd", cls, v)); };
      f2("達成度", `${x.progress}%`);
      f2("担当者", x.owner ? x.owner.split(" ").join("・") : "");
      f2("達成時期", `${x.fiscal_year}年度${x.quarter ? ` ${x.quarter}` : "（四半期は未設定）"}`);
      f2("年度", `${x.fiscal_year}年度`);
      f2("メモ", x.note, "pre");
      d.append(dl);
      if (safeUrl(x.url)) {
        const a = el("a", "g-link", "リンク ↗");
        a.href = x.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        d.append(a, " ");
      }
      const eb = el("button", "", "✎ 編集");
      eb.type = "button";
      eb.addEventListener("click", () => setPanelEdit({ kind: "ach", id: x.id }));
      d.append(eb);
      item.append(d);
    }
    box.append(item);
  }

  // 定期的な議論の記録（新しい日付が上）
  const notes = state.goalNotes.filter((n) => n.goal_id === t.id);
  const nh = el("div", "gpn-ah");
  nh.append(el("b", "", "議論の記録"), el("span", "count-badge", `${notes.length} 件`), el("span", "spacer"),
    el("span", "hint", "定期的な議論の内容・決定事項・宿題"));
  box.append(nh, goalNoteForm(g, t, null));
  const ol = el("ol", "gpn-notes");
  for (const n of notes) {
    const li = el("li");
    if (editing("note", n.id)) {
      li.append(goalNoteForm(g, t, n));
    } else {
      const lh = el("div", "lh");
      lh.append(el("b", "", slashDate(n.note_date)), el("span", "upd", `更新 ${n.updated_at.slice(0, 16)}`));
      const eb = el("button", "", "編集");
      eb.type = "button";
      eb.addEventListener("click", () => setPanelEdit({ kind: "note", id: n.id }));
      lh.append(eb);
      li.append(lh, el("div", "lb", n.body));
    }
    ol.append(li);
  }
  if (notes.length) box.append(ol);
  box.scrollTop = scroll;
}
// 窓の幅: 左端をドラッグして変えられる
enablePanelResize($("#goal-panel"), $("#goal-panel-resize"), "groups.panelWidth");


async function reorderGoals(g, ids) {
  try {
    await api(`/api/groups/${g.id}/goals/reorder`, { method: "POST", body: JSON.stringify({ ids }) });
    await select(g.id);
  } catch (err) {
    toast(err.message, true);
    await select(g.id);
  }
}

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
    li.append(el("span", "use", used ? `目標 ${y.goals} 件・達成したいこと ${y.achievements} 件` : "未使用"), el("span", "spacer"));
    const del = el("button", "danger-outline", "削除");
    del.type = "button";
    del.disabled = used > 0;
    del.title = used ? "目標・達成したいことが登録されている年度は削除できません" : "この年度を選択肢から外す";
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

// 書きかけがあるときはページを離れる前に確認
window.addEventListener("beforeunload", (e) => {
  if (panelDirty()) { e.preventDefault(); e.returnValue = ""; }
});
