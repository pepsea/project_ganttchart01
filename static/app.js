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
// 左側の列幅。PJ名・タスクは見出しの右端をドラッグして変更でき、ブラウザに記憶する
const COL_W_DEFAULT = { pj: 240, task: 200 };
const COL_W_MIN = 80;
const COL_W_MAX = 640;
const colW = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("gantt.colW") || "{}");
    return { ...COL_W_DEFAULT, ...saved };
  } catch (_) {
    return { ...COL_W_DEFAULT };
  }
})();
// 固定列: 領域 190 + (担当者 80 + 優先度 56 + 開始 40 + 終了日 96) + 削除 34
const leftW = () => 190 + colW.pj + colW.task + 34 + (state.compact ? 0 : 80 + 56 + 40 + 96);

function applyColWidths() {
  gantt.style.setProperty("--w-pj", `${colW.pj}px`);
  gantt.style.setProperty("--w-task", `${colW.task}px`);
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
    colW[key] = Math.min(COL_W_MAX, Math.max(COL_W_MIN, Math.round(w0 + ev.clientX - x0)));
    applyColWidths();
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    handle.classList.remove("active");
    document.body.classList.remove("resizing");
    try { localStorage.setItem("gantt.colW", JSON.stringify({ pj: colW.pj, task: colW.task })); } catch (_) { /* ignore */ }
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

// 表示対象: 領域・PJ・担当者で絞り込み、担当者の名前順 → 締切（終了日）の早い順に並べる
// 担当者が未設定のタスクは最後
const nameCollator = new Intl.Collator("ja");
const byAssigneeThenDue = (a, b) =>
  (!a.assignee - !b.assignee) ||
  nameCollator.compare(a.assignee, b.assignee) ||
  a.end_date.localeCompare(b.end_date) || a.start_date.localeCompare(b.start_date) || a.id - b.id;

// キーワード検索（PJ名・案件名/基盤名・タスク名・担当者・領域）
const matchesQuery = (t) => {
  const q = state.q.trim().toLowerCase();
  return !q || [t.project, state.caseNames[t.project], t.task, t.assignee, t.area]
    .some((v) => (v || "").toLowerCase().includes(q));
};

const visibleTasks = () => state.tasks.filter((t) =>
  matchesQuery(t) &&
  (!state.filter.areas || t.area === state.filter.areas) &&
  (!state.filter.projects || t.project === state.filter.projects) &&
  (!state.filter.assignees ||
    (state.filter.assignees === NO_ASSIGNEE ? !t.assignee : t.assignee === state.filter.assignees))
).sort(byAssigneeThenDue);

// 担当者の選択肢はタスクから集計する
function refreshAssigneeFilter() {
  const sel = $("#filter-assignees");
  const names = [...new Set(state.tasks.map((t) => t.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  const hasNone = state.tasks.some((t) => !t.assignee);
  const cur = state.filter.assignees;
  sel.innerHTML = "";
  sel.append(new Option("すべて", ""));
  for (const n of names) sel.append(new Option(n, n));
  if (hasNone) sel.append(new Option("（未設定）", NO_ASSIGNEE));
  const valid = cur === "" || names.includes(cur) || (cur === NO_ASSIGNEE && hasNone);
  state.filter.assignees = valid ? cur : "";
  sel.value = state.filter.assignees;
}

// ------------------------------------------------------------ 描画
function render() {
  refreshAssigneeFilter();
  computeRange();
  const trackW = state.days * state.dayW;
  gantt.classList.toggle("compact", state.compact);
  applyColWidths();
  gantt.innerHTML = "";

  gantt.append(renderHeader(trackW), renderBackground(trackW));

  const tasks = visibleTasks();
  if (!tasks.length) {
    const empty = el("div", "empty", "タスクがありません。「＋ タスク追加」または CSV インポートで登録してください。");
    gantt.append(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const t of tasks) frag.append(renderRow(t, trackW));
  gantt.append(frag);
}

function renderHeader(trackW) {
  const W = state.dayW;
  const row = el("div", "g-row g-head");
  const left = el("div", "g-left");
  const heads = [["領域"], ["PJ名"], ["タスク"], ["担当者", 1], ["優先度", 1], ["開始", 1], ["終了日", 1], [""]];
  heads.forEach(([h, detail], i) => {
    const cell = el("div", detail ? "col-detail" : "", h);
    const key = i === 1 ? "pj" : i === 2 ? "task" : null;
    if (key) {
      cell.classList.add("resizable");
      const handle = el("span", "col-resizer");
      handle.title = "ドラッグで列幅を変更（ダブルクリックで元の幅）";
      handle.addEventListener("pointerdown", (e) => startColResize(e, key));
      handle.addEventListener("dblclick", () => {
        colW[key] = COL_W_DEFAULT[key];
        applyColWidths();
        try { localStorage.setItem("gantt.colW", JSON.stringify({ pj: colW.pj, task: colW.task })); } catch (_) { /* ignore */ }
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

  left.append(areaCell, projCell, name, assignee, prio, start, end, del);

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
  const left = Math.round((parseDate(task.end_date) - todayMs()) / DAY_MS);
  if (left < 0) return "overdue";
  if (left <= SOON_DAYS) return "soon";
  return "";
}

// 表のセル（表示のみ）: 領域・PJ名・担当者
function syncReadonlyCells(row, task, areaCell, projCell, assigneeCell) {
  assigneeCell.textContent = task.assignee || "—";
  assigneeCell.classList.toggle("empty", !task.assignee);
  assigneeCell.title = `担当者: ${task.assignee || "未設定"}（修正はクリックしてタスク詳細で）`;
  areaCell.textContent = task.area;
  areaCell.title = `領域: ${task.area}（修正はクリックしてタスク詳細で）`;
  projCell.textContent = pjText(task.project) || "—";
  projCell.classList.toggle("empty", !task.project);
  projCell.title = `PJ名: ${pjText(task.project) || "なし"}（修正はクリックしてタスク詳細で）`;
}

// 実施中 = 今日が開始日〜終了日の間（期限超過・3 日以内の色を優先）
const isActive = (task) => parseDate(task.start_date) <= todayMs() && todayMs() <= parseDate(task.end_date);

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
  $(".bar-tip", bar).textContent = [pjText(task.project), task.assignee].filter(Boolean).join(" / ");
  const status = deadlineStatus(task);
  const note = status === "overdue" ? "【期限超過】\n" : status === "soon" ? "【期限まで3日以内】\n" : "";
  bar.title = `${note}${task.task}\n領域: ${task.area} / PJ: ${pjText(task.project) || "-"}\n担当: ${task.assignee || "-"} / 優先度: ${task.priority}\n${task.start_date} 〜 ${task.end_date}${task.detail ? "\n\n" + snippet(task.detail) : ""}`;
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
  const newAssignee = !!task.assignee && ![...$("#filter-assignees").options].some((o) => o.value === task.assignee);
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
  scroller.scrollLeft = Math.max(0, center ? x - visible / 2 : x - state.dayW * 7);
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
    $("#task-title").textContent = "タスク追加";
    $("#task-submit").textContent = "追加";
    meta.hidden = true;
    if (state.filter.areas) form.area.value = state.filter.areas;
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

// CSV インポート
$("#btn-import").addEventListener("click", () => {
  $("#import-file").value = "";
  $("#import-file").click();
});
$("#import-file").addEventListener("change", () => {
  const file = $("#import-file").files[0];
  if (!file) return;
  $("#import-filename").textContent = file.name;
  $("#import-error").textContent = "";
  const f = $("#form-import");
  f.querySelector('input[value="append"]').checked = true;
  f.confirm.value = "";
  $("#replace-confirm").hidden = true;
  $("#dlg-import").showModal();
});
$("#form-import").addEventListener("change", (e) => {
  if (e.target.name === "mode") $("#replace-confirm").hidden = e.target.value !== "replace";
});
$("#form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("#import-file").files[0];
  const mode = new FormData(e.target).get("mode");
  const confirmText = e.target.confirm.value.trim();
  if (mode === "replace" && confirmText !== "置き換え") {
    $("#import-error").textContent = "置き換えを実行するには確認欄に「置き換え」と入力してください";
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await api(`/api/import?mode=${mode}&confirm=${encodeURIComponent(confirmText)}`, { method: "POST", body: fd });
    $("#dlg-import").close();
    await reloadAll();
    toast(`インポート完了: 追加 ${r.added} 件 / 更新 ${r.updated} 件`);
  } catch (err) {
    $("#import-error").textContent = err.message;
  }
});

// フィルター・検索・ズーム・今日へ・列の折りたたみ
for (const kind of ["areas", "projects", "assignees"]) {
  $(`#filter-${kind}`).addEventListener("change", (e) => {
    state.filter[kind] = e.target.value;
    syncPjActions();
    rerenderKeepScroll();
  });
}
$("#q").addEventListener("input", (e) => {
  state.q = e.target.value;
  rerenderKeepScroll();
});

let backCase = null; // 案件管理から来たときの戻り先 { pj, id }

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
$("#btn-today").addEventListener("click", () => scrollToDate(todayMs(), true));
$("#btn-compact").addEventListener("click", (e) => {
  const c = centerDate();
  state.compact = !state.compact;
  e.target.textContent = state.compact ? "展開" : "折り畳み";
  e.target.title = state.compact ? "折りたたんだ列を元に戻す" : "担当者・優先度・日付の列を折りたたむ";
  render();
  scrollToDate(c, true);
});

// ------------------------------------------------------------ 起動
(async () => {
  try {
    // URL パラメータ: ?pj=PJ名 で絞り込み、?q=キーワードで検索（案件管理からの移動用）
    const params = new URLSearchParams(location.search);
    state.filter.projects = params.get("pj") || "";
    if (params.get("back") && params.get("pj")) backCase = { pj: params.get("pj"), id: params.get("back") };
    state.q = params.get("q") || "";
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
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
