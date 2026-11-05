"use strict";

// 基盤技術: 領域ごとに基盤を管理。基盤ごとに全体目標・目標・ディスカッション・月報・関連タスク
const DAY_MS = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
};

const state = {
  platforms: [],
  areas: [],
  statuses: [],
  tasks: [],
  services: [], // 関連サービスの表示用
  filterArea: "",
  filterPerson: "", // PL またはメンバーで絞り込み
  current: null, // 選択中の基盤番号
  goals: [],
  goalGantt: [], // 項目の月単位ガント（1 年 = 12 か月 × 4 分割）
  ganttAnchor: null, // ガントの左端の日付（ms。スクロール位置の記憶。null = 今日の少し前）
  openGantt: null, // 詳細を開いているガントの行 id
  ganttDraft: null, // いちばん下の枠で引いた（またはクリックした）期間 { start, end }（ms。追加のフォームの初期値）
  panelEdit: null, // 右の窓の中で編集中のもの { kind: "goal" | "gantt", id }（id = null は追加）
  panelGoal: null, // 右の詳細の窓で開いている項目の id
  openTask: null,
  topics: [],
  monthly: [],
  tab: store.get("platforms.tab") || "topics",
  dirty: false, // 基本情報・全体目標の未保存の変更
  editing: false, // 編集モード（修正は「編集する」を押したときだけ）
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
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayMs = () => {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
};
const daysLeft = (s) => Math.round((parseDate(s) - todayMs()) / DAY_MS);
const thisMonth = () => fmtDate(todayMs()).slice(0, 7);
const monthLabel = (m) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;
const slashDate = (s) => s.replaceAll("-", "/");
const areaColor = (a) => {
  if (!a) return "#a9adb6";
  let i = state.areas.indexOf(a);
  if (i < 0) i = state.areas.length;
  return `hsl(${(210 + i * 67) % 360} 62% 50%)`;
};
const enc = encodeURIComponent;
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

// リンクのボタン（URL があれば押せる、なければグレー）
function linkButton(label, url, title) {
  const u = safeUrl(url);
  if (u) {
    const a = el("a", "pf-link on", `${label} ↗`);
    a.href = u;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `${title}を開く: ${u}`;
    a.addEventListener("click", (e) => e.stopPropagation());
    return a;
  }
  const s = el("span", "pf-link", label);
  s.title = `${title}: 未設定（「編集する」から登録）`;
  return s;
}

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

// 目標の期限状態（達成・保留は対象外）
function goalDue(g) {
  if (!g.due_date || g.status === "達成" || g.status === "保留") return "";
  const left = daysLeft(g.due_date);
  if (left < 0) return "overdue";
  if (left <= 14) return "soon";
  return "";
}

// ------------------------------------------------------------ 一覧（領域ごと。各基盤は 1 回だけ表示）
const people = (p) => (p.members ? p.members.split(" ") : []);
// PL とメンバーを併記した文字列
const teamText = (p) => {
  const parts = [];
  if (p.owner) parts.push(`PL ${p.owner}`);
  if (p.members) parts.push(`メンバー ${people(p).join("・")}`);
  return parts.join(" ／ ");
};

// メンバーでの絞り込み: PL またはメンバーに含まれる基盤
const matchesPerson = (p) => !state.filterPerson || p.owner === state.filterPerson || people(p).includes(state.filterPerson);

function refreshPersonFilter() {
  const sel = $("#f-person");
  const names = [...new Set(state.platforms.flatMap((p) => [p.owner, ...people(p)]).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ja"));
  if (state.filterPerson && !names.includes(state.filterPerson)) state.filterPerson = "";
  sel.innerHTML = "";
  sel.append(new Option("すべて", ""));
  for (const n of names) sel.append(new Option(n, n));
  sel.value = state.filterPerson;
}

// 基盤一覧の並び: 最初は手で決めた順番（↑↓ で入れ替え）。見出しをクリックでその列、もう一度で逆順（ブラウザに記憶）
const PF_COLS = [
  ["order", "順番", (p) => p.sort_order || 99999],
  ["name", "基盤番号", (p) => p.name],
  ["title", "基盤名", (p) => p.title],
  ["areas", "領域", (p) => p.areas[0] ? String(state.areas.indexOf(p.areas[0])).padStart(3, "0") + p.areas.join(" ") : ""],
  ["owner", "PL", (p) => p.owner],
  ["members", "メンバー", (p) => p.members],
  ["task_count", "タスク", (p) => p.task_count],
  ["last_topic_date", "最新ディスカッション", (p) => p.last_topic_date],
  ["last_month", "最新の月報", (p) => p.last_month],
];
// 一覧の列幅: 見出しの右端をドラッグで変更（ブラウザに記憶。ダブルクリックで元の幅）
const PF_W_DEFAULT = { order: 64, name: 110, title: 260, areas: 200, owner: 90, members: 180, task_count: 70,
  last_topic_date: 150, last_month: 110 };
const pfW = (() => {
  try { return { ...PF_W_DEFAULT, ...JSON.parse(localStorage.getItem("platforms.colW") || "{}") }; }
  catch (_) { return { ...PF_W_DEFAULT }; }
})();
const savePfW = () => { try { localStorage.setItem("platforms.colW", JSON.stringify(pfW)); } catch (_) { /* 記憶できなくても幅は変わる */ } };
const pfTableW = () => PF_COLS.reduce((n, [k]) => n + pfW[k], 0);
function startPfResize(e, key, col, table) {
  e.preventDefault();
  e.stopPropagation(); // 並び替えにしない
  const handle = e.currentTarget;
  const x0 = e.clientX;
  const w0 = pfW[key];
  handle.setPointerCapture(e.pointerId);
  handle.classList.add("active");
  document.body.classList.add("resizing");
  const move = (ev) => {
    pfW[key] = Math.min(800, Math.max(40, Math.round(w0 + ev.clientX - x0)));
    col.style.width = `${pfW[key]}px`;
    table.style.width = `${pfTableW()}px`;
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    handle.classList.remove("active");
    document.body.classList.remove("resizing");
    savePfW();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}
const pfSort = (() => {
  try { return JSON.parse(localStorage.getItem("platforms.sort2")) || { key: "order", desc: false }; }
  catch (_) { return { key: "order", desc: false }; }
})();
function sortPlatforms(list) {
  const col = PF_COLS.find(([k]) => k === pfSort.key) || PF_COLS[0];
  const get = col[2];
  const empty = (v) => v === null || v === undefined || v === "";
  return list.sort((a, b) => {
    const va = get(a), vb = get(b);
    if (empty(va) !== empty(vb)) return empty(va) ? 1 : -1; // 空欄は常に最後
    const c = typeof va === "number" && typeof vb === "number" ? va - vb
      : String(va ?? "").localeCompare(String(vb ?? ""), "ja", { numeric: true });
    return (pfSort.desc ? -c : c) || a.name.localeCompare(b.name, "ja", { numeric: true });
  });
}

// ドラッグ＆ドロップで順番を入れ替え（つまみを押したときだけ行をドラッグ可能にする）
let dragName = null;
function setupRowDrag(tr, p, handle) {
  handle.addEventListener("mousedown", () => { tr.draggable = true; });
  handle.addEventListener("click", (e) => e.stopPropagation());
  tr.addEventListener("dragstart", (e) => {
    dragName = p.name;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", p.name);
    tr.classList.add("dragging");
  });
  tr.addEventListener("dragend", () => {
    tr.draggable = false;
    dragName = null;
    tr.classList.remove("dragging");
    document.querySelectorAll("#pf-table tr.drop-before, #pf-table tr.drop-after")
      .forEach((x) => x.classList.remove("drop-before", "drop-after"));
  });
  tr.addEventListener("dragover", (e) => {
    if (!dragName || dragName === p.name) return;
    e.preventDefault();
    const r = tr.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    tr.classList.toggle("drop-after", after);
    tr.classList.toggle("drop-before", !after);
  });
  tr.addEventListener("dragleave", () => tr.classList.remove("drop-before", "drop-after"));
  tr.addEventListener("drop", async (e) => {
    e.preventDefault();
    const from = dragName;
    const after = tr.classList.contains("drop-after");
    tr.classList.remove("drop-before", "drop-after");
    if (!from || from === p.name) return;
    // 手動の順番（全基盤）で並べ直してから、置いた位置に入れる
    const names = sortByOrder(state.platforms).map((x) => x.name).filter((n) => n !== from);
    names.splice(names.indexOf(p.name) + (after ? 1 : 0), 0, from);
    try {
      state.platforms = await api("/api/platforms/reorder", { method: "POST", body: JSON.stringify({ names }) });
      renderList();
      toast(`${from} を移動しました`);
    } catch (err) {
      toast(err.message, true);
    }
  });
}
const sortByOrder = (list) => [...list].sort((a, b) => (a.sort_order || 99999) - (b.sort_order || 99999) || a.name.localeCompare(b.name, "ja", { numeric: true }));

// 基盤一覧（表）: 1 基盤 1 行。行をクリックすると詳細を表示
function renderList() {
  refreshPersonFilter();
  const box = $("#pf-table");
  box.innerHTML = "";
  if (!state.platforms.length) {
    box.append(el("p", "hint pf-empty", "基盤番号が登録されていません。管理サイトで登録してください。"));
    $("#pf-count").textContent = "";
    return;
  }
  const list = sortPlatforms(state.platforms
    .filter((p) => (!state.filterArea || p.areas.includes(state.filterArea)) && matchesPerson(p)));
  $("#pf-count").textContent = `${list.length} 件${list.length !== state.platforms.length ? `（全 ${state.platforms.length} 件）` : ""}`;
  if (!list.length) {
    box.append(el("p", "hint pf-empty", "条件に合う基盤はありません。"));
    return;
  }
  const table = el("table", "pf-table resizable-cols");
  table.style.width = `${pfTableW()}px`;
  const colgroup = el("colgroup");
  const cols = {};
  for (const [key] of PF_COLS) {
    const col = el("col");
    col.style.width = `${pfW[key]}px`;
    cols[key] = col;
    colgroup.append(col);
  }
  table.append(colgroup);
  const thead = el("thead");
  const hr = el("tr");
  for (const [key, label] of PF_COLS) {
    const th = el("th", `sortable${pfSort.key === key ? " sorted" : ""}`);
    th.append(label, el("span", "sort-mark", pfSort.key === key ? (pfSort.desc ? " ▼" : " ▲") : ""));
    th.title = key === "order" ? "手で決めた順番で並べる（↑↓ で入れ替え）" : "クリックで並び替え（もう一度で逆順）";
    th.addEventListener("click", () => {
      // 日付・件数は最初に押したとき新しい順・多い順
      const firstDesc = ["task_count", "last_topic_date", "last_month"].includes(key);
      if (key === "order") { pfSort.key = "order"; pfSort.desc = false; } // 手動の順番は常に上から
      else if (pfSort.key === key) pfSort.desc = !pfSort.desc;
      else { pfSort.key = key; pfSort.desc = firstDesc; }
      try { localStorage.setItem("platforms.sort2", JSON.stringify(pfSort)); } catch (_) { /* 保存できなくても並び替えは行う */ }
      renderList();
    });
    const handle = el("span", "col-resizer");
    handle.title = "ドラッグで列幅を変更（ダブルクリックで元の幅）";
    handle.addEventListener("pointerdown", (e) => startPfResize(e, key, cols[key], table));
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      pfW[key] = PF_W_DEFAULT[key];
      cols[key].style.width = `${pfW[key]}px`;
      table.style.width = `${pfTableW()}px`;
      savePfW();
    });
    th.append(handle);
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el("tbody");
  for (const p of list) {
    const tr = el("tr");
    tr.tabIndex = 0;
    tr.title = "クリックして詳細を表示";
    tr.style.setProperty("--c", areaColor(p.areas[0] || ""));
    const td = (content, cls = "") => {
      const c = el("td", cls);
      if (content instanceof Node) c.append(content);
      else c.textContent = content ?? "";
      tr.append(c);
      return c;
    };
    // 順番: 行のつまみ（⠿）をドラッグして好きな位置へ（手動の順番で、絞り込みなしのときだけ）
    const canMove = pfSort.key === "order" && !state.filterArea && !state.filterPerson;
    const mv = el("span", `drag-handle${canMove ? "" : " off"}`, "⠿");
    mv.title = canMove ? "ドラッグして順番を入れ替え" : "「順番」で並べ、絞り込みを解除するとドラッグで入れ替えられます";
    if (canMove) setupRowDrag(tr, p, mv);
    tr.dataset.name = p.name;
    td(mv, "order");
    td(p.name, "no");
    td(p.title || "（基盤名未設定）", `ttl${p.title ? "" : " untitled"}`);
    td(areaTags(p.areas), "areas");
    td(p.owner || "—", p.owner ? "" : "none");
    td(people(p).join("・") || "—", p.members ? "members" : "none");
    td(String(p.task_count), "num");
    td(p.last_topic_date ? slashDate(p.last_topic_date) : "—", p.last_topic_date ? "nowrap" : "none");
    td(p.last_month ? p.last_month.replace("-", "/") : "—", p.last_month ? "nowrap" : "none");
    const open = () => select(p.name);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  box.append(table);
}

// 一覧と詳細の切り替え
function showView(detail) {
  $("#list-view").hidden = detail;
  $("#detail-view").hidden = !detail;
}

function backToList(push = true) {
  if (state.editing && state.dirty && !confirm("編集中の変更が保存されていません。破棄して一覧に戻りますか？")) return false;
  if (!confirmDiscard()) return false;
  state.editing = false;
  state.dirty = false;
  state.current = null;
  state.panelGoal = null;
  state.panelEdit = null;
  $("#goal-panel").hidden = true;
  if (push) history.pushState(null, "", "/platforms");
  renderList();
  showView(false);
  return true;
}

async function select(name) {
  if (state.editing && state.current !== name) {
    if (state.dirty && !confirm("編集中の変更が保存されていません。破棄して切り替えますか？")) return;
    state.editing = false;
  }
  const fromList = state.current !== name;
  if (fromList && !confirmDiscard()) return;
  state.current = name;
  state.dirty = false;
  const url = `/platforms?id=${enc(name)}${backGroup ? `&from=groups&group=${backGroup.id}&year=${backGroup.year}` : ""}`;
  if (fromList && location.pathname + location.search !== url) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  const base = `/api/platforms/${enc(name)}`;
  if (fromList) { state.panelGoal = null; state.openTask = null; state.panelEdit = null; panelDrafts.clear(); }
  [state.goals, state.goalGantt, state.topics, state.monthly] = await Promise.all(
    [api(`${base}/goals`), api(`${base}/goal-gantt`), api(`${base}/topics`), api(`${base}/monthly`)]);
  renderList();
  renderDetail();
  const p = state.platforms.find((x) => x.name === name);
  $("#back-name").textContent = p ? `${p.name}　${p.title || ""}` : name;
  showView(true);
  $("#detail").scrollTop = 0;
}

$("#btn-back").addEventListener("click", () => backToList());
// グループ画面から来たとき: 同じタブで元のグループに戻れる（?from=groups&group=ID&year=年度）
const backGroup = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get("from") !== "groups" || !q.get("group")) return null;
  return { id: q.get("group"), year: q.get("year") || "all" };
})();
if (backGroup) {
  const a = el("a", "button back-group", "← グループに戻る");
  a.href = `/groups?id=${backGroup.id}&year=${backGroup.year}`;
  a.title = "グループ画面の元のグループに戻る（同じタブのまま）";
  $("#btn-back").after(a);
}
// 個々の基盤へのリンク（/platforms?id=基盤番号）をコピー
$("#btn-copy-link").addEventListener("click", async () => {
  if (!state.current) return;
  const url = `${location.origin}/platforms?id=${enc(state.current)}`;
  if (await copyText(url)) toast(`リンクをコピーしました: ${url}`, false);
});
// ブラウザの「戻る」「進む」
window.addEventListener("popstate", async () => {
  const id = new URLSearchParams(location.search).get("id");
  if (id && state.platforms.some((p) => p.name === id)) await select(id);
  else if (!backToList(false)) history.pushState(null, "", `/platforms?id=${enc(state.current)}`);
});

// ---- 編集モード: 修正は「編集する」を押したときだけ可能
function setEditing(on) {
  if (!on && state.dirty && !confirm("保存していない変更があります。破棄して編集を終了しますか？")) return;
  state.editing = on;
  state.dirty = false;
  renderDetail();
}

// ------------------------------------------------------------ 詳細
function areaTags(areas) {
  const box = el("span", "area-tags");
  for (const a of areas) {
    const tag = el("span", "area-tag", a);
    tag.style.setProperty("--c", areaColor(a));
    box.append(tag);
  }
  return box;
}

function renderDetail() {
  const p = state.platforms.find((x) => x.name === state.current);
  const root = $("#detail");
  root.innerHTML = "";
  root.classList.toggle("editing", state.editing);
  if (!p) {
    root.append(el("p", "hint pf-empty", "左の一覧から基盤を選択してください。"));
    return;
  }
  // 完了したタスクは一番下（ガントチャートと同じ）
  const tasks = state.tasks.filter((t) => t.project === p.name)
    .sort((a, b) => !!a.completed_at - !!b.completed_at || a.end_date.localeCompare(b.end_date));

  // 編集モードのバー
  const modeBar = el("div", `mode-bar ${state.editing ? "on" : ""}`);
  if (state.editing) {
    modeBar.append(el("span", "", "編集モード：基本情報（基盤名・領域・PL・メンバー）と全体目標を修正し、「保存」で確定します。"));
    const save = el("button", "primary", "基本情報・全体目標を保存");
    save.id = "btn-save";
    const done = el("button", "", "編集を終了");
    done.addEventListener("click", () => setEditing(false));
    const btns = el("span", "btns");
    btns.append(done, save);
    modeBar.append(btns);
  }
  if (state.editing) root.append(modeBar);

  // 見出し・サマリー
  const head = el("div", "pf-head");
  const titleBox = el("div", "title-box");
  const no = el("div", "no", `基盤番号 ${p.name}`);
  no.append(areaTags(p.areas));
  titleBox.append(no);
  if (state.editing) {
    const titleInput = el("input", "title-input");
    titleInput.name = "title";
    titleInput.value = p.title;
    titleInput.placeholder = "基盤名を入力";
    titleBox.append(titleInput);
  } else {
    titleBox.append(el("h2", `title-text${p.title ? "" : " untitled"}`, p.title || "（基盤名未設定）"));
  }
  const team = el("div", "team-line");
  if (p.owner) team.append(el("span", "role", "PL"), el("b", "", p.owner));
  if (p.members) team.append(el("span", "role", "メンバー"), el("span", "", people(p).join("・")));
  if (!p.owner && !p.members) team.append(el("span", "hint", "PL・メンバー未設定"));
  // 研究計画・BOX・Teams のリンクはメンバーの隣に並べる
  const links = el("span", "pf-links");
  links.append(el("span", "role", "リンク"), linkButton("研究計画", p.plan_url, "研究計画"),
    linkButton("BOX", p.box_url, "BOX"), linkButton("Teams", p.teams_url, "Teams"));
  // 自由リンク（任意）: 登録されているときだけ表示
  for (const l of p.links || []) {
    if (safeUrl(l.url)) links.append(linkButton(l.label || "リンク", l.url, l.label || "自由リンク"));
  }
  team.append(links);
  titleBox.append(team);
  // この基盤に関連するサービス（サービス画面へのリンク）
  const related = state.services.filter((s) => s.platforms.includes(p.name));
  if (related.length) {
    const rel = el("div", "pf-services");
    rel.append(el("span", "role", "関連サービス"));
    for (const s of related) {
      const a = el("a", "svc-chip", `${s.service_no} ${s.name} ↗`);
      a.href = `/services#svc-${enc(s.service_no)}`;
      a.target = "_blank";
      a.rel = "noopener";
      rel.append(a);
    }
    titleBox.append(rel);
  }
  head.append(titleBox, el("span", "spacer"));

  const open = state.goals.filter((g) => g.status !== "達成" && g.status !== "保留");
  const overdue = open.filter((g) => goalDue(g) === "overdue").length;
  const stat = (k, v, cls = "") => {
    const s = el("div", `stat ${cls}`);
    s.append(el("div", "k", k));
    const vv = el("div", "v");
    vv.innerHTML = v;
    s.append(vv);
    return s;
  };
  const summary = el("div", "pf-summary");
  summary.append(
    stat("項目の達成", `${p.goal_done}<small> / ${p.goal_total}</small>`),
    stat("期限超過の項目", `${overdue}<small> 件</small>`, overdue ? "warn" : ""),
    stat("次の期限", p.next_due ? `${p.next_due.slice(5).replace("-", "/")}<small> （あと ${daysLeft(p.next_due)} 日）</small>` : "—"),
  );
  head.append(summary);
  if (!state.editing) {
    // 「編集する」は次の期限の隣（基本情報・全体目標の修正）
    const edit = el("button", "edit-btn", "✎ 編集する");
    edit.type = "button";
    edit.title = `基盤名・領域・PL・メンバー・全体目標を修正します${p.updated_at ? `（最終更新 ${p.updated_at.slice(0, 16)}）` : ""}`;
    edit.addEventListener("click", () => setEditing(true));
    head.append(edit);
  }
  root.append(head);

  // 全体目標
  const visionSec = el("section", "pf-section");
  const vh = el("h3", "", "全体目標");
  vh.append(el("span", "hint", "この基盤で最終的に実現したいこと・目指す姿（Markdown で書けます）"));
  visionSec.append(vh);
  if (state.editing) {
    const vision = el("textarea", "vision");
    vision.name = "vision";
    enableMarkdownEditing(vision); // 箇条書きの Enter・Tab などの入力補助
    vision.value = p.vision;
    vision.placeholder = "例: 受託解析の共通パイプラインを整備し、納期を 30% 短縮する（Markdown で書けます。例: **強調**、- 箇条書き、# 見出し）";
    visionSec.append(vision);
  } else {
    const vbody = el("div", `vision-text${p.vision ? " md" : " hint"}`);
    if (p.vision) vbody.innerHTML = window.mdToHtml(p.vision); // Markdown で書いた全体目標を表示用に変換（HTML はエスケープ済み）
    else vbody.textContent = "未記入";
    visionSec.append(vbody);
  }
  root.append(visionSec);


  // 基本情報（編集モードのみ入力欄）
  if (state.editing) {
    const infoSec = el("section", "pf-section");
    infoSec.append(el("h3", "", "基本情報"));
    const info = el("div", "pf-info");
    const field = (label, name, value, placeholder = "", cls = "") => {
      const l = el("label", cls);
      l.append(label);
      const i = el("input");
      i.name = name;
      i.value = value;
      i.placeholder = placeholder;
      l.append(i);
      return l;
    };
    // PL とメンバーは同じ行に並べる
    info.append(field("PL", "owner", p.owner, "例: 田中"), field("メンバー（複数はスペース区切り）", "members", p.members, "例: 佐藤 鈴木"),
      field("研究計画のリンク", "plan_url", p.plan_url, "https://"), field("BOX のリンク", "box_url", p.box_url, "https://"),
      field("Teams のリンク", "teams_url", p.teams_url, "https://"));
    // 自由リンク（何個でも）: 1 行に「名前」と「URL」
    const linkBox = el("div", "full free-links-edit");
    const lh = el("div", "fl-head");
    lh.append(el("span", "hint", "自由リンク（名前と URL。何個でも追加できます）"));
    const addBtn = el("button", "", "＋ リンクを追加");
    addBtn.type = "button";
    lh.append(addBtn);
    const rowsBox = el("div", "fl-rows");
    linkBox.append(lh, rowsBox);
    addBtn.addEventListener("click", () => { addLinkRow(rowsBox); markDirty(); rowsBox.lastChild.querySelector("input").focus(); });
    for (const l of p.links || []) addLinkRow(rowsBox, l);
    const areaBox = el("div", "full");
    areaBox.append(el("div", "hint", "領域（複数選択可）"));
    const chips = el("div", "chips-select");
    for (const a of [...state.areas, ...p.areas.filter((x) => !state.areas.includes(x))]) {
      const lab = el("label");
      lab.style.setProperty("--c", areaColor(a));
      const cb = el("input");
      cb.type = "checkbox";
      cb.name = "areas";
      cb.value = a;
      cb.checked = p.areas.includes(a);
      lab.classList.toggle("on", cb.checked);
      cb.addEventListener("change", () => { lab.classList.toggle("on", cb.checked); markDirty(); });
      lab.append(cb, a);
      chips.append(lab);
    }
    areaBox.append(chips);
    info.append(linkBox, areaBox);
    infoSec.append(info);
    root.append(infoSec);
    root.querySelectorAll('.pf-head input[name="title"], textarea[name="vision"], .pf-info input:not([type="checkbox"])')
      .forEach((i) => i.addEventListener("input", markDirty));

    $("#btn-save").addEventListener("click", async () => {
      try {
        const body = collectUnsaved();
        const bad = body.links.find((l) => !safeUrl(l.url));
        if (bad) throw new Error(`自由リンク「${bad.label || bad.url || "（名前なし）"}」の URL は http:// または https:// で始めてください（不要な行は削除）`);
        await api(`/api/platforms/${enc(p.name)}`, { method: "PUT", body: JSON.stringify(body) });
        state.dirty = false;
        state.editing = false;
        await reloadPlatforms();
        toast("保存しました");
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // 並び: 目標達成に必要な項目 → ガントチャート → ディスカッション・月報（タブ）
  root.append(renderGoals(p));
  renderGoalPanel();
  root.append(renderTasks(p, tasks));

  // 下部タブ
  const tabs = [
    ["topics", "ディスカッション", state.topics.length],
    ["monthly", "月報", state.monthly.length],
  ];
  if (!tabs.some(([k]) => k === state.tab)) state.tab = "topics";
  const tabBar = el("div", "pf-tabs");
  for (const [key, label, n] of tabs) {
    const b = el("button", state.tab === key ? "on" : "", label);
    b.append(el("span", "n", String(n)));
    b.addEventListener("click", () => {
      const keep = state.dirty ? collectUnsaved() : null;
      state.tab = key;
      store.set("platforms.tab", key);
      renderDetail();
      if (keep) restoreUnsaved(keep);
    });
    tabBar.append(b);
  }
  root.append(tabBar);
  const body = el("div", "pf-tab-body");
  if (state.tab === "monthly") body.append(renderMonthly(p));
  else body.append(renderTopics(p));
  root.append(body);
}

function markDirty() {
  state.dirty = true;
  const bar = $(".mode-bar");
  if (bar && !bar.querySelector(".dirty")) bar.firstChild.after(el("span", "dirty", "（未保存の変更あり）"));
}

// 自由リンクの 1 行（名前・URL・削除）
function addLinkRow(box, l = { label: "", url: "" }) {
  const row = el("div", "fl-row");
  const name = el("input", "fl-label");
  name.placeholder = "名前（例: 解析マニュアル）";
  name.value = l.label || "";
  const url = el("input", "fl-url");
  url.placeholder = "https://";
  url.value = l.url || "";
  const del = el("button", "fl-del", "削除");
  del.type = "button";
  del.title = "このリンクを外す（保存で確定）";
  del.addEventListener("click", () => { row.remove(); markDirty(); });
  for (const i of [name, url]) i.addEventListener("input", markDirty);
  row.append(name, url, del);
  box.append(row);
}

function collectUnsaved() {
  const root = $("#detail");
  return {
    title: root.querySelector('.pf-head input[name="title"]').value,
    vision: root.querySelector('textarea[name="vision"]').value,
    areas: [...root.querySelectorAll('input[name="areas"]:checked')].map((i) => i.value),
    owner: root.querySelector('input[name="owner"]').value,
    members: root.querySelector('input[name="members"]').value,
    plan_url: root.querySelector('input[name="plan_url"]').value.trim(),
    box_url: root.querySelector('input[name="box_url"]').value.trim(),
    teams_url: root.querySelector('input[name="teams_url"]').value.trim(),
    // 名前も URL も空の行は無視
    links: [...root.querySelectorAll(".fl-row")].map((r) => ({
      label: r.querySelector(".fl-label").value.trim(), url: r.querySelector(".fl-url").value.trim(),
    })).filter((l) => l.label || l.url),
  };
}
function restoreUnsaved(v) {
  const root = $("#detail");
  if (!root.querySelector('.pf-head input[name="title"]')) return;
  root.querySelector('.pf-head input[name="title"]').value = v.title;
  root.querySelector('textarea[name="vision"]').value = v.vision;
  root.querySelector('input[name="owner"]').value = v.owner;
  root.querySelector('input[name="members"]').value = v.members;
  root.querySelector('input[name="plan_url"]').value = v.plan_url;
  root.querySelector('input[name="box_url"]').value = v.box_url;
  root.querySelector('input[name="teams_url"]').value = v.teams_url;
  const rowsBox = root.querySelector(".fl-rows");
  if (rowsBox) {
    rowsBox.innerHTML = "";
    for (const l of v.links || []) addLinkRow(rowsBox, l);
  }
  root.querySelectorAll('input[name="areas"]').forEach((i) => {
    i.checked = v.areas.includes(i.value);
    i.closest("label").classList.toggle("on", i.checked);
  });
  markDirty();
}

// タブ内の変更後: 未保存の基本情報を保ったまま再描画
async function refreshAfterChange(kind) {
  const keep = state.dirty ? collectUnsaved() : null;
  const base = `/api/platforms/${enc(state.current)}`;
  if (kind === "tasks") state.tasks = await api("/api/tasks");
  else if (kind === "goalGantt") state.goalGantt = await api(`${base}/goal-gantt`);
  else if (kind === "goals") [state.goals, state.goalGantt] = await Promise.all([api(`${base}/goals`), api(`${base}/goal-gantt`)]);
  else if (kind) state[kind] = await api(`${base}/${kind}`);
  state.platforms = await api("/api/platforms");
  renderList();
  renderDetail();
  if (keep) restoreUnsaved(keep);
}

// ---- 目標: 一覧で読みやすく表示し、目標をクリックすると編集画面を開く
const ganttOf = (goalId) => state.goalGantt.filter((x) => x.goal_id === goalId);

// 1 項目 1 行（グループの「目標達成に必要な項目」と同じ構造）。クリックすると右に詳細の窓が開き、中にガント（月 × 4 週）を表示
function renderGoals(p) {
  const sec = el("section", "pf-section pf-goals");
  const h = el("h3", "", "目標達成に必要な項目");
  const done = state.goals.filter((g) => g.status === "達成").length;
  h.append(el("span", "count-badge", `${done} / ${state.goals.length} 達成`));
  h.append(el("span", "hint", "全体目標を達成するための項目です。クリックすると詳細（ガント）を開きます"));
  const add = el("button", "primary right", "＋ 項目を追加");
  add.type = "button";
  add.addEventListener("click", () => openGoalPanel("new", { kind: "goal", id: null }));
  h.append(add);
  sec.append(h);

  if (!state.goals.length) {
    sec.append(el("p", "hint", "まだ項目がありません。「＋ 項目を追加」から登録してください。"));
    return sec;
  }
  const ul = el("ul", "pf-goal-rows");
  for (const g of state.goals) {
    const li = el("li");
    li.tabIndex = 0;
    li.title = g.note ? `内容: ${g.note}\n（クリックで詳細）` : "クリックで詳細";
    const due = goalDue(g);
    li.classList.toggle("done", g.status === "達成");
    li.classList.toggle("sel", state.panelGoal === g.id);
    if (due) li.classList.add(due);
    const st = el("span", "status-badge", g.status);
    st.dataset.v = g.status;
    const main = el("div", "g-main");
    main.append(el("span", "g-title", g.title));
    if (safeUrl(g.url)) main.append(linkButton("リンク", g.url, "項目のリンク"));
    if (g.note) main.append(el("span", "g-note", g.note.replace(/\s*\n\s*/g, "　").trim()));
    const rows = ganttOf(g.id);
    const sum = el("div", "t-sum");
    sum.append(el("div", "lbl", rows.length ? `ガント ${rows.length} 件` : "ガントなし"));
    const d = el("span", `g-due ${due}`, g.due_date ? `期限 ${slashDate(g.due_date)}` : "");
    if (due) d.title = due === "overdue" ? `期限超過（${-daysLeft(g.due_date)} 日経過）` : `期限まであと ${daysLeft(g.due_date)} 日`;
    // 並び替え: 行の左のつまみ（⠿）をドラッグして好きな位置へ
    const handle = dragHandle(true);
    handle.title = "ドラッグして順番を入れ替え";
    enableDragSort(li, handle, {
      group: "goals", id: g.id, ids: () => state.goals.map((x) => x.id),
      onDrop: (ids) => reorderGoals(p, ids),
    });
    li.append(handle, st, main, sum, d);
    const open = () => { if (state.panelGoal !== g.id) openGoalPanel(g.id); };
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

async function reorderGoals(p, ids) {
  try {
    await api(`/api/platforms/${enc(p.name)}/goals/reorder`, { method: "POST", body: JSON.stringify({ ids }) });
  } catch (err) {
    toast(err.message, true);
  }
  await refreshAfterChange("goals");
}

// 項目の詳細（右の窓）: 項目の内容・ガント（月ごとに 4 つの週に分けて表示・年をまたいで横にスクロール）。（「議論の記録」は v1.14.0 で画面から外した。データは残してある）
// 編集はポップアップを開かず、窓の中でその場に書く（state.panelEdit = 編集中のもの）
// 窓の中の編集を切り替える（null = 編集をやめる）
function setPanelEdit(next) {
  if (!confirmDiscard(state.panelEdit ? [editKey(state.panelEdit)] : [])) return;
  state.panelEdit = next;
  renderDetail();
}
// 窓を開く・閉じる・別の項目に切り替える（id = null で閉じる、"new" で項目の追加）
function openGoalPanel(id, edit = null) {
  if (state.panelGoal !== id && !confirmDiscard()) return;
  state.panelGoal = id;
  state.openTask = null;
  state.panelEdit = edit;
  renderDetail();
}


// 項目（目標）の入力欄。g = null なら追加
function goalForm(p, g) {
  const key = editKey({ kind: "goal", id: g?.id });
  const form = el("form", "gpn-form");
  form.autocomplete = "off";
  const status = panelInput("status", { tag: "select" });
  for (const st of state.statuses) status.append(new Option(st, st));
  const title = panelInput("title", { required: true, placeholder: "例: プロテオーム解析の自動化" });
  const grid = el("div", "gpn-grid");
  grid.append(panelField("状態", status), panelField("期限", panelInput("due_date", { type: "date" })));
  form.append(grid, panelField("項目 *", title),
    panelField("内容", panelInput("note", { tag: "textarea", rows: 5, placeholder: "補足、達成条件、関連情報など" })),
    panelField("リンク", panelInput("url", { type: "url", placeholder: "https://（資料・報告書など）" })));
  const cancel = () => (g ? setPanelEdit(null) : openGoalPanel(null));
  const err = panelActions(form, {
    submitLabel: g ? "保存" : "追加", onCancel: cancel,
    onDelete: g && (() => confirmPasswordDelete(`/api/platforms/${enc(p.name)}/goals/${g.id}`, "項目", `項目: ${g.title}`, "goals")),
  });
  bindPanelForm(form, key, { status: g ? g.status : "未着手", title: g?.title, due_date: g?.due_date, note: g?.note, url: g?.url }, cancel);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (n) => form.elements.namedItem(n).value;
    const body = { title: v("title").trim(), status: v("status"), due_date: v("due_date") || null, note: v("note"), url: v("url").trim() };
    if (!body.title) { err.textContent = "項目を入力してください"; return; }
    if (body.url && !safeUrl(body.url)) { err.textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
    const url = `/api/platforms/${enc(p.name)}/goals`;
    try {
      const saved = await api(g ? `${url}/${g.id}` : url, { method: g ? "PUT" : "POST", body: JSON.stringify(body) });
      panelDrafts.delete(key);
      state.panelGoal = saved.id;
      state.panelEdit = null;
      await refreshAfterChange("goals");
      toast(g ? "保存しました" : "追加しました");
    } catch (ex) { err.textContent = ex.message; }
  });
  focusLater(g ? status : title);
  return form;
}

// ------------------------------------------------------------ 項目のガント（月ごとに 4 つの週に分けて表示・年をまたいで横にスクロール）
// 横軸 = 月。各月を 4 つの週（1 週目 = 1〜7 日・2 週目 = 8〜14 日・3 週目 = 15〜21 日・4 週目 = 22 日〜末）に分けた区画で表示する。
// 期間の入力は、開始日・終了日をカレンダーで入れる（日付そのものを保存）。表示は、開始日・終了日を含む週の区画までバーを引く。
// 月・年の区切りを見出しに出し、左右にスクロールして年をまたいで見られる（ガントチャートと同じ）。
// 行は タイトル・担当者・詳細（Markdown）と期間を持つ。期限は決めず、期間の終了日が期限。バーの色: 実施中 = 青、期限まで 1 か月 = オレンジ、期限超過 = 赤、将来の予定 = グレー。追加の期間のデフォルトは 3 か月。
// バーはドラッグで移動（週の単位）、両端のドラッグで期間を変更、クリックで詳細と編集。
const GG_COLS_SHOWN = 24; // 窓の幅に、およそ半年分（6 か月 × 4 週）が見えるように 1 区画の幅を決める
const GG_ADD_MONTHS = 3;  // 追加するときの期間のデフォルト（か月）
const GG_WEEK_DAYS = ["1〜7日", "8〜14日", "15〜21日", "22日〜末"];
const ggMs = (str) => parseDate(str);
// n か月後の日付 − 1 日（例: 11/3 から 3 か月 → 2/2）
function ggAddMonths(ms, n) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate();
  return t + (Math.min(d.getUTCDate(), last) - 1) * DAY_MS - DAY_MS;
}
const ggMonthNo = (ms) => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }; // 月の通し番号
const ggWeekOf = (day) => (day <= 7 ? 0 : day <= 14 ? 1 : day <= 21 ? 2 : 3);
// 状態（色）: 期限（= 終了日）を過ぎた = 赤（over）／まだ始まっていない = グレー（future）／実施中のうち、期限まで 1 か月以内 = オレンジ（soon）、それ以外 = 青（active）
function ggStatus(g, today) {
  if (ggMs(g.end_date) < today) return "over";
  if (ggMs(g.start_date) > today) return "future";
  return ggMs(g.end_date) <= ggAddMonths(today, 1) + DAY_MS ? "soon" : "active";
}
const GG_STATUS_TEXT = { over: "期限超過", future: "将来の予定", soon: "期限まで 1 か月以内", active: "実施中" };
const ggRangeText = (g) => `${slashDate(g.start_date)} 〜 ${slashDate(g.end_date)}`;
const ggBody = (g, over) => ({
  start_date: g.start_date, end_date: g.end_date, title: g.title,
  owner: g.owner || "", detail: g.detail || "", ...over,
});
// 区画（月 × 4 週）⇔ 日付。base = 範囲の先頭の月の通し番号。区画の番号 = (月 - base) × 4 + 週（0〜3）
function ggGeo(base, w) {
  const segStart = (i) => { const m = base + Math.floor(i / 4); return Date.UTC(Math.floor(m / 12), m % 12, 1 + 7 * (i % 4)); };
  const segEnd = (i) => { const m = base + Math.floor(i / 4), q = i % 4; return q < 3 ? Date.UTC(Math.floor(m / 12), m % 12, 7 * (q + 1)) : Date.UTC(Math.floor(m / 12), m % 12 + 1, 0); };
  const seg = (ms) => (ggMonthNo(ms) - base) * 4 + ggWeekOf(new Date(ms).getUTCDate());
  // 日付の位置（区画の中の何日目かまで）。期限の ◆ や今日の線に使う
  const xAt = (ms) => { const i = seg(ms), a = segStart(i); return (i + (ms - a) / (segEnd(i) + DAY_MS - a)) * w; };
  return { base, w, segStart, segEnd, seg, xAt };
}

// 行の入力欄。g = null なら追加（state.ganttDraft = ドラッグで引いた期間。無ければ 今日から 3 か月）
function ganttForm(p, goal, g) {
  const key = editKey({ kind: "gantt", id: g?.id });
  const form = el("form", "gpn-form");
  form.autocomplete = "off";
  const title = panelInput("title", { required: true, placeholder: "例: サンプル受領・QC" });
  const start = panelInput("start_date", { type: "date", required: true });
  const end = panelInput("end_date", { type: "date", required: true });
  const grid1 = el("div", "gpn-grid");
  grid1.append(panelField("開始日 *（カレンダーで選ぶ）", start), panelField("終了日 *（= 期限）", end));
  // 開始日から何か月か（終了日を入れる近道。デフォルトは 3 か月）
  const quick = el("div", "gg-quick");
  quick.append(el("span", "hint", "開始日から"));
  for (const n of [1, 3, 6, 12]) {
    const b = el("button", "", n === 12 ? "1 年" : `${n} か月`);
    b.type = "button";
    b.addEventListener("click", () => {
      if (!start.value) return;
      end.value = fmtDate(ggAddMonths(ggMs(start.value), n));
      end.dispatchEvent(new Event("input", { bubbles: true }));
    });
    quick.append(b);
  }
  form.append(panelField("タイトル *", title), grid1, quick,
    panelField("担当者（複数はスペース区切り）", panelInput("owner", { placeholder: "例: 高橋 鈴木" })),
    panelField("詳細（Markdown で書けます）", panelInput("detail", { tag: "textarea", rows: 6, placeholder: "- 箇条書き\n- **太字**\n- 表・リンクも書けます" })));
  enableMarkdownEditing(form.elements.namedItem("detail")); // 箇条書きの Enter・Tab などの入力補助
  const cancel = () => setPanelEdit(null);
  const err = panelActions(form, {
    submitLabel: g ? "保存" : "追加", onCancel: cancel,
    onDelete: g && (() => confirmPasswordDelete(`/api/platforms/${enc(p.name)}/goal-gantt/${g.id}`, "ガントの行", `ガント: ${g.title}`, "goalGantt")),
  });
  const draft = !g && state.ganttDraft;
  state.ganttDraft = null;
  const today = todayMs();
  bindPanelForm(form, key, {
    title: g?.title, owner: g?.owner, detail: g?.detail,
    start_date: g ? g.start_date : fmtDate(draft ? draft.start : today),
    end_date: g ? g.end_date : fmtDate(draft ? draft.end : ggAddMonths(today, GG_ADD_MONTHS)),
  }, cancel);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = (n) => form.elements.namedItem(n).value;
    const body = { start_date: v("start_date"), end_date: v("end_date"), title: v("title").trim(), owner: v("owner").trim(), detail: v("detail") };
    if (!body.title) { err.textContent = "タイトルを入力してください"; return; }
    if (!body.start_date || !body.end_date) { err.textContent = "開始日と終了日を入力してください"; return; }
    if (body.end_date < body.start_date) { err.textContent = "終了日は開始日と同じか、それより後にしてください"; return; }
    try {
      const url = `/api/platforms/${enc(p.name)}`;
      const saved = await api(g ? `${url}/goal-gantt/${g.id}` : `${url}/goals/${goal.id}/gantt`, { method: g ? "PUT" : "POST", body: JSON.stringify(body) });
      panelDrafts.delete(key);
      state.panelEdit = null;
      state.openGantt = saved.id;
      state.ganttAnchor = ggMs(saved.start_date) - 30 * DAY_MS; // 保存した行が見える位置へ
      await refreshAfterChange("goalGantt");
      toast(g ? "保存しました" : "追加しました");
    } catch (ex) { err.textContent = ex.message; }
  });
  focusLater(title);
  return form;
}

// バーのドラッグ: 中央 = 移動、左右の端 = 期間の変更（週の単位。日付は週の区画の端にそろう）。動かさずに離したら詳細の開閉
function startGanttDrag(ev, bar, g, geo) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const mode = ev.target.classList.contains("l") ? "l" : ev.target.classList.contains("r") ? "r" : "move";
  const x0 = ev.clientX;
  const si = geo.seg(ggMs(g.start_date)), ei = geo.seg(ggMs(g.end_date));
  let s = si, e = ei, moved = false;
  bar.setPointerCapture(ev.pointerId);
  bar.classList.add("dragging");
  const place = () => {
    bar.style.left = `${s * geo.w}px`;
    bar.style.width = `${(e - s + 1) * geo.w}px`;
    bar.title = `${g.title}\n${slashDate(fmtDate(geo.segStart(s)))} 〜 ${slashDate(fmtDate(geo.segEnd(e)))}`;
  };
  const move = (m) => {
    if (Math.abs(m.clientX - x0) > 3) moved = true;
    const d = Math.round((m.clientX - x0) / geo.w);
    if (mode === "move") { s = Math.max(0, si + d); e = s + (ei - si); }
    else if (mode === "l") { s = Math.max(0, Math.min(si + d, ei)); e = ei; }
    else { s = si; e = Math.max(ei + d, si); }
    place();
  };
  const up = async () => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", up);
    bar.removeEventListener("pointercancel", up);
    bar.classList.remove("dragging");
    if (!moved) { state.openGantt = state.openGantt === g.id ? null : g.id; renderDetail(); return; }
    if (s === si && e === ei) return;
    // 動かした側だけ区画の端にそろえる（動かしていない側の日付は、入れたまま）
    const body = ggBody(g, {
      start_date: s === si ? g.start_date : fmtDate(geo.segStart(s)),
      end_date: e === ei ? g.end_date : fmtDate(geo.segEnd(e)),
    });
    if (mode === "move") { body.start_date = fmtDate(geo.segStart(s)); body.end_date = fmtDate(geo.segEnd(e)); }
    try {
      await api(`/api/platforms/${enc(state.current)}/goal-gantt/${g.id}`, { method: "PUT", body: JSON.stringify(body) });
      toast(`${slashDate(body.start_date)} 〜 ${slashDate(body.end_date)} に変更しました`);
    } catch (err) { toast(err.message, true); }
    await refreshAfterChange("goalGantt");
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", up);
  bar.addEventListener("pointercancel", up);
}

// いちばん下の枠: ドラッグで期間を引く（週の区画の単位）。ドラッグせずにクリックしたら、その週から 3 か月のデフォルト → 追加のフォームが開く
function startGanttDraw(ev, track, geo) {
  if (ev.button !== 0 || state.panelEdit) return;
  ev.preventDefault();
  const segAt = (x) => Math.max(0, Math.floor((x - track.getBoundingClientRect().left) / geo.w));
  const a = segAt(ev.clientX);
  let b = a, moved = false;
  const sel = el("div", "gg-sel");
  track.append(sel);
  track.setPointerCapture(ev.pointerId);
  const range = () => (moved
    ? { start: geo.segStart(Math.min(a, b)), end: geo.segEnd(Math.max(a, b)) }
    : { start: geo.segStart(a), end: ggAddMonths(geo.segStart(a), GG_ADD_MONTHS) });
  const paint = () => {
    const r = range();
    const i = geo.seg(r.start), j = geo.seg(r.end);
    sel.style.left = `${i * geo.w}px`;
    sel.style.width = `${(j - i + 1) * geo.w}px`;
    sel.textContent = `${slashDate(fmtDate(r.start))} 〜 ${slashDate(fmtDate(r.end))}`;
  };
  paint();
  const move = (m) => { b = segAt(m.clientX); if (b !== a) moved = true; paint(); };
  const up = () => {
    track.removeEventListener("pointermove", move);
    track.removeEventListener("pointerup", up);
    track.removeEventListener("pointercancel", up);
    sel.remove();
    state.ganttDraft = range();
    setPanelEdit({ kind: "gantt", id: null });
  };
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
}

function renderGantt(box, p, goal, editing) {
  const rows = ganttOf(goal.id);
  const today = todayMs();

  // 横軸の範囲: 今日の 1 か月前（行がもっと前にあればそこから）〜 1 年半先（行がもっと先にあればそこまで）
  const w = Math.max(10, Math.min(30, Math.floor((box.clientWidth - 4) / GG_COLS_SHOWN)));
  let first = ggMonthNo(today) - 1;
  let last = ggMonthNo(today) + 18;
  for (const g of rows) {
    first = Math.min(first, ggMonthNo(ggMs(g.start_date)) - 1);
    last = Math.max(last, ggMonthNo(ggMs(g.end_date)) + 2);
  }
  const months = last - first + 1;
  const geo = ggGeo(first, w);

  // 見出し: ガント・件数・スクロール（3 か月ずつ・今日）・追加
  const ah = el("div", "gpn-ah");
  ah.append(el("b", "", "ガント"), el("span", "count-badge", `${rows.length} 件`), el("span", "spacer"));
  const nav = el("span", "gg-year");
  const wrap = el("div", "gg-wrap");
  const nb = (label, title, fn) => { const b = el("button", "", label); b.type = "button"; b.title = title; b.addEventListener("click", fn); return b; };
  nav.append(nb("◀", "3 か月前へ", () => { wrap.scrollLeft -= 12 * w; }),
    nb("今日", "今日の位置へ", () => { wrap.scrollLeft = Math.max(0, geo.xAt(today) - 4 * w); }),
    nb("▶", "3 か月先へ", () => { wrap.scrollLeft += 12 * w; }));
  ah.append(nav);
  const add = el("button", "primary", "＋ 追加");
  add.type = "button";
  add.title = `今日から ${GG_ADD_MONTHS} か月のデフォルトで追加（開始日・終了日はカレンダーで変えられます）`;
  add.disabled = editing("gantt", null);
  add.addEventListener("click", () => setPanelEdit({ kind: "gantt", id: null }));
  ah.append(add);
  box.append(ah);
  const legend = el("div", "gg-legend");
  for (const k of ["active", "soon", "over", "future"]) {
    const x = el("span", `st-${k}`);
    x.append(el("i"), GG_STATUS_TEXT[k]);
    legend.append(x);
  }
  box.append(legend);
  if (editing("gantt", null)) box.append(ganttForm(p, goal, null));

  const grid = el("div", "gg");
  grid.style.width = `${w * 4 * months}px`;
  grid.style.setProperty("--sw", `${w}px`);
  // 見出し 2 段: 上 = 月（年つき）、下 = 週（1〜4）
  const head = el("div", "gg-head");
  for (let k = 0; k < months; k++) {
    const m = first + k, y = Math.floor(m / 12), mo = m % 12;
    const c = el("div", `gg-month${mo === 0 ? " yr" : ""}`, w * 4 >= 56 || mo === 0 || k === 0 ? `${y}年${mo + 1}月` : `${mo + 1}月`);
    c.style.left = `${k * 4 * w}px`;
    c.style.width = `${4 * w}px`;
    c.title = `${y}年${mo + 1}月（4 つの週: ${GG_WEEK_DAYS.join("・")}）`;
    head.append(c);
    for (let q = 0; q < 4; q++) {
      const wcell = el("div", "gg-week", String(q + 1));
      wcell.style.left = `${(k * 4 + q) * w}px`;
      wcell.style.width = `${w}px`;
      wcell.title = `${mo + 1}月 ${q + 1} 週目（${GG_WEEK_DAYS[q]}）`;
      head.append(wcell);
    }
  }
  grid.append(head);
  const body = el("div", "gg-body");
  for (let k = 1; k < months; k++) { // 年の区切り（1 月の左）
    if ((first + k) % 12 === 0) {
      const ln = el("div", "gg-mline yr");
      ln.style.left = `${k * 4 * w}px`;
      body.append(ln);
    }
  }
  const tl = el("div", "gg-today");
  tl.style.left = `${geo.xAt(today)}px`;
  tl.title = "今日";
  body.append(tl);
  for (const g of rows) {
    const row = el("div", "gg-row");
    row.dataset.id = g.id;
    const track = el("div", "gg-track");
    const st = ggStatus(g, today);
    const bar = el("div", `gg-bar st-${st}${state.openGantt === g.id ? " open" : ""}`);
    const i = geo.seg(ggMs(g.start_date)), j = geo.seg(ggMs(g.end_date));
    bar.style.left = `${i * w + 1}px`;
    bar.style.width = `${(j - i + 1) * w - 2}px`;
    bar.title = `${g.title}\n${ggRangeText(g)}（${GG_STATUS_TEXT[st]}。期限 = 終了日）${g.owner ? `\n担当 ${g.owner.split(" ").join("・")}` : ""}\n（ドラッグで移動・両端で期間を変更。クリックで詳細）`;
    bar.append(el("span", "handle l"), el("span", "handle r"));
    bar.append(el("span", "gg-label", `${g.title}${g.owner ? ` / ${g.owner.split(" ").join("・")}` : ""}`));
    bar.addEventListener("pointerdown", (ev) => startGanttDrag(ev, bar, g, geo));
    track.append(bar);
    row.append(track);
    body.append(row);
    // 詳細（クリックで開く）/ 編集
    if (editing("gantt", g.id)) {
      const f = el("div", "gg-detail");
      f.append(ganttForm(p, goal, g));
      body.append(f);
    } else if (state.openGantt === g.id) {
      const d = el("div", `gg-detail st-${st}`);
      d.append(el("h4", "", g.title));
      const dl = el("dl", "gpn-facts");
      const fact = (k, v, cls = "") => { if (v) dl.append(el("dt", "", k), el("dd", cls, v)); };
      fact("期間", ggRangeText(g));
      fact("期限（終了日）", `${slashDate(g.end_date)}（${GG_STATUS_TEXT[st]}）`, st === "over" ? "overdue" : "");
      fact("担当者", g.owner ? g.owner.split(" ").join("・") : "");
      d.append(dl);
      if (g.detail) {
        const md = el("div", "md gg-md");
        md.innerHTML = window.mdToHtml(g.detail); // Markdown で書いた詳細を表示用に変換（HTML はエスケープ済み）
        d.append(md);
      }
      const eb = el("button", "", "✎ 編集");
      eb.type = "button";
      eb.addEventListener("click", () => setPanelEdit({ kind: "gantt", id: g.id }));
      d.append(eb);
      body.append(d);
    }
  }
  // いちばん下の枠: ドラッグして新しい行の期間を引く（クリックだけなら 3 か月）
  const draw = el("div", "gg-row gg-new");
  const dtrack = el("div", "gg-track");
  dtrack.append(el("span", "gg-hint", state.panelEdit ? "" : `ここをドラッグして期間を引く（クリックだけなら ${GG_ADD_MONTHS} か月）`));
  dtrack.addEventListener("pointerdown", (ev) => startGanttDraw(ev, dtrack, geo));
  draw.append(dtrack);
  body.append(draw);
  grid.append(body);
  wrap.append(grid);
  box.append(wrap);
  grid.style.setProperty("--vw", `${wrap.clientWidth}px`); // 詳細・入力欄は、横にスクロールしても窓の幅で左端に留める
  // 表示位置: 直前に見ていた位置（日付で覚える。行の追加・並び替えで範囲が変わってもずれない）。初めは今日の少し前
  wrap.scrollLeft = geo.xAt(state.ganttAnchor ?? today - 30 * DAY_MS);
  wrap.addEventListener("scroll", () => {
    const i = Math.max(0, Math.floor(wrap.scrollLeft / w));
    state.ganttAnchor = geo.segStart(i) + ((wrap.scrollLeft / w - i) * (geo.segEnd(i) + DAY_MS - geo.segStart(i)));
  });
  if (!rows.length) box.append(el("p", "hint", "ガントはまだありません。上の「＋ 追加」か、枠のドラッグ・クリックで登録できます。"));
}

function renderGoalPanel() {
  const panel = $("#goal-panel");
  const box = $("#goal-panel-body");
  const p = state.platforms.find((x) => x.name === state.current);
  const isNew = state.panelGoal === "new";
  const g = !isNew && state.panelGoal && state.goals.find((x) => x.id === state.panelGoal);
  panel.hidden = !p || (!g && !isNew);
  if (panel.hidden) { state.panelEdit = null; panelDrafts.clear(); return; }
  const ed = state.panelEdit;
  // 編集中のものが消えていたら（削除など）編集をやめる
  if (ed?.kind === "gantt" && ed.id && !state.goalGantt.some((t) => t.id === ed.id)) {
    panelDrafts.delete(editKey(ed));
    state.panelEdit = null;
  }
  const editing = (kind, id) => state.panelEdit?.kind === kind && (state.panelEdit.id ?? null) === (id ?? null);
  const scroll = box.scrollTop;
  box.innerHTML = "";

  const head = el("div", "gpn-head");
  if (g) {
    const st = el("span", "status-badge", g.status);
    st.dataset.v = g.status;
    head.append(st);
  } else head.append(el("b", "", "項目の追加"));
  const close = el("button", "gpn-close", "✕");
  close.type = "button";
  close.title = "閉じる";
  close.addEventListener("click", () => openGoalPanel(null));
  head.append(el("span", "spacer"), close);
  box.append(head);

  if (!g) {
    box.append(el("p", "hint", `${p.name} ${p.title || ""}`), goalForm(p, null));
    box.scrollTop = 0;
    return;
  }

  if (editing("goal", g.id)) {
    box.append(el("p", "hint", `最終更新 ${g.updated_at.slice(0, 16)}`), goalForm(p, g));
  } else {
    const due = goalDue(g);
    const facts = el("dl", "gpn-facts");
    const fact = (k, v, cls = "") => { if (v) facts.append(el("dt", "", k), el("dd", cls, v)); };
    fact("期限", g.due_date ? `${slashDate(g.due_date)}${due === "overdue" ? `（${-daysLeft(g.due_date)} 日超過）` : g.status !== "達成" ? `（あと ${daysLeft(g.due_date)} 日）` : ""}` : "", due);
    fact("内容", g.note, "pre");
    box.append(el("h3", "gpn-title", g.title), facts);
    if (safeUrl(g.url)) {
      const a = el("a", "g-link", "リンク ↗");
      a.href = g.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      box.append(a, " ");
    }
    const edit = el("button", "gpn-edit", "✎ 項目を編集");
    edit.type = "button";
    edit.addEventListener("click", () => setPanelEdit({ kind: "goal", id: g.id }));
    box.append(edit);
  }

  renderGantt(box, p, g, editing);

  box.scrollTop = scroll;
}

// 窓の幅: 左端をドラッグして変えられる
enablePanelResize($("#goal-panel"), $("#goal-panel-resize"), "platforms.panelWidth", () => { if (!state.panelEdit) renderDetail(); }); // 幅が変わったらガントの区画の幅も合わせる


// 目標・月報の削除: パスワードを入力して確認（サーバー側でも検証）
let pwDelete = null; // { url, label, kind }
function confirmPasswordDelete(url, label, summary, kind) {
  pwDelete = { url, label, kind };
  const f = $("#form-goal-delete");
  f.reset();
  $("#goal-delete-title").textContent = `${label}の削除`;
  $("#goal-delete-lead").textContent = `次の${label}を削除します。`;
  $("#goal-delete-name").textContent = summary;
  $("#goal-delete-error").textContent = "";
  $("#dlg-goal-delete").showModal();
  f.password.focus();
}
$("#dlg-goal-delete [data-close]").addEventListener("click", () => $("#dlg-goal-delete").close());
$("#form-goal-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    await api(pwDelete.url, { method: "DELETE", body: JSON.stringify({ password: f.password.value }) });
    $("#dlg-goal-delete").close();
    await refreshAfterChange(pwDelete.kind);
    toast(`${pwDelete.label}を削除しました`);
  } catch (err) {
    $("#goal-delete-error").textContent = err.message;
    f.password.select();
  } finally {
    btn.disabled = false;
  }
});

