"use strict";

const DAY_MS = 86400000;
const PRIORITIES = ["高", "中", "低"];
const PRIO_COLOR = { 高: "#e5484d", 中: "#f5a524", 低: "#30a46c" };
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
// PJ名 = 案件なら案件番号、基盤なら基盤番号（どちらも管理サイトで登録）

const state = {
  tasks: [],
  masters: { areas: [], projects: [] },
  caseNames: {}, // 案件番号 -> 案件名（検索用）
  pj: { cases: [], platforms: [] }, // PJ名の選択肢: 案件番号 / 基盤番号
  filter: { areas: "", projects: "", assignees: "" },
  q: "", // キーワード検索（PJ名・タスク名・担当者・領域）
  compact: false,
  dayW: 26,
  rangeStart: 0, // UTC ms
  days: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const scroller = $("#scroller");
const gantt = $("#gantt");
// 左側の列幅。領域・PJ名・タスク・担当者・終了日は見出しの右端をドラッグして変更でき、ブラウザに記憶する
const COL_W_DEFAULT = { area: 6, pj: 240, task: 200, assignee: 80, end: 96 };
const COL_W_MIN_OF = { area: 60, pj: 80, task: 80, assignee: 44, end: 56 };
const COL_W_MAX = 640;
const colW = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("gantt.colW") || "{}");
    return { ...COL_W_DEFAULT, ...saved, area: COL_W_DEFAULT.area }; // 領域は色の帯だけ（幅は固定）
  } catch (_) {
    return { ...COL_W_DEFAULT };
  }
})();
// 列: 領域 + PJ名 + タスク + (担当者 + 優先度 56 + 開始 40 + 終了日) + 削除 34
const leftW = () => colW.area + colW.pj + colW.task + 64 + (state.compact ? 0 : colW.assignee + 56 + 40 + colW.end);
const saveColW = () => {
  try { localStorage.setItem("gantt.colW", JSON.stringify(colW)); } catch (_) { /* 記憶できなくても幅は変わる */ }
};

function applyColWidths() {
  gantt.style.setProperty("--w-area", `${colW.area}px`);
  gantt.style.setProperty("--w-pj", `${colW.pj}px`);
  gantt.style.setProperty("--w-task", `${colW.task}px`);
  gantt.style.setProperty("--w-assignee", `${colW.assignee}px`);
  gantt.style.setProperty("--w-end", `${colW.end}px`);
  gantt.style.setProperty("--left-w", `${leftW()}px`);
  gantt.style.width = `${leftW() + state.days * state.dayW}px`;
  const layer = $(".bg-layer", gantt);
  if (layer) layer.style.left = `${leftW()}px`;
}

function startColResize(e, key) {
  e.preventDefault();
  e.stopPropagation();
  const handle = e.currentTarget;
  const x0 = e.clientX;
  const w0 = colW[key];
  handle.setPointerCapture(e.pointerId);
  handle.classList.add("active");
  document.body.classList.add("resizing");
  const move = (ev) => {
    colW[key] = Math.min(COL_W_MAX, Math.max(COL_W_MIN_OF[key], Math.round(w0 + ev.clientX - x0)));
    applyColWidths();
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    handle.classList.remove("active");
    document.body.classList.remove("resizing");
    saveColW();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}
const SOON_DAYS = 3; // 期限の 3 日前からオレンジ

// ------------------------------------------------------------ 日付ユーティリティ（UTC で計算）
const parseDate = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const todayMs = () => {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
};
const dayIndex = (ms) => Math.round((ms - state.rangeStart) / DAY_MS);

// ------------------------------------------------------------ API
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {},
    ...options,
  });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error("ログインが必要です");
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") msg = data.detail;
      else if (Array.isArray(data.detail)) msg = data.detail.map((d) => d.msg.replace(/^Value error, /, "")).join("\n");
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

const casesUrl = (pj) => `/cases?case=${encodeURIComponent(pj)}`;
// PJ名の表示: 案件番号なら案件名を自動で付ける（案件管理の案件名を参照するので、名前の変更も自動反映）
const pjText = (no) => (no && state.caseNames[no] ? `${no}｜${state.caseNames[no]}` : no);
// ※ caseNames には基盤名（基盤技術ページで設定）も入る

// PJ名の選択肢を「案件」「基盤」のグループで作る
function fillPjOptions(sel, value, emptyLabel) {
  sel.innerHTML = "";
  if (emptyLabel) sel.append(new Option(emptyLabel, "", false, !value));
  const groups = [["案件", state.pj.cases], ["基盤", state.pj.platforms]];
  if (value && !state.masters.projects.includes(value)) groups.push(["その他", [value]]);
  for (const [label, list] of groups) {
    if (!list.length) continue;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const v of list) g.append(new Option(pjText(v), v, false, v === value));
    sel.append(g);
  }
  sel.value = value || "";
}

function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), isErr ? 4000 : 2200);
}

// ------------------------------------------------------------ 色（領域ごと）
function areaColor(area) {
  let i = state.masters.areas.indexOf(area);
  if (i < 0) i = state.masters.areas.length;
  const hue = (210 + i * 67) % 360;
  return `hsl(${hue} 62% 50%)`;
}

// ------------------------------------------------------------ 表示範囲
function computeRange() {
  const today = todayMs();
  let min = today - 14 * DAY_MS;
  let max = today + 60 * DAY_MS;
  for (const t of state.tasks) {
    min = Math.min(min, parseDate(t.start_date) - 7 * DAY_MS);
    max = Math.max(max, parseDate(t.end_date) + 30 * DAY_MS);
  }
  const d = new Date(min);
  state.rangeStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); // 月初から
  state.days = Math.ceil((max - state.rangeStart) / DAY_MS) + 1;
}

function inRange(task) {
  const s = dayIndex(parseDate(task.start_date));
  const e = dayIndex(parseDate(task.end_date));
  return s >= 0 && e < state.days;
}

const NO_ASSIGNEE = "\u0000none"; // 担当者フィルターの「（未設定）」

// 表示対象: 領域・PJ・担当者で絞り込み、初期の並びは終了日（締切）の早い順
// 担当者（複数はスペース区切り）
const assigneesOf = (t) => (t.assignee ? t.assignee.split(" ") : []);
const assigneeText = (t) => assigneesOf(t).join("・");

const nameCollator = new Intl.Collator("ja");
// 初期の並び: 終了日（締切）の早い順 → 開始日 → 担当者（未設定は最後）→ 登録順
const byDue = (a, b) =>
  a.end_date.localeCompare(b.end_date) || a.start_date.localeCompare(b.start_date) ||
  (!a.assignee - !b.assignee) || nameCollator.compare(a.assignee, b.assignee) || a.id - b.id;