// ---- ディスカッション（定期的な議論のトピック）
function renderTopics(p) {
  const sec = el("section", "pf-section");
  const h = el("h3", "", "ディスカッション");
  h.append(el("span", "hint", "定期的なディスカッションのトピックと、内容・決定事項・宿題"));
  sec.append(h);
  const url = `/api/platforms/${enc(p.name)}/topics`;
  let editing = null; // 編集中のトピック

  const form = el("form", "log-form");
  const row = el("div", "row");
  const date = el("input");
  date.type = "date";
  date.name = "meeting_date";
  date.required = true;
  date.value = fmtDate(todayMs());
  const title = el("input");
  title.name = "title";
  title.required = true;
  title.placeholder = "トピック（例: 今期の優先順位の確認）";
  row.append(date, title);
  const body = el("textarea");
  body.name = "body";
  body.placeholder = "内容・決定事項・宿題（担当者・期限）など";
  const actions = el("div", "actions-row");
  const mode = el("span", "hint", "新規記入");
  const btns = el("span");
  const cancel = el("button", "", "取消");
  cancel.type = "button";
  cancel.hidden = true;
  const submit = el("button", "primary", "トピックを追加");
  submit.type = "submit";
  btns.append(cancel, " ", submit);
  actions.append(mode, btns);
  form.append(row, body, actions);

  const resetForm = () => {
    editing = null;
    form.reset();
    date.value = fmtDate(todayMs());
    mode.textContent = "新規記入";
    submit.textContent = "トピックを追加";
    cancel.hidden = true;
  };
  cancel.addEventListener("click", resetForm);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { meeting_date: date.value, title: title.value.trim(), body: body.value };
    if (!data.title) return;
    try {
      await api(editing ? `${url}/${editing.id}` : url, { method: editing ? "PUT" : "POST", body: JSON.stringify(data) });
      toast(editing ? "トピックを更新しました" : "トピックを追加しました");
      await refreshAfterChange("topics");
    } catch (err) { toast(err.message, true); }
  });
  sec.append(form);

  const ol = el("ol", "log-list");
  if (!state.topics.length) ol.append(el("li", "empty", "まだトピックがありません。"));
  for (const t of state.topics) {
    const li = el("li");
    const lh = el("div", "lh");
    lh.append(el("b", "", slashDate(t.meeting_date)), el("span", "ttl", t.title), el("span", "upd", `更新 ${t.updated_at.slice(0, 16)}`));
    const edit = el("button", "", "編集");
    edit.type = "button";
    edit.addEventListener("click", () => {
      editing = t;
      date.value = t.meeting_date;
      title.value = t.title;
      body.value = t.body;
      mode.textContent = `${slashDate(t.meeting_date)} のトピックを編集中`;
      submit.textContent = "更新";
      cancel.hidden = false;
      title.focus();
      form.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    const del = el("button", "", "削除");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`トピック「${t.title}」を削除しますか？`)) return;
      try {
        await api(`${url}/${t.id}`, { method: "DELETE" });
        toast("トピックを削除しました");
        await refreshAfterChange("topics");
      } catch (err) { toast(err.message, true); }
    });
    lh.append(edit, del);
    li.append(lh);
    if (t.body) li.append(el("div", "lb", t.body));
    ol.append(li);
  }
  sec.append(ol);
  return sec;
}

// ---- 月報（月ごとに 1 件、同じ月に保存すると上書き）
function renderMonthly(p) {
  const sec = el("section", "pf-section");
  const h = el("h3", "", "月報");
  h.append(el("span", "hint", "月ごとに 1 件。同じ月に保存すると上書きされます"));
  sec.append(h);
  const url = `/api/platforms/${enc(p.name)}/monthly`;

  const form = el("form", "log-form");
  const row = el("div", "row");
  const month = el("input");
  month.type = "month";
  month.name = "month";
  month.required = true;
  const label = el("span", "hint");
  row.append(month, label);
  const body = el("textarea");
  body.name = "body";
  body.required = true;
  body.placeholder = "今月の実施内容、成果、課題、来月の予定など";
  const actions = el("div", "actions-row");
  const stateText = el("span", "hint");
  const submit = el("button", "primary", "月報を保存");
  submit.type = "submit";
  actions.append(stateText, submit);
  form.append(row, body, actions);

  const setMonth = (m) => {
    month.value = m;
    const existing = state.monthly.find((r) => r.month === m);
    body.value = existing ? existing.body : "";
    label.textContent = `${monthLabel(m)}${m === thisMonth() ? "・今月" : ""}`;
    stateText.textContent = existing ? "この月は記入済みです（上書き保存されます）" : "新規記入";
  };
  month.addEventListener("change", () => { if (month.value) setMonth(month.value); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!body.value.trim() || !month.value) return;
    const m = month.value;
    try {
      await api(url, { method: "PUT", body: JSON.stringify({ month: m, body: body.value }) });
      toast("月報を保存しました");
      await refreshAfterChange("monthly");
    } catch (err) { toast(err.message, true); }
  });
  sec.append(form);

  const ol = el("ol", "log-list");
  if (!state.monthly.length) ol.append(el("li", "empty", "まだ月報がありません。"));
  for (const r of state.monthly) {
    const li = el("li");
    if (r.month === thisMonth()) li.classList.add("current");
    const lh = el("div", "lh");
    lh.append(el("b", "", monthLabel(r.month)), el("span", "upd", `更新 ${r.updated_at.slice(0, 16)}`));
    const edit = el("button", "", "編集");
    edit.type = "button";
    edit.addEventListener("click", () => { setMonth(r.month); body.focus(); form.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
    const del = el("button", "", "削除");
    del.type = "button";
    del.title = "削除（パスワードが必要）";
    del.addEventListener("click", () =>
      confirmPasswordDelete(`${url}/${r.id}`, "月報", `${monthLabel(r.month)}の月報`, "monthly"));
    lh.append(edit, del);
    li.append(lh, el("div", "lb", r.body));
    ol.append(li);
  }
  sec.append(ol);
  setMonth(thisMonth());
  return sec;
}

// ---- タスク（表示のみ）: ガントチャートで PJ名 = 基盤番号 のタスク。編集はガントチャートで行う
// ガントチャートのタスク（PJ名 = 基盤番号）: ガントチャートと同じ形で表示（表示のみ。編集はガントチャートで）
// 左: タスク名（実施中 = 青、3 営業日以内 = オレンジ、超過 = 赤）・担当者・開始日・終了日・残り日数
// 右: 日付の帯（領域の色）、今日の線、土日
function renderTasks(p, tasks) {
  const sec = el("section", "pf-section pf-tasks");
  const h = el("h3", "", "ガントチャート");
  const doneN = tasks.filter((t) => t.completed_at).length;
  h.append(el("span", "hint", `${tasks.length} 件${doneN ? `（うち完了 ${doneN} 件）` : ""}（表示のみ。追加・編集はガントチャートで）`));
  const legend = el("span", "pg-legend");
  for (const [cls, label] of [["overdue", "期限超過"], ["soon", "期限3営業日以内"], ["active", "実施中"], ["finished", "完了"]]) {
    const x = el("span", cls);
    x.append(el("i"), label);
    legend.append(x);
  }
  h.append(legend);
  // ガントチャートへは同じ画面のまま移る（新しいタブを開かない）。ガントチャートの「← 基盤に戻る」で戻れる
  const link = el("a", "button right", "ガントチャートで編集 →");
  link.href = `/?pj=${enc(p.name)}`;
  h.append(link);
  sec.append(h);
  if (!tasks.length) {
    sec.append(el("p", "hint", "この基盤のタスクはまだありません。ガントチャートでタスクを追加し、PJ名にこの基盤番号を選ぶと表示されます。"));
    return sec;
  }

  const DAY_W = 16;
  const today = todayMs();
  let min = today - 7 * DAY_MS;
  let max = today + 21 * DAY_MS;
  for (const t of tasks) {
    min = Math.min(min, parseDate(t.start_date) - 3 * DAY_MS);
    max = Math.max(max, parseDate(t.end_date) + 7 * DAY_MS);
  }
  const days = Math.round((max - min) / DAY_MS) + 1;
  const W = days * DAY_W;
  const x = (ms) => ((ms - min) / DAY_MS) * DAY_W;

  const wrap = el("div", "pg-scroll");
  const grid = el("div", "pg");
  grid.style.setProperty("--track-w", `${W}px`);

  // 見出し: 左の列名と、右の月・日
  const head = el("div", "pg-row pg-head");
  const hl = el("div", "pg-left");
  for (const t of ["タスク", "担当者", "開始日", "終了日", "残り日数"]) hl.append(el("span", "", t));
  const ht = el("div", "pg-track");
  const bg = el("div", "pg-bg"); // 土日・月の区切り・今日の線（全行の後ろ）
  for (let i = 0; i < days; i++) {
    const ms = min + i * DAY_MS;
    const d = new Date(ms);
    const dow = d.getUTCDay();
    if (d.getUTCDate() === 1 || i === 0) {
      const m = el("div", "pg-month", `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`);
      m.style.left = `${x(ms)}px`;
      ht.append(m);
      if (i) {
        const line = el("div", "pg-mline");
        line.style.left = `${x(ms)}px`;
        bg.append(line);
      }
    }
    const day = el("div", `pg-day${dow === 0 || dow === 6 ? " weekend" : ""}${ms === today ? " today" : ""}`, String(d.getUTCDate()));
    day.style.left = `${x(ms)}px`;
    ht.append(day);
    if (dow === 0 || dow === 6) {
      const we = el("div", "pg-weekend");
      we.style.left = `${x(ms)}px`;
      bg.append(we);
    }
  }
  const tline = el("div", "pg-today");
  tline.style.left = `${x(today) + DAY_W / 2}px`;
  bg.append(tline);
  head.append(hl, ht);
  grid.append(head);

  const body = el("div", "pg-body");
  body.append(bg);
  for (const t of tasks) {
    const finished = !!t.completed_at;
    const left = daysLeft(t.end_date);
    const wd = workDaysLeft(parseDate(t.end_date)); // 営業日（土日を除く）
    // 完了したタスクは期限・実施中の色を付けない（ガントチャートと同じ）
    const due = finished ? "" : left < 0 ? "overdue" : wd <= 3 ? "soon" : "";
    const active = !finished && !due && daysLeft(t.start_date) <= 0 ? "active" : ""; // 実施中 = 今日が開始日〜終了日の間
    const row = el("div", finished ? "pg-row done" : "pg-row");
    const lc = el("div", "pg-left");
    const name = el("span", `t-name ${due || active}`.trim(), finished ? `✓ ${t.task}` : t.task);
    const doneDay = finished ? t.completed_at.slice(0, 10).replaceAll("-", "/") : "";
    name.title = `${finished ? `完了（${doneDay}）\n` : ""}${t.task}${t.detail ? "\n\n" + t.detail : ""}`;
    const rest = finished ? `完了 ${Number(t.completed_at.slice(5, 7))}/${Number(t.completed_at.slice(8, 10))}`
      : left < 0 ? `${Math.max(1, -wd)} 営業日超過` : left === 0 ? "今日まで" : `あと ${wd} 営業日`;
    const rc = el("span", `days-left${finished ? "" : left < 0 ? " over" : left <= 7 ? " near" : ""}`, rest);
    lc.append(name, el("span", "who", (t.assignee || "").split(" ").filter(Boolean).join("・") || "—"), el("span", "dt", slashDate(t.start_date)),
      el("span", "dt", slashDate(t.end_date)), rc);
    const track = el("div", "pg-track");
    const bar = el("div", "pg-bar");
    const s0 = x(parseDate(t.start_date));
    bar.style.left = `${s0}px`;
    bar.style.width = `${Math.max(x(parseDate(t.end_date) + DAY_MS) - s0, 6)}px`;
    bar.style.setProperty("--c", areaColor(t.area));
    bar.append(el("span", `prio p-${t.priority}`), el("span", "lbl", t.task));
    bar.title = `${t.task}\n領域: ${t.area} / 担当: ${(t.assignee || "").split(" ").filter(Boolean).join("・") || "-"} / 優先度: ${t.priority}\n${t.start_date} 〜 ${t.end_date}（${rest}）`;
    track.append(bar);
    // クリックでガントチャート（この基盤のタスク）へ移って編集（同じ画面のまま）
    const openGantt = () => { location.href = `/?pj=${enc(p.name)}`; };
    name.addEventListener("click", openGantt);
    bar.addEventListener("click", openGantt);
    row.append(lc, track);
    body.append(row);
  }
  grid.append(body);
  wrap.append(grid);
  sec.append(wrap);
  // 開いたときに今日のあたりが見えるように
  requestAnimationFrame(() => { wrap.scrollLeft = Math.max(0, x(today) - 7 * DAY_W); });
  return sec;
}

// ------------------------------------------------------------ 起動
async function reloadPlatforms() {
  state.platforms = await api("/api/platforms");
  renderList();
  renderDetail();
}

$("#f-person").addEventListener("change", (e) => {
  state.filterPerson = e.target.value;
  store.set("platforms.person", state.filterPerson);
  renderList();
});

$("#f-area").addEventListener("change", (e) => {
  state.filterArea = e.target.value;
  store.set("platforms.area", state.filterArea);
  renderList();
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty || panelDirty()) { e.preventDefault(); e.returnValue = ""; }
});

(async () => {
  try {
    const [platforms, areas, statuses, tasks, services] = await Promise.all([
      api("/api/platforms"), api("/api/masters/areas"), api("/api/platforms/goal-statuses"), api("/api/tasks"),
      api("/api/services"),
    ]);
    Object.assign(state, { platforms, areas, statuses, tasks, services });
    const fa = $("#f-area");
    for (const a of areas) fa.append(new Option(a, a));
    const savedArea = store.get("platforms.area") || "";
    state.filterArea = areas.includes(savedArea) ? savedArea : "";
    fa.value = state.filterArea;
    state.filterPerson = store.get("platforms.person") || "";
      renderList();
    const want = new URLSearchParams(location.search).get("id");
    if (want && platforms.some((p) => p.name === want)) await select(want);
    else showView(false);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