// 見出しクリックの並び替え: 1 回目 昇順 → 2 回目 降順 → 3 回目 初期の並び（終了日順）に戻る（ブラウザに記憶）
const SORT_COLS = {
  area: (t) => t.area,
  pj: (t) => t.project,
  task: (t) => t.task,
  assignee: (t) => assigneeText(t),
  priority: (t) => ({ 高: 1, 中: 2, 低: 3 })[t.priority] || 9,
  start: (t) => t.start_date,
  end: (t) => t.end_date,
};
const savedSort = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("gantt.sort") || "null");
    return v && SORT_COLS[v.key] ? v : null;
  } catch (_) { return null; }
})();
let taskSortState = savedSort; // 現在の並び { key, desc } または null（初期の並び = 終了日の早い順）
const currentSort = () => taskSortState || { key: "end", desc: false }; // 初期の並びは「終了日 ▲」
// 完了したタスクは、並び順に関係なく一番下に表示する
const doneLast = (list) => [...list.filter((t) => !t.completed_at), ...list.filter((t) => t.completed_at)];
const sortTasks = (list) => doneLast(sortTasksBase(list));
const sortTasksBase = (list) => {
  if (!taskSortState) return list.sort(byDue);
  const taskSort = taskSortState;
  const get = SORT_COLS[taskSort.key];
  const empty = (v) => v === "" || v === null || v === undefined;
  return list.sort((a, b) => {
    const va = get(a), vb = get(b);
    if (empty(va) !== empty(vb)) return empty(va) ? 1 : -1; // 空欄は常に最後
    const c = typeof va === "number" ? va - vb : nameCollator.compare(String(va), String(vb), "ja");
    return (taskSort.desc ? -c : c) || byDue(a, b);
  });
};
const setTaskSort = (key) => {
  const cur = currentSort();
  if (cur.key !== key) taskSortState = { key, desc: false };
  else if (!cur.desc) taskSortState = { key, desc: true };
  else taskSortState = null; // 初期の並び（終了日順）に戻る
  try {
    if (taskSortState) localStorage.setItem("gantt.sort", JSON.stringify(taskSortState));
    else localStorage.removeItem("gantt.sort");
  } catch (_) { /* 記憶できなくても並び替えは行う */ }
};

// キーワード検索（PJ名・案件名/基盤名・タスク名・担当者・領域）
const matchesQuery = (t) => {
  const q = state.q.trim().toLowerCase();
  return !q || [t.project, state.caseNames[t.project], t.task, t.assignee, t.area]
    .some((v) => (v || "").toLowerCase().includes(q));
};

const visibleTasks = () => sortTasks(state.tasks.filter((t) =>
  matchesQuery(t) &&
  (!state.filter.areas || t.area === state.filter.areas) &&
  (!state.filter.projects || t.project === state.filter.projects) &&
  (!state.filter.assignees ||
    (state.filter.assignees === NO_ASSIGNEE ? !t.assignee : assigneesOf(t).includes(state.filter.assignees)))
));

// 担当者の選択肢はタスクから集計する
function refreshAssigneeFilter() {
  // 担当者の絞り込みは右の「個人ごとのタスク状況」から行う。該当者がいなくなったら解除
  const cur = state.filter.assignees;
  const names = state.tasks.flatMap(assigneesOf);
  const valid = cur === "" || names.includes(cur) || (cur === NO_ASSIGNEE && state.tasks.some((t) => !t.assignee));
  state.filter.assignees = valid ? cur : "";
  const chip = $("#assignee-chip");
  chip.hidden = !state.filter.assignees;
  chip.textContent = `担当: ${state.filter.assignees === NO_ASSIGNEE ? NO_PERSON : state.filter.assignees} ✕`;
}

// ------------------------------------------------------------ 描画
function render() {
  refreshAssigneeFilter();
  renderSide();
  renderCalendar();
  computeRange();
  const trackW = state.days * state.dayW;
  gantt.classList.toggle("compact", state.compact);
  applyColWidths();
  gantt.innerHTML = "";

  gantt.append(renderHeader(trackW), renderBackground(trackW));

  const tasks = visibleTasks();
  if (!tasks.length) {
    const empty = el("div", "empty", "タスクがありません。「＋ タスク追加」で登録してください（まとめて登録するときは「バックアップ」画面の CSV インポート）。");
    gantt.append(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const t of tasks) frag.append(renderRow(t, trackW));
  gantt.append(frag);
}

// ------------------------------------------------------------ 個人ごとのタスク状況（右の折りたたみ窓）
function setAssigneeFilter(v) {
  state.filter.assignees = v;
  rerenderKeepScroll();
}
const NO_PERSON = "（担当者未設定）";
function renderSide() {
  const today = todayMs();
  const people = new Map();
  for (const t of state.tasks) {
    if (t.completed_at) continue; // 完了したタスクは数えない
    const left = Math.round((parseDate(t.end_date) - today) / DAY_MS);
    const kinds = [];
    if (left < 0) kinds.push("over");
    else if (left <= SOON_DAYS) kinds.push("soon");
    if (isActive(t)) kinds.push("act");
    if (!kinds.length && parseDate(t.start_date) > today) kinds.push("wait"); // 予定あり・実施前（開始日がまだ先）
    if (!kinds.length) continue;
    for (const p of assigneesOf(t).length ? assigneesOf(t) : [NO_PERSON]) {
      if (!people.has(p)) people.set(p, { over: 0, soon: 0, act: 0, wait: 0, tasks: [] });
      const e = people.get(p);
      for (const k of kinds) e[k]++;
      e.tasks.push({ t, left, kind: kinds.includes("over") ? "overdue" : kinds.includes("soon") ? "soon" : kinds.includes("act") ? "act" : "wait" });
    }
  }
  const list = $("#side-list");
  list.innerHTML = "";
  if (!people.size) return list.append(el("p", "hint", "該当するタスクはありません。"));
  const sorted = [...people].sort((a, b) => b[1].over - a[1].over || b[1].soon - a[1].soon || b[1].act - a[1].act || b[1].wait - a[1].wait || nameCollator.compare(a[0], b[0]));
  for (const [name, e] of sorted) {
    const box = el("div", "sp-person");
    const head = el("button", "sp-head");
    head.type = "button";
    head.append(el("span", "sp-name", name));
    for (const [k, cls] of [["wait", "c-wait"], ["act", "c-act"], ["soon", "c-soon"], ["over", "c-over"]])
      head.append(el("span", `sp-n ${e[k] ? cls : "zero"}`, String(e[k])));
    const key = name === NO_PERSON ? NO_ASSIGNEE : name;
    const on = state.filter.assignees === key;
    head.classList.toggle("on", on);
    head.title = `${name}: 予定（実施前） ${e.wait}・実施中 ${e.act}・3日以内 ${e.soon}・超過 ${e.over}（クリックでガントチャートを${on ? "全員表示に戻す" : "この人に絞る"}）`;
    head.addEventListener("click", () => setAssigneeFilter(on ? "" : key));
    box.append(head);
    list.append(box);
  }
}
const sideEl = $("#side");
const setSide = (open) => {
  sideEl.classList.toggle("collapsed", !open);
  $("#side-toggle").textContent = open ? "▶ 閉じる" : "◀ 個人別";
  try { localStorage.setItem("gantt.side", open ? "1" : "0"); } catch {}
};
$("#side-toggle").addEventListener("click", () => setSide(sideEl.classList.contains("collapsed")));
(() => { let v = "1"; try { v = localStorage.getItem("gantt.side") ?? "1"; } catch {} setSide(v === "1"); })();

function renderHeader(trackW) {
  const W = state.dayW;
  const row = el("div", "g-row g-head");
  const left = el("div", "g-left");
  const heads = [[""], ["PJ名"], ["タスク"], ["担当者", 1], ["優先度", 1], ["開始", 1], ["終了日", 1], [""]];
  heads.forEach(([h, detail], i) => {
    const cell = el("div", detail ? "col-detail" : "", h);
    const key = [null, "pj", "task", "assignee", null, null, "end"][i] || null;
    // 見出しをクリックで並び替え（▲昇順 ▼降順。3 回目で初期の並びに戻る）
    const sortKey = [null, "pj", "task", "assignee", "priority", "start", "end"][i] || null;
    if (sortKey) {
      cell.classList.add("sortable");
      cell.title = "クリックで並び替え（もう一度で逆順、3 回目で元の並び＝終了日順）";
      const cur = currentSort();
      if (cur.key === sortKey) {
        cell.classList.add("sorted");
        cell.append(el("span", "sort-mark", cur.desc ? " ▼" : " ▲"));
      }
      cell.addEventListener("click", () => { setTaskSort(sortKey); render(); });
    }
    if (key) {
      cell.classList.add("resizable");
      const handle = el("span", "col-resizer");
      handle.title = "ドラッグで列幅を変更（ダブルクリックで元の幅）";
      handle.addEventListener("pointerdown", (e) => startColResize(e, key));
      handle.addEventListener("click", (e) => e.stopPropagation()); // 並び替えにしない
      handle.addEventListener("dblclick", () => {
        colW[key] = COL_W_DEFAULT[key];
        applyColWidths();
        saveColW();
      });
      cell.append(handle);
    }
    left.append(cell);
  });

  const track = el("div", "g-track");
  track.style.width = `${trackW}px`;

  const today = todayMs();
  let monthStart = 0;
  for (let i = 0; i <= state.days; i++) {
    const ms = state.rangeStart + i * DAY_MS;
    const d = new Date(ms);
    // 月ラベル
    if (i === state.days || (d.getUTCDate() === 1 && i > 0)) {
      addMonth(track, monthStart, i);
      monthStart = i;
    }
    if (i === state.days) break;

    const dow = d.getUTCDay();
    if (W >= 20) {
      const day = el("div", "tl-day", String(d.getUTCDate()));
      day.title = `${fmtDate(ms)} (${WEEKDAYS[dow]})`;
      if (dow === 0 || dow === 6) day.classList.add("weekend");
      if (ms === today) day.classList.add("today");
      pos(day, i * W, W);
      track.append(day);
    } else if (W >= 10 && dow === 1) {
      const wk = el("div", "tl-day", `${d.getUTCMonth() + 1}/${d.getUTCDate()}`);
      pos(wk, i * W, 7 * W);
      wk.style.justifyContent = "flex-start";
      wk.style.paddingLeft = "3px";
      track.append(wk);
    }
  }
  row.append(left, track);
  return row;
}

function addMonth(track, from, to) {
  const d = new Date(state.rangeStart + from * DAY_MS);
  const label = el("div", "tl-month", `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`);
  pos(label, from * state.dayW, (to - from) * state.dayW);
  track.append(label);
}

function renderBackground(trackW) {
  const W = state.dayW;
  const layer = el("div", "bg-layer");
  layer.style.left = `${leftW()}px`;
  layer.style.width = `${trackW}px`;
  for (let i = 0; i < state.days; i++) {
    const d = new Date(state.rangeStart + i * DAY_MS);
    const dow = d.getUTCDay();
    const weekend = W >= 10 && (dow === 0 || dow === 6);
    const monthStart = d.getUTCDate() === 1;
    if (!weekend && !monthStart) continue;
    const col = el("div", "bg-col");
    if (weekend) col.classList.add("weekend");
    if (monthStart) col.classList.add("month-start");
    pos(col, i * W, W);
    layer.append(col);
  }
  const t = dayIndex(todayMs());
  if (t >= 0 && t < state.days) {
    const line = el("div", "today-line");
    line.style.left = `${t * W + W / 2 - 1}px`;
    layer.append(line);
  }
  return layer;
}

const doneDeleteLabel = (t) => {
  const d = new Date(t.completed_at.replace(" ", "T"));
  d.setDate(d.getDate() + 7);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
async function toggleDone(task) {
  const done = !task.completed_at;
  try {
    const saved = await api(`/api/tasks/${task.id}/done`, { method: "POST", body: JSON.stringify({ done }) });
    task.completed_at = saved.completed_at;
    toast(done ? "完了にしました（一番下に移ります。1 週間後に自動で削除されます。ガントチャート履歴には残ります）" : "完了を取り消しました");
    rerenderKeepScroll();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderRow(task, trackW) {
  const row = el("div", "g-row");
  row.dataset.id = task.id;
  row.style.setProperty("--area-color", areaColor(task.area));

  const left = el("div", "g-left");

  // 領域・PJ名は表示のみ（修正はタスク詳細で行う。クリックで詳細を開く）
  const areaCell = el("div", "area-chip");
  const areaText = el("button", "ro-cell");
  areaText.type = "button";
  areaText.dataset.field = "area";
  areaText.addEventListener("click", () => openTaskDialog(task));
  areaCell.append(areaText);

  const projCell = el("div", "proj-cell");
  const projText = el("button", "ro-cell");
  projText.type = "button";
  projText.dataset.field = "project";
  projText.addEventListener("click", () => openTaskDialog(task));
  projCell.append(projText);

  const name = el("button", "task-cell");
  name.type = "button";
  name.dataset.field = "task";
  name.addEventListener("click", () => openTaskDialog(task));
  syncTaskCell(name, task);
  // 担当者も表示のみ（修正はタスク詳細で）
  const assignee = el("button", "ro-cell");
  assignee.type = "button";
  assignee.dataset.field = "assignee";
  assignee.addEventListener("click", () => openTaskDialog(task));
  syncReadonlyCells(row, task, areaText, projText, assignee);

  // 優先度も表示のみ（修正はクリックしてタスク詳細で）
  const prio = el("button", "ro-cell prio");
  prio.type = "button";
  prio.dataset.field = "priority";
  prio.addEventListener("click", () => openTaskDialog(task));
  syncPrioCell(prio, task);

  const start = dateCell(task, row, "start_date");
  const end = dateCell(task, row, "end_date");
  for (const e of [assignee, prio]) e.classList.add("col-detail");

  const del = el("button", "del", "🗑");
  del.title = "削除";
  del.addEventListener("click", () => deleteTask(task));

  // 完了ボタン: 完了にするとグレーアウトして一番下へ。1 週間後に自動で削除（もう一度押すと完了を取り消す）
  const done = el("button", "done-btn", task.completed_at ? "↩" : "✓");
  done.type = "button";
  done.title = task.completed_at
    ? `完了を取り消す（完了 ${task.completed_at.slice(0, 16)}。${doneDeleteLabel(task)}に自動で削除）`
    : "完了にする（グレーアウトして一番下へ。1 週間後に自動で削除）";
  done.addEventListener("click", () => toggleDone(task));
  const tail = el("div", "row-actions");
  tail.append(done, del);
  row.classList.toggle("done", !!task.completed_at);

  left.append(areaCell, projCell, name, assignee, prio, start, end, tail);

  const track = el("div", "g-track");
  track.style.width = `${trackW}px`;
  track.append(renderBar(task));

  row.append(left, track);
  return row;
}

// 開始日はカレンダーアイコンのみ、終了日は日付を表示。クリックでカレンダーを開く。
const CAL_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="12" rx="2" fill="none" stroke="currentColor"/><path d="M1.5 6h13M5 1v3M11 1v3" stroke="currentColor" fill="none"/></svg>`;

function dateCell(task, row, name) {
  const cell = el("div", "date-cell col-detail");
  cell.dataset.cell = name;
  const btn = el("button", name === "end_date" ? "cal cal-text" : "cal");
  btn.type = "button";
  if (name === "start_date") btn.innerHTML = CAL_ICON;
  const inp = input("date", task[name], name, (v) => { if (v) saveField(task, row, name, v); else inp.value = task[name]; });
  inp.tabIndex = -1;
  btn.addEventListener("click", () => {
    try { inp.showPicker(); } catch (_) { inp.focus(); inp.click(); }
  });
  cell.append(btn, inp);
  syncDateCell(cell, task, name);
  return cell;
}

function syncDateCell(cell, task, name) {
  const label = name === "start_date" ? "開始日" : "終了日";
  cell.title = `${label}: ${task[name]}（クリックで変更）`;
  cell.dataset.status = name === "end_date" ? deadlineStatus(task) : "";
  if (name === "end_date") $(".cal", cell).textContent = shortDate(task.end_date);
}

// 幅を抑えた日付表示: 今年なら 10/05(月)、それ以外は 2027/01/05
function shortDate(str) {
  const d = new Date(parseDate(str));
  const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  return d.getUTCFullYear() === new Date().getFullYear()
    ? `${md}(${WEEKDAYS[d.getUTCDay()]})`
    : `${d.getUTCFullYear()}/${md}`;
}

// 期限状態: overdue = 終了日を過ぎた / soon = 終了日まで 3 日以内
function deadlineStatus(task) {
  if (task.completed_at) return ""; // 完了したタスクは期限の色をつけない
  const left = Math.round((parseDate(task.end_date) - todayMs()) / DAY_MS);
  if (left < 0) return "overdue";
  if (left <= SOON_DAYS) return "soon";
  return "";
}

// 表のセル（表示のみ）: 領域・PJ名・担当者
function syncReadonlyCells(row, task, areaCell, projCell, assigneeCell) {
  assigneeCell.textContent = assigneeText(task) || "—";
  assigneeCell.classList.toggle("empty", !task.assignee);
  assigneeCell.title = `担当者: ${assigneeText(task) || "未設定"}（修正はクリックしてタスク詳細で）`;
  areaCell.textContent = task.area;
  areaCell.parentElement.title = `領域: ${task.area}`;
  projCell.textContent = pjText(task.project) || "—";
  projCell.classList.toggle("empty", !task.project);
  projCell.title = `PJ名: ${pjText(task.project) || "なし"}（修正はクリックしてタスク詳細で）`;
}

// 実施中 = 今日が開始日〜終了日の間（期限超過・3 日以内の色を優先）
const isActive = (task) => !task.completed_at && parseDate(task.start_date) <= todayMs() && todayMs() <= parseDate(task.end_date);

function syncPrioCell(cell, task) {
  cell.textContent = task.priority;
  cell.dataset.v = task.priority;
  cell.title = `優先度: ${task.priority}（修正はクリックしてタスク詳細で）`;
}

function syncTaskCell(cell, task) {
  cell.innerHTML = "";
  cell.append(el("span", "t-name", task.task));
  if (task.detail) cell.append(el("span", "t-has-detail", "詳細"));
  cell.dataset.status = deadlineStatus(task) || (isActive(task) ? "active" : "");
  cell.title = `${task.task}（クリックで詳細）${task.detail ? "\n\n" + snippet(task.detail) : ""}`;
}

const snippet = (text, n = 200) => (text.length > n ? text.slice(0, n) + "…" : text);

function renderBar(task) {
  const bar = el("div", "bar");
  bar.innerHTML = `<span class="handle l"></span><span class="label"></span><span class="bar-tip"></span><span class="handle r"></span>`;
  placeBar(bar, task.start_date, task.end_date);
  updateBarText(bar, task);
  bar.addEventListener("pointerdown", (e) => startDrag(e, bar, task));
  return bar;
}

function updateBarText(bar, task) {
  const label = $(".label", bar);
  label.innerHTML = "";
  const dot = el("span", "prio-dot");
  dot.style.background = PRIO_COLOR[task.priority];
  label.append(dot, document.createTextNode(task.task));
  $(".bar-tip", bar).textContent = [pjText(task.project), assigneeText(task)].filter(Boolean).join(" / ");
  const status = deadlineStatus(task);
  const note = status === "overdue" ? "【期限超過】\n" : status === "soon" ? "【期限まで3日以内】\n" : "";
  bar.title = `${note}${task.task}\n領域: ${task.area} / PJ: ${pjText(task.project) || "-"}\n担当: ${assigneeText(task) || "-"} / 優先度: ${task.priority}\n${task.start_date} 〜 ${task.end_date}${task.detail ? "\n\n" + snippet(task.detail) : ""}`;
}

function placeBar(bar, startStr, endStr) {
  const s = dayIndex(parseDate(startStr));
  const e = dayIndex(parseDate(endStr));
  pos(bar, s * state.dayW + 1, (e - s + 1) * state.dayW - 2);
}

// ------------------------------------------------------------ 小さなヘルパー
function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function pos(e, left, width) {
  e.style.left = `${left}px`;
  e.style.width = `${width}px`;
}
function input(type, value, field, onChange) {
  const inp = document.createElement("input");
  inp.type = type;
  inp.value = value;
  inp.dataset.field = field;
  inp.addEventListener("change", () => onChange(inp.value, inp));
  if (type === "text") inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) inp.blur(); });
  return inp;
}
const field = (row, name) => $(`[data-field="${name}"]`, row);

// ------------------------------------------------------------ 保存
async function saveTask(task, patch) {
  const body = { ...task, ...patch };
  delete body.id;
  const updated = await api(`/api/tasks/${task.id}`, { method: "PUT", body: JSON.stringify(body) });
  Object.assign(task, updated);
  return task;
}

async function saveField(task, row, name, value) {
  const prev = { ...task };
  try {
    await saveTask(task, { [name]: value });
    refreshRow(task, row);
    toast("保存しました");
  } catch (err) {
    Object.assign(task, prev);
    refreshRow(task, row);
    toast(err.message, true);
  }
}

// 行を部分更新（フォーカスを保ったまま）。
// 表示範囲外・フィルター外になった、並び順（終了日順）や担当者の選択肢が変わった場合は全体を再描画。
function refreshRow(task, row) {
  const list = visibleTasks();
  const rows = gantt.querySelectorAll(".g-row[data-id]");
  const orderChanged = rows.length !== list.length || rows[list.indexOf(task)] !== row;
  const known = new Set(state.tasks.filter((t) => t !== task).flatMap(assigneesOf));
  const newAssignee = assigneesOf(task).some((n) => !known.has(n));
  if (!inRange(task) || !list.includes(task) || orderChanged || newAssignee) return rerenderKeepScroll();
  row.style.setProperty("--area-color", areaColor(task.area));
  for (const name of ["start_date", "end_date"]) {
    field(row, name).value = task[name];
  }
  syncReadonlyCells(row, task, field(row, "area"), field(row, "project"), field(row, "assignee"));
  syncTaskCell(field(row, "task"), task);
  syncPrioCell(field(row, "priority"), task);
  for (const name of ["start_date", "end_date"]) syncDateCell($(`[data-cell="${name}"]`, row), task, name);
  const bar = $(".bar", row);
  placeBar(bar, task.start_date, task.end_date);
  updateBarText(bar, task);
}

function centerDate() {
  return state.rangeStart + ((scroller.scrollLeft + (scroller.clientWidth - leftW()) / 2) / state.dayW) * DAY_MS;
}

function rerenderKeepScroll() {
  const c = centerDate();
  const top = scroller.scrollTop;
  render();
  scrollToDate(c, true);
  scroller.scrollTop = top;
}

// 誤削除防止: 本日の日付（8 桁、例 20260927）を入力しないと削除ボタンが押せない
let deleting = null;
const todayDigits = () => fmtDate(todayMs()).replaceAll("-", "");
const digitsOf = (v) => v.normalize("NFKC").replace(/\D/g, ""); // 全角数字・区切り文字も許容

function deleteTask(task) {
  deleting = task;
  const f = $("#form-delete");
  f.reset();
  $("#delete-name").textContent = todayDigits();
  $("#delete-summary").textContent =
    `領域: ${task.area}　PJ: ${task.project || "-"}\nタスク: ${task.task}　担当: ${task.assignee || "-"}\n期間: ${task.start_date} 〜 ${task.end_date}`;
  $("#delete-error").textContent = "";
  f.querySelector("button[type=submit]").disabled = true;
  $("#dlg-delete").showModal();
  f.confirm.focus();
}

$("#form-delete").confirm.addEventListener("input", (e) => {
  $("#form-delete button[type=submit]").disabled = !deleting || digitsOf(e.target.value) !== todayDigits();
});

$("#form-delete").addEventListener("submit", async (e) => {
  e.preventDefault();
  const task = deleting;
  const typed = digitsOf(e.target.confirm.value);
  if (!task || typed !== todayDigits()) return;
  try {
    await api(`/api/tasks/${task.id}?confirm=${encodeURIComponent(typed)}`, { method: "DELETE" });
    $("#dlg-delete").close();
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
    rerenderKeepScroll();
    toast(`「${task.task}」を削除しました`);
  } catch (err) {
    $("#delete-error").textContent = err.message;
  }
});

// ------------------------------------------------------------ ドラッグで期間を修正
function startDrag(e, bar, task) {
  if (e.button !== 0) return;
  e.preventDefault();
  const mode = e.target.classList.contains("l") ? "left" : e.target.classList.contains("r") ? "right" : "move";
  const s0 = parseDate(task.start_date);
  const e0 = parseDate(task.end_date);
  const x0 = e.clientX;
  let ns = s0;
  let ne = e0;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add("dragging");

  const row = bar.closest(".g-row");
  const startInp = field(row, "start_date");
  const endInp = field(row, "end_date");

  const onMove = (ev) => {
    const dd = Math.round((ev.clientX - x0) / state.dayW) * DAY_MS;
    if (mode === "move") { ns = s0 + dd; ne = e0 + dd; }
    else if (mode === "left") { ns = Math.min(s0 + dd, e0); ne = e0; }
    else { ns = s0; ne = Math.max(e0 + dd, s0); }
    placeBar(bar, fmtDate(ns), fmtDate(ne));
    startInp.value = fmtDate(ns);
    endInp.value = fmtDate(ne);
    $('[data-cell="end_date"] .cal', row).textContent = shortDate(fmtDate(ne));
  };
  const onUp = async () => {
    bar.removeEventListener("pointermove", onMove);
    bar.removeEventListener("pointerup", onUp);
    bar.removeEventListener("pointercancel", onUp);
    bar.classList.remove("dragging");
    if (ns === s0 && ne === e0) return;
    const prev = { ...task };
    try {
      await saveTask(task, { start_date: fmtDate(ns), end_date: fmtDate(ne) });
      toast(`${task.start_date} 〜 ${task.end_date} に変更しました`);
    } catch (err) {
      Object.assign(task, prev);
      toast(err.message, true);
    }
    refreshRow(task, row);
  };
  bar.addEventListener("pointermove", onMove);
  bar.addEventListener("pointerup", onUp);
  bar.addEventListener("pointercancel", onUp);
}

// ------------------------------------------------------------ スクロール
function scrollToDate(ms, center = false) {
  const x = ((ms - state.rangeStart) / DAY_MS) * state.dayW;
  const visible = scroller.clientWidth - leftW();
  scroller.scrollLeft = Math.max(0, center ? x - visible / 2 : x - state.dayW * 5); // 初期表示は日付の 5 日前が左端
}

// ------------------------------------------------------------ データ読み込み
async function loadMasters() {
  const [areas, caseNos, platforms, cases, platformInfo] = await Promise.all(
    [api("/api/masters/areas"), api("/api/masters/case_nos"), api("/api/masters/platforms"), api("/api/cases"),
      api("/api/platforms")]);
  state.pj = { cases: caseNos, platforms };
  state.masters = { areas, projects: [...caseNos, ...platforms] };
  // PJ名に自動で付ける名前: 案件なら案件名、基盤なら基盤名
  state.caseNames = Object.fromEntries([
    ...cases.map((c) => [c.case_no, c.name]),
    ...platformInfo.filter((p) => p.title).map((p) => [p.name, p.title]),
  ]);

  const fa = $("#filter-areas");
  fa.innerHTML = "";
  fa.append(new Option("すべて", ""));
  for (const v of areas) fa.append(new Option(v, v));
  if (!areas.includes(state.filter.areas)) state.filter.areas = "";
  fa.value = state.filter.areas;

  if (!state.masters.projects.includes(state.filter.projects)) state.filter.projects = "";
  fillPjOptions($("#filter-projects"), state.filter.projects, "すべて");
}

async function loadTasks() {
  state.tasks = await api("/api/tasks");
}

async function reloadAll() {
  await Promise.all([loadMasters(), loadTasks()]);
  rerenderKeepScroll();
}

// ------------------------------------------------------------ ダイアログ
document.querySelectorAll("dialog [data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close()));

function fillSelect(sel, values, allowEmpty) {
  sel.innerHTML = "";
  if (allowEmpty) sel.append(new Option("（なし）", ""));
  for (const v of values) sel.append(new Option(v, v));
}

// タスク追加 / 詳細（同じダイアログを使う。task が null なら新規追加）
let editing = null;

function openTaskDialog(task = null) {
  editing = task;
  const form = $("#form-task");
  form.reset();
  const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v] : list);
  fillSelect(form.area, withCurrent(state.masters.areas, task?.area), false);
  fillPjOptions(form.project, task?.project || "", "（なし）");
  const meta = $("#task-meta");
  if (task) {
    $("#task-copy").hidden = false;
    $("#task-title").textContent = "タスク詳細";
    $("#task-submit").textContent = "保存";
    for (const k of ["area", "project", "task", "assignee", "priority", "start_date", "end_date", "detail"]) {
      form[k].value = task[k] ?? "";
    }
    const st = deadlineStatus(task);
    const days = Math.round((parseDate(task.end_date) - todayMs()) / DAY_MS);
    meta.innerHTML = "";
    meta.append(`ID: ${task.id}　`);
    const s = el("span", st ? `st-${st}` : "",
      days < 0 ? `期限超過（${-days} 日経過）` : days === 0 ? "本日が期限" : `期限まであと ${days} 日`);
    meta.append(s);
    meta.hidden = false;
  } else {
    $("#task-copy").hidden = true;
    $("#task-title").textContent = "タスク追加";
    $("#task-submit").textContent = "追加";
    meta.hidden = true;
    // 領域: 絞り込み中ならその領域、案件管理から来たときはその案件の領域
    if (state.filter.areas) form.area.value = state.filter.areas;
    else if (state.defaultArea && state.masters.areas.includes(state.defaultArea)) form.area.value = state.defaultArea;
    if (state.filter.projects) form.project.value = state.filter.projects;
    if (state.filter.assignees && state.filter.assignees !== NO_ASSIGNEE) form.assignee.value = state.filter.assignees;
    const t = todayMs();
    form.start_date.value = fmtDate(t);
    form.end_date.value = fmtDate(t + 6 * DAY_MS);
  }
  $("#task-error").textContent = "";
  syncTaskPjLink();
  $("#dlg-task").showModal();
  (task ? form.detail : form.task).focus();
}

$("#btn-add").addEventListener("click", () => openTaskDialog());

$("#form-task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    area: f.area.value,
    project: f.project.value,
    task: f.task.value.trim(),
    assignee: f.assignee.value.trim(),
    priority: f.priority.value,
    start_date: f.start_date.value,
    end_date: f.end_date.value,
    detail: f.detail.value.trim(),
  };
  if (!body.task) {
    $("#task-error").textContent = "タスク名を入力してください";
    return;
  }
  if (!body.area) {
    $("#task-error").textContent = "領域を選択してください（「領域の管理」で追加できます）";
    return;
  }
  if (body.end_date < body.start_date) {
    $("#task-error").textContent = "終了日は開始日以降にしてください";
    return;
  }
  if (editing) {
    try {
      await saveTask(editing, body);
      $("#dlg-task").close();
      rerenderKeepScroll();
      toast("保存しました");
    } catch (err) {
      $("#task-error").textContent = err.message;
    }
    return;
  }
  try {
    const created = await api("/api/tasks", { method: "POST", body: JSON.stringify(body) });
    $("#dlg-task").close();
    await loadTasks();
    render();
    scrollToDate(parseDate(created.start_date));
    const row = gantt.querySelector(`.g-row[data-id="${created.id}"]`);
    if (row) {
      scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 2);
      row.animate([{ background: "#fff4c2" }, { background: "transparent" }], { duration: 1500 });
    }
    toast("タスクを追加しました");
  } catch (err) {
    $("#task-error").textContent = err.message;
  }
});

// フィルター・検索・ズーム・今日へ・列の折りたたみ
for (const kind of ["areas", "projects"]) {
  $(`#filter-${kind}`).addEventListener("change", (e) => {
    state.filter[kind] = e.target.value;
    syncPjActions();
    rerenderKeepScroll();
  });
}
$("#assignee-chip").addEventListener("click", () => setAssigneeFilter(""));
$("#q").addEventListener("input", (e) => {
  state.q = e.target.value;
  rerenderKeepScroll();
});

let backCase = null; // 案件管理から来たときの戻り先 { pj, id }

// タスク詳細: 内容とリンクをコピー（保存済みの内容。リンクはこのタスクを開くガントチャート /?task=番号）
$("#task-copy").addEventListener("click", async () => {
  const t = editing;
  if (!t) return;
  const left = Math.round((parseDate(t.end_date) - todayMs()) / DAY_MS);
  const rest = left < 0 ? `${-left} 日超過` : left === 0 ? "今日まで" : `あと ${left} 日`;
  const url = `${location.origin}/?${new URLSearchParams({ ...(t.project ? { pj: t.project } : {}), task: t.id })}`;
  const text = [
    `【タスク】${t.task}`,
    t.project ? `PJ名：${pjText(t.project)}` : "",
    `担当：${assigneeText(t) || "未設定"}　優先度：${t.priority}　領域：${t.area}`,
    `期間：${t.start_date.replaceAll("-", "/")} 〜 ${t.end_date.replaceAll("-", "/")}（${rest}）`,
    t.detail ? `詳細：${t.detail}` : "",
    `リンク：${url}`,
  ].filter(Boolean).join("\n");
  if (await copyText(text)) toast("タスクの内容とリンクをコピーしました");
});

// ツールバー: PJ を選んだら「← 案件に戻る」（青）/「← 基盤に戻る」（緑）を出す
function syncPjActions() {
  const pj = state.filter.projects;
  // 案件なら案件管理、基盤なら基盤技術ページへ
  const isCase = !!pj && state.pj.cases.includes(pj);
  const isPlatform = !!pj && state.pj.platforms.includes(pj);
  $("#pj-actions").hidden = !isCase && !isPlatform;
  const a = $("#pj-jump");
  if (isCase) {
    // 案件管理から来たとき（?back=案件の id）は、その案件に戻る。PJ名を変えたら番号で開く
    a.href = backCase && backCase.pj === pj ? `/cases?id=${backCase.id}` : casesUrl(pj);
    a.textContent = "← 案件に戻る";
    a.title = `案件管理の ${pj} に戻る（同じ画面のまま）`;
    a.className = "button back-btn to-case";
  } else if (isPlatform) {
    a.href = `/platforms?id=${encodeURIComponent(pj)}`;
    a.textContent = "← 基盤に戻る";
    a.title = `基盤技術の ${pj} に戻る（同じ画面のまま）`;
    a.className = "button back-btn to-platform";
  }
}

// タスク詳細: PJ名から案件管理・基盤技術へ移動
// PJ名のリンク先: 案件番号なら案件管理、基盤番号なら基盤技術
function pjUrl(pj) {
  if (state.pj.cases.includes(pj)) return { href: casesUrl(pj), label: "案件管理で開く" };
  if (state.pj.platforms.includes(pj)) return { href: `/platforms?id=${encodeURIComponent(pj)}`, label: "基盤技術で開く" };
  return null;
}

function syncTaskPjLink() {
  const target = pjUrl($("#form-task").project.value);
  const a = $("#t-pj-link");
  a.hidden = !target;
  if (target) {
    a.href = target.href;
    a.title = target.label;
  }
}
$("#form-task").project.addEventListener("change", syncTaskPjLink);
$("#zoom").addEventListener("change", (e) => {
  const c = centerDate();
  state.dayW = Number(e.target.value);
  render();
  scrollToDate(c, true);
});
$("#btn-today").addEventListener("click", () => {
  if (cal.on) { const t = new Date(); cal.y = t.getFullYear(); cal.m = t.getMonth(); renderCalendar(); return; }
  scrollToDate(todayMs(), true);
});
$("#btn-compact").addEventListener("click", (e) => {
  const c = centerDate();
  state.compact = !state.compact;
  e.target.textContent = state.compact ? "展開" : "折り畳み";
  e.target.title = state.compact ? "折りたたんだ列を元に戻す" : "担当者・優先度・日付の列を折りたたむ";
  render();
  // 折りたたんだときは、今日の 5 日前がガントチャートの左端（始まり）になるようにする
  if (state.compact) scroller.scrollLeft = Math.max(0, ((todayMs() - 5 * DAY_MS - state.rangeStart) / DAY_MS) * state.dayW);
  else scrollToDate(c, true);
});


// ------------------------------------------------------------ カレンダー表示（月）
// 今の絞り込み（領域・PJ名・担当者・検索）に合うタスクを、期間のバーで月カレンダーに表示。バーをクリックでタスク詳細
const cal = { on: false, y: new Date().getFullYear(), m: new Date().getMonth() };
function renderCalendar() {
  const box = $("#calendar");
  box.hidden = !cal.on;
  scroller.hidden = cal.on;
  if (!cal.on) return;
  box.innerHTML = "";
  const head = el("div", "cal-head");
  const prev = el("button", "", "◀");
  const next = el("button", "", "▶");
  const now = el("button", "", "今月");
  const step = (d) => { const t = new Date(cal.y, cal.m + d, 1); cal.y = t.getFullYear(); cal.m = t.getMonth(); renderCalendar(); };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  now.addEventListener("click", () => { const t = new Date(); cal.y = t.getFullYear(); cal.m = t.getMonth(); renderCalendar(); });
  const n2 = new Date(cal.y, cal.m + 1, 1);
  head.append(prev, el("b", "cal-title", `${cal.y}年${cal.m + 1}月 〜 ${n2.getFullYear() !== cal.y ? `${n2.getFullYear()}年` : ""}${n2.getMonth() + 1}月`), next, now,
    el("span", "hint", "バーをクリックでタスクの詳細（上の絞り込みが反映されます）"));
  const copy = el("button", "cal-copy", "📋 カレンダーをコピー");
  copy.type = "button";
  copy.title = "この 2 か月のカレンダーだけを画像としてコピー（メール・Teams・資料に貼れる）";
  copy.addEventListener("click", copyCalendar);
  head.append(el("span", "spacer"), copy);
  box.append(head);
  const months = el("div", "cal-months"); // 2 か月を左右に並べる
  const tasks = visibleTasks();
  const n = new Date(cal.y, cal.m + 1, 1);
  months.append(calMonth(cal.y, cal.m, tasks), calMonth(n.getFullYear(), n.getMonth(), tasks));
  box.append(months);
}
function calMonth(y, m, tasks) {
  const blk = el("div", "cal-month");
  blk.append(el("div", "cal-mtitle", `${y}年${m + 1}月`));
  const wd = el("div", "cal-wd");
  WEEKDAYS.forEach((w, i) => wd.append(el("span", i === 0 ? "sun" : i === 6 ? "sat" : "", w)));
  blk.append(wd);


  const first = Date.UTC(y, m, 1);
  const last = Date.UTC(y, m + 1, 0);
  const start = first - new Date(first).getUTCDay() * DAY_MS; // 月の最初の週の日曜日
  const today = todayMs();
  const weeks = el("div", "cal-weeks");
  for (let ws = start; ws <= last; ws += 7 * DAY_MS) {
    const we = ws + 6 * DAY_MS;
    const inWeek = tasks
      .filter((t) => parseDate(t.start_date) <= we && parseDate(t.end_date) >= ws)
      .sort((x, y) => parseDate(x.start_date) - parseDate(y.start_date) || parseDate(x.end_date) - parseDate(y.end_date));
    const laneEnd = []; // レーンごとの最後の列
    const placed = inWeek.map((t) => {
      const s = Math.max(0, Math.round((parseDate(t.start_date) - ws) / DAY_MS));
      const e = Math.min(6, Math.round((parseDate(t.end_date) - ws) / DAY_MS));
      let lane = laneEnd.findIndex((x) => x < s);
      if (lane < 0) lane = laneEnd.length;
      laneEnd[lane] = e;
      return { t, s, e, lane };
    });
    const week = el("div", "cal-week");
    week.style.gridTemplateRows = `24px repeat(${Math.max(laneEnd.length, 1)}, 24px)`;
    for (let i = 0; i < 7; i++) {
      const d = ws + i * DAY_MS;
      const dt = new Date(d);
      const cell = el("div", "cal-day", String(dt.getUTCDate() === 1 ? `${dt.getUTCMonth() + 1}/1` : dt.getUTCDate()));
      cell.style.gridColumn = String(i + 1);
      cell.style.gridRow = `1 / span ${Math.max(laneEnd.length, 1) + 1}`;
      if (dt.getUTCMonth() !== m) cell.classList.add("other");
      if (i === 0) cell.classList.add("sun");
      if (i === 6) cell.classList.add("sat");
      if (d === today) cell.classList.add("today");
      week.append(cell);
    }
    for (const { t, s, e, lane } of placed) {
      const bar = el("button", "cal-bar");
      bar.type = "button";
      bar.style.gridColumn = `${s + 1} / ${e + 2}`;
      bar.style.gridRow = String(lane + 2);
      bar.style.setProperty("--c", areaColor(t.area));
      const st = deadlineStatus(t);
      if (st) bar.classList.add(st);
      if (t.completed_at) bar.classList.add("done");
      if (parseDate(t.start_date) < ws) bar.classList.add("cont-l");
      if (parseDate(t.end_date) > we) bar.classList.add("cont-r");
      bar.textContent = `${t.task}${t.assignee ? `（${assigneeText(t)}）` : ""}`;
      bar.title = `${t.task}\n${pjText(t.project) || "PJ名なし"}\n担当: ${assigneeText(t) || "未設定"}\n${t.start_date} 〜 ${t.end_date}`;
      bar.addEventListener("click", () => openTaskDialog(t));
      week.append(bar);
    }
    weeks.append(week);
  }
  blk.append(weeks);
  return blk;
}

// カレンダー部分だけを画像（PNG）としてコピー。クリップボードが使えない環境（http のアクセスなど）ではファイルとして保存
function calendarCanvas() {
  const tasks = visibleTasks();
  const SC = 2, W = 1500, PAD = 16, GAP = 24;
  const monthW = (W - PAD * 2 - GAP) / 2, cell = monthW / 7;
  const font = (px, bold) => `${bold ? "700 " : ""}${px}px -apple-system, "Hiragino Sans", "Yu Gothic UI", Meiryo, "Noto Sans JP", sans-serif`;
  const n = new Date(cal.y, cal.m + 1, 1);
  const months = [[cal.y, cal.m], [n.getFullYear(), n.getMonth()]];
  const today = todayMs();
  // 週ごとの配置（画面のカレンダーと同じ並べ方）
  const layout = months.map(([y, m]) => {
    const first = Date.UTC(y, m, 1), last = Date.UTC(y, m + 1, 0);
    const weeks = [];
    for (let ws = first - new Date(first).getUTCDay() * DAY_MS; ws <= last; ws += 7 * DAY_MS) {
      const we = ws + 6 * DAY_MS;
      const laneEnd = [];
      const placed = tasks
        .filter((t) => parseDate(t.start_date) <= we && parseDate(t.end_date) >= ws)
        .sort((p, q) => parseDate(p.start_date) - parseDate(q.start_date) || parseDate(p.end_date) - parseDate(q.end_date))
        .map((t) => {
          const s = Math.max(0, Math.round((parseDate(t.start_date) - ws) / DAY_MS));
          const e = Math.min(6, Math.round((parseDate(t.end_date) - ws) / DAY_MS));
          let lane = laneEnd.findIndex((x) => x < s);
          if (lane < 0) lane = laneEnd.length;
          laneEnd[lane] = e;
          return { t, s, e, lane, cl: parseDate(t.start_date) < ws, cr: parseDate(t.end_date) > we };
        });
      weeks.push({ ws, placed, h: Math.max(cell, 24 + Math.max(laneEnd.length, 1) * 24 + 4) });
    }
    return { y, m, weeks };
  });
  const TOP = 40, HEAD = 22 + 26;
  const monthH = (mo) => HEAD + mo.weeks.reduce((s, w) => s + w.h, 0);
  const H = TOP + Math.max(...layout.map(monthH)) + PAD;
  const cv = document.createElement("canvas");
  cv.width = W * SC;
  cv.height = H * SC;
  const c = cv.getContext("2d");
  c.scale(SC, SC);
  c.fillStyle = "#fff";
  c.fillRect(0, 0, W, H);
  c.textBaseline = "middle";
  c.fillStyle = "#1f2430";
  c.font = font(18, true);
  c.fillText(`${cal.y}年${cal.m + 1}月 〜 ${n.getFullYear() !== cal.y ? `${n.getFullYear()}年` : ""}${n.getMonth() + 1}月`, PAD, 22);
  const fit = (text, maxW) => {
    if (c.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 1 && c.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  };
  layout.forEach((mo, mi) => {
    const x0 = PAD + mi * (monthW + GAP);
    let y = TOP;
    c.fillStyle = "#1f2430";
    c.font = font(14, true);
    c.fillText(`${mo.y}年${mo.m + 1}月`, x0, y + 10);
    y += 26;
    c.font = font(12);
    WEEKDAYS.forEach((w, i) => {
      c.fillStyle = i === 0 ? "#d6455d" : i === 6 ? "#2f6fed" : "#6b7280";
      c.textAlign = "center";
      c.fillText(w, x0 + cell * i + cell / 2, y + 11);
    });
    c.textAlign = "left";
    y += 22;
    for (const wk of mo.weeks) {
      for (let i = 0; i < 7; i++) {
        const d = wk.ws + i * DAY_MS, dt = new Date(d), x = x0 + cell * i;
        c.fillStyle = d === today ? "#fff6d6" : dt.getUTCMonth() !== mo.m ? "#f6f7f9" : "#fff";
        c.fillRect(x, y, cell, wk.h);
        c.strokeStyle = "#e3e6eb";
        c.strokeRect(x + 0.5, y + 0.5, cell, wk.h);
        c.fillStyle = dt.getUTCMonth() !== mo.m ? "#b0b4bc" : i === 0 ? "#d6455d" : i === 6 ? "#2f6fed" : "#1f2430";
        c.font = font(12, d === today);
        c.fillText(dt.getUTCDate() === 1 ? `${dt.getUTCMonth() + 1}/1` : String(dt.getUTCDate()), x + 6, y + 12);
      }
      for (const { t, s, e, lane, cl, cr } of wk.placed) {
        const bx = x0 + cell * s + (cl ? 0 : 3), bw = cell * (e - s + 1) - (cl ? 0 : 3) - (cr ? 0 : 3), by = y + 24 + lane * 24 + 2;
        const st = deadlineStatus(t);
        const hue = /hsl\((\d+)/.exec(areaColor(t.area))[1];
        c.fillStyle = st === "overdue" ? "#ffd4d4" : st === "soon" ? "#ffe2b3" : `hsl(${hue} 62% 90%)`;
        c.fillRect(bx, by, bw, 20);
        c.fillStyle = areaColor(t.area);
        if (!cl) c.fillRect(bx, by, 4, 20);
        c.fillStyle = "#1f2430";
        c.font = font(12);
        c.fillText(fit(`${t.task}${t.assignee ? `（${assigneeText(t)}）` : ""}`, bw - (cl ? 6 : 12)), bx + (cl ? 4 : 8), by + 10.5);
      }
      y += wk.h;
    }
  });
  return cv;
}
async function copyCalendar() {
  const cv = calendarCanvas();
  const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("カレンダーを画像としてコピーしました（貼り付けできます）");
  } catch (_) {
    // クリップボードが使えないとき（http のアクセスなど）は画像ファイルとして保存
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `calendar-${cal.y}-${String(cal.m + 1).padStart(2, "0")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("この環境ではコピーできないため、画像ファイルとして保存しました");
  }
}
function setCalendar(on) {
  cal.on = on;
  document.body.classList.toggle("cal-mode", on);
  $("#btn-cal").textContent = on ? "ガント表示" : "カレンダー";
  $("#btn-cal").title = on ? "ガントチャートの表示に戻す" : "タスクをカレンダー（月表示）で見る";
  $("#btn-cal").classList.toggle("on", on);
  // 位置が動かないよう、隠すのではなく見えなくする（ツールバーの並びを変えない）
  $("#zoom").closest("label").style.visibility = on ? "hidden" : "";
  $("#btn-compact").style.visibility = on ? "hidden" : "";
  renderCalendar();
}
$("#btn-cal").addEventListener("click", () => setCalendar(!cal.on));

// ------------------------------------------------------------ 起動
(async () => {
  try {
    // URL パラメータ: ?pj=PJ名 で絞り込み、?q=キーワードで検索（案件管理からの移動用）
    const params = new URLSearchParams(location.search);
    const openTaskId = params.get("task"); // 共有リンク（?task=番号）: そのタスクの詳細を開く
    state.filter.projects = params.get("pj") || "";
    if (params.get("back") && params.get("pj")) backCase = { pj: params.get("pj"), id: params.get("back") };
    state.q = params.get("q") || "";
    state.defaultArea = params.get("area") || ""; // 案件管理から来たとき: 「タスク追加」の領域の初期値
    if (params.get("from") === "people" && params.get("person")) {
      // 個人の画面から来たとき: 同じ画面のまま個人に戻れる
      const b = $("#person-back");
      b.hidden = false;
      b.href = `/people?name=${encodeURIComponent(params.get("person"))}`;
      b.title = `個人の ${params.get("person")} に戻る（同じ画面のまま）`;
    }
    $("#q").value = state.q;
    await Promise.all([loadMasters(), loadTasks()]);
    if (params.get("pj") && !state.filter.projects) {
      // 未登録の PJ名の場合はキーワード検索として扱う
      state.q = params.get("pj");
      $("#q").value = state.q;
    }
    syncPjActions();
    render();
    scrollToDate(todayMs());
    const shared = openTaskId && state.tasks.find((t) => String(t.id) === openTaskId);
    if (shared) {
      scrollToDate(parseDate(shared.end_date));
      openTaskDialog(shared);
    }
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
