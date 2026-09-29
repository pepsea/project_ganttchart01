"use strict";

const DAY_MS = 86400000;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const STATUS_COLOR = {
  顧客開発: "#8a90a3",
  打診: "#5b8def",
  見積提出: "#3563d6",
  契約中: "#7a5af5",
  ブリーフィング前: "#b155d9",
  実施中: "#2fa36b",
  "アフターフォロー・その他": "#1f9fb4",
  キャンセル: "#a9adb6",
  アーカイブ: "#6b7280",
};
// 期限（終了予定日）の色分け対象外
const NO_DEADLINE = new Set(["アフターフォロー・その他", "キャンセル", "アーカイブ"]);
const ARCHIVE = "アーカイブ"; // 終了した案件（カンバンの一番右）
const LINKS = [
  ["box_url", "BOX", "BOX"],
  ["teams_url", "Teams", "Teams"],
  ["overview_url", "概要", "案件概要書"],
  ["plan_url", "計画", "試験計画書"],
];

const state = {
  cases: [],
  statuses: [],
  areas: [],
  masters: { case_nos: [], customers: [] }, // 登録済みの案件番号（= ガントチャートの PJ名）・企業名
  view: "board",
  q: "",
  area: "",
  person: "",
  status: "", // サマリーのピルで選択した状況
  showCancel: false,
  sort: { key: "end_date", desc: false },
  current: null, // ドロワーで開いている案件
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

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
const mondayOf = (ms) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
function shortDate(str) {
  if (!str) return "";
  const d = new Date(parseDate(str));
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return d.getUTCFullYear() === new Date().getFullYear() ? md : `${d.getUTCFullYear()}/${md}`;
}
const today = () => fmtDate(todayMs());
const people = (c) => (c.assignees ? c.assignees.split(" ") : []);
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

function areaColor(area) {
  let i = state.areas.indexOf(area);
  if (i < 0) i = state.areas.length;
  return `hsl(${(210 + i * 67) % 360} 62% 50%)`;
}

// 終了予定日: 過ぎたら赤（overdue）、2 週間を切ったらオレンジ（soon）。アフターフォロー・その他・キャンセルは対象外
const SOON_DAYS = 14;
const daysToEnd = (c) => Math.round((parseDate(c.end_date) - todayMs()) / DAY_MS);
function deadlineStatus(c) {
  if (NO_DEADLINE.has(c.status)) return "";
  if (!c.end_date) return "missing"; // 未設定も赤
  const left = daysToEnd(c);
  if (left < 0) return "overdue";
  if (left < SOON_DAYS) return "soon";
  return "";
}
function deadlineTitle(c) {
  if (!c.end_date) return "終了予定日: 未設定";
  const left = daysToEnd(c);
  const note = left < 0 ? `（${-left} 日超過）` : left === 0 ? "（本日）" : `（あと ${left} 日）`;
  return `終了予定日: ${c.end_date}${NO_DEADLINE.has(c.status) ? "" : note}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { "Content-Type": "application/json" } : {},
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

// 案件番号（= ガントチャートの PJ名）と、ガントチャートへのリンク
// ガントチャートへは同じ画面のまま移る。back = 戻り先の案件（ガントチャートの「← 案件に戻る」でこの案件に戻る）
const ganttUrl = (no, id) => `/?pj=${encodeURIComponent(no)}${id ? `&back=${id}` : ""}`;

// 案件番号＋試験名。自動で付いた番号（2, 3, …）は「C-2026-001-2」、名前は「C-2026-001（追加検体）」
const isAutoNo = (t) => /^\d+$/.test(t || "");
const caseLabel = (c) => (!c.trial ? c.case_no : isAutoNo(c.trial) ? `${c.case_no}-${c.trial}` : `${c.case_no}（${c.trial}）`);

function caseNoTag(c) {
  const tag = el("span", "pj-tag");
  tag.title = `案件番号（PJ名）: ${c.case_no}`;
  const link = el("a", "mini-link", "ガント →");
  link.href = ganttUrl(c.case_no, c.id);
  link.title = `ガントチャートでこの案件のタスクを表示（${c.task_count ?? 0} 件）`;
  link.addEventListener("click", (e) => e.stopPropagation());
  tag.append(isAutoNo(c.trial) ? caseLabel(c) : c.case_no, link);
  if (c.trial && !isAutoNo(c.trial)) {
    const wrap = el("span", "no-wrap");
    wrap.append(tag, el("span", "trial-tag", c.trial));
    return wrap;
  }
  return tag;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 4000 : 2200);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
};

// ------------------------------------------------------------ 絞り込み
function filtered({ ignoreStatus = false } = {}) {
  const q = state.q.trim().toLowerCase();
  return state.cases.filter((c) => {
    if (!state.showCancel && c.status === "キャンセル" && state.status !== "キャンセル") return false;
    if (!ignoreStatus && state.status && c.status !== state.status) return false;
    if (state.area && !c.areas.includes(state.area)) return false;
    if (state.person && c.pl !== state.person && !people(c).includes(state.person)) return false;
    if (q && ![c.case_no, c.trial, c.customer, c.contact, c.name].some((v) => (v || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

const byEnd = (a, b) =>
  (a.end_date || "9999").localeCompare(b.end_date || "9999") || a.case_no.localeCompare(b.case_no) || (a.trial || "").localeCompare(b.trial || "");

// ------------------------------------------------------------ 描画
function render() {
  renderSummary();
  view.innerHTML = "";
  if (state.view === "board") renderBoard();
  else if (state.view === "list") renderList();
  else renderTimeline();
}

function renderSummary() {
  const bar = $("#summary");
  bar.innerHTML = "";
  const base = filtered({ ignoreStatus: true });
  state.statuses.forEach((s, i) => {
    if (s === "キャンセル" && !state.showCancel) return;
    const n = base.filter((c) => c.status === s).length;
    if (i > 0) bar.append(el("span", "sum-arrow", "›"));
    const pill = el("button", "sum-pill");
    pill.style.setProperty("--c", STATUS_COLOR[s]);
    pill.append(el("span", "dot"), el("span", "", s), el("b", "", n));
    pill.classList.toggle("on", state.status === s);
    pill.classList.toggle("zero", n === 0);
    pill.title = state.status === s ? "クリックで絞り込み解除" : `「${s}」で絞り込み`;
    pill.addEventListener("click", () => {
      state.status = state.status === s ? "" : s;
      render();
    });
    bar.append(pill);
  });
}

function areaChips(c) {
  const box = el("div", "chips");
  for (const a of c.areas) {
    const chip = el("span", "area-chip-s", a);
    chip.style.setProperty("--c", areaColor(a));
    box.append(chip);
  }
  return box;
}

// 最初の画面（カード・一覧）のリンク: 設定済みはクリックで直接開く（別タブ）。未設定は赤。自由リンクは設定済みのときだけ
function linkIcons(c) {
  const box = el("span", "links");
  const add = (url, text, title, cls) => {
    const a = el("a", `link-ic on ${cls}`, `${text} ↗`);
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `${title}を開く`;
    a.draggable = false;
    a.addEventListener("click", (e) => e.stopPropagation()); // カードの詳細は開かない
    box.append(a);
  };
  for (const [key, short, label] of LINKS) {
    const url = safeUrl(c[key]);
    if (url) add(url, short, label, key === "teams_url" ? "teams" : "");
    else {
      const s = el("span", "link-ic", short);
      s.title = `${label}: 未設定（案件を開いて一番下のリンクで登録）`;
      box.append(s);
    }
  }
  for (const i of [1, 2]) {
    const url = safeUrl(c[`link${i}_url`]);
    if (url) add(url, c[`link${i}_label`] || `リンク${i}`, c[`link${i}_label`] || `自由リンク ${i}`, "free");
  }
  return box;
}

const fullDate = (s) => s.replaceAll("-", "/");
function dueLabel(c) {
  const span = el("span", `due-label ${deadlineStatus(c)}${c.end_date ? "" : " none"}`);
  span.append(el("small", "", "終了予定"), c.end_date ? fullDate(c.end_date) : "未設定");
  span.title = deadlineTitle(c);
  return span;
}

// ---- カンバン
function renderBoard() {
  const board = el("div", "board");
  const list = filtered();
  const statuses = state.status ? [state.status] : state.statuses.filter((s) => s !== "キャンセル" || state.showCancel);
  for (const s of statuses) {
    const col = el("div", "col");
    if (s === "キャンセル") col.classList.add("cancel");
    if (s === ARCHIVE) col.classList.add("archive");
    col.style.setProperty("--c", STATUS_COLOR[s]);
    const items = list.filter((c) => c.status === s).sort(byEnd);
    const head = el("div", "col-head");
    head.append(el("span", "", s), el("span", "count", `${items.length} 件`));
    const body = el("div", "col-body");
    if (!items.length) body.append(el("div", "empty-col", "—"));
    for (const c of items) body.append(renderCard(c));
    col.append(head, body);

    // ドラッグ＆ドロップで状況を変更
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop-over"); });
    col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("drop-over"); });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop-over");
      const id = Number(e.dataTransfer.getData("text/plain"));
      const c = state.cases.find((x) => x.id === id);
      if (c && c.status !== s) changeStatus(c, s);
    });
    board.append(col);
  }
  view.append(board);
}

function renderCard(c) {
  const card = el("div", "card");
  card.style.setProperty("--c", STATUS_COLOR[c.status]);
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(c.id));
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("click", () => openDrawer(c));

  const top = el("div", "card-top");
  top.append(caseNoTag(c));
  card.append(top, el("div", "title", c.name));
  // アーカイブ（終了した案件）は最小限の表示: 案件番号と案件名だけ
  if (c.status === ARCHIVE) {
    card.classList.add("mini");
    card.title = `${caseLabel(c)} ${c.name}（終了）— クリックで詳細`;
    return card;
  }
  const who = [c.customer, c.contact].filter(Boolean).join(" ／ ");
  if (who) card.append(el("div", "cust", who));

  const ppl = el("div", "people");
  if (c.pl) ppl.append(el("span", "lbl", "PL "), c.pl);
  if (c.assignees) ppl.append(el("span", "lbl", c.pl ? "　担当 " : "担当 "), people(c).join("・"));
  if (c.pl || c.assignees) card.append(ppl);
  if (c.areas.length) card.append(areaChips(c));

  if (c.last_note) {
    const memo = el("div", "memo");
    memo.append(el("span", "wk", shortDate(c.last_note_date)), c.last_note);
    memo.title = c.last_note;
    card.append(memo);
  }
  const foot = el("div", "card-foot");
  foot.append(linkIcons(c), el("span", "spacer"));
  // 終了予定日は一番下（リンクの下）に年月日で表示
  const dueRow = el("div", "card-due");
  dueRow.append(dueLabel(c));
  card.append(foot, dueRow);
  return card;
}

// 案件の終了（アーカイブ）の確認: 案件番号を入力しないと「終了する」を押せない
function confirmFinish(c) {
  return new Promise((resolve) => {
    const dlg = $("#dlg-finish");
    const f = $("#form-finish");
    const ok = f.querySelector("button[type=submit]");
    f.reset();
    ok.disabled = true;
    $("#finish-target").textContent = `「${caseLabel(c)} ${c.name}」`;
    $("#finish-no").textContent = `「${c.case_no}」`;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      f.confirm.oninput = f.onsubmit = null;
      dlg.querySelector("[data-close]").onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(v);
    };
    f.confirm.oninput = () => { ok.disabled = f.confirm.value.trim() !== c.case_no; };
    f.onsubmit = (e) => { e.preventDefault(); if (f.confirm.value.trim() === c.case_no) finish(true); };
    dlg.querySelector("[data-close]").onclick = () => finish(false);
    dlg.onclose = () => finish(false); // Esc で閉じたとき
    dlg.showModal();
    f.confirm.focus();
  });
}

async function changeStatus(c, status) {
  if (status === "キャンセル" && !confirm(`案件「${c.name}」をキャンセルにしますか？`)) return;
  if (status === ARCHIVE && !(await confirmFinish(c))) return;
  const prev = c.status;
  try {
    Object.assign(c, await api(`/api/cases/${c.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }));
    render();
    toast(`${caseLabel(c)} を「${status}」に変更しました`);
  } catch (err) {
    c.status = prev;
    toast(err.message, true);
  }
}

// ---- 一覧
const COLUMNS = [
  ["status", "状況"], ["case_no", "案件番号"], ["customer", "企業名／顧客名"], ["name", "案件名"], ["pl", "PL"],
  ["assignees", "担当者"], ["areas", "領域"], ["start_date", "開始日"], ["end_date", "終了予定日"],
  ["links", "リンク"], ["last_note_date", "最新の進捗"],
];

// 一覧の列幅: 見出しの右端をドラッグで変更（ブラウザに記憶。ダブルクリックで元の幅）
const LIST_W_DEFAULT = { status: 104, case_no: 130, customer: 170, name: 240, pl: 72, assignees: 120, areas: 180,
  start_date: 96, end_date: 150, links: 200, last_note_date: 280 };
const listW = (() => {
  try { return { ...LIST_W_DEFAULT, ...JSON.parse(localStorage.getItem("cases.listW") || "{}") }; }
  catch (_) { return { ...LIST_W_DEFAULT }; }
})();
const saveListW = () => { try { localStorage.setItem("cases.listW", JSON.stringify(listW)); } catch (_) { /* 記憶できなくても幅は変わる */ } };
const listTableW = () => COLUMNS.reduce((n, [k]) => n + listW[k], 0);

function startListResize(e, key, col, table) {
  e.preventDefault();
  e.stopPropagation(); // 並び替えにしない
  const handle = e.currentTarget;
  const x0 = e.clientX;
  const w0 = listW[key];
  handle.setPointerCapture(e.pointerId);
  handle.classList.add("active");
  document.body.classList.add("resizing");
  const move = (ev) => {
    listW[key] = Math.min(800, Math.max(48, Math.round(w0 + ev.clientX - x0)));
    col.style.width = `${listW[key]}px`;
    table.style.width = `${listTableW()}px`;
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    handle.classList.remove("active");
    document.body.classList.remove("resizing");
    saveListW();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function renderList() {
  const wrap = el("div", "table-wrap");
  const table = el("table", "cases resizable-cols");
  table.style.width = `${listTableW()}px`;
  const colgroup = el("colgroup");
  const cols = {};
  for (const [key] of COLUMNS) {
    const col = el("col");
    col.style.width = `${listW[key]}px`;
    cols[key] = col;
    colgroup.append(col);
  }
  table.append(colgroup);
  const thead = el("thead");
  const hr = el("tr");
  for (const [key, label] of COLUMNS) {
    const th = el("th", "", label);
    const handle = el("span", "col-resizer");
    handle.title = "ドラッグで列幅を変更（ダブルクリックで元の幅）";
    handle.addEventListener("pointerdown", (e) => startListResize(e, key, cols[key], table));
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      listW[key] = LIST_W_DEFAULT[key];
      cols[key].style.width = `${listW[key]}px`;
      table.style.width = `${listTableW()}px`;
      saveListW();
    });
    th.append(handle);
    if (key !== "links") {
      if (state.sort.key === key) th.classList.add("sorted", ...(state.sort.desc ? ["desc"] : []));
      th.addEventListener("click", () => {
        state.sort = { key, desc: state.sort.key === key ? !state.sort.desc : false };
        render();
      });
    }
    hr.append(th);
  }
  thead.append(hr);

  const { key, desc } = state.sort;
  const val = (c) => key === "status" ? String(state.statuses.indexOf(c.status)).padStart(2, "0")
    : key === "areas" ? c.areas.join(" ") : (c[key] || "￿");
  const rows = filtered().sort((a, b) => (desc ? -1 : 1) * val(a).localeCompare(val(b), "ja") || byEnd(a, b));

  const tbody = el("tbody");
  for (const c of rows) {
    const tr = el("tr");
    tr.addEventListener("click", () => openDrawer(c));
    const st = el("span", "st-badge", c.status);
    st.style.setProperty("--c", STATUS_COLOR[c.status]);
    const cell = (content, cls = "") => {
      const td = el("td", cls);
      if (content instanceof Node) td.append(content); else td.textContent = content ?? "";
      tr.append(td);
      return td;
    };
    cell(st, "nowrap");
    cell(caseLabel(c), "nowrap");
    cell([c.customer, c.contact].filter(Boolean).join(" ／ "));
    cell(c.name);
    cell(c.pl, "nowrap");
    cell(people(c).join("、"));
    cell(areaChips(c));
    cell(c.start_date || "", "nowrap");
    const endTd = cell("", "nowrap");
    const ds = deadlineStatus(c);
    const d = el("span", `due-label ${ds}${c.end_date ? "" : " none"}`, c.end_date ? fullDate(c.end_date) : "未設定");
    if (ds === "overdue" || ds === "soon") d.append(el("small", "", ds === "overdue" ? " 超過" : " 2週間以内"));
    d.title = deadlineTitle(c);
    endTd.append(d);
    cell(linkIcons(c), "nowrap");
    const memo = cell("", "memo-cell");
    // 最新の進捗: 最大 3 行まで表示（続きはマウスを重ねると全文）
    if (c.last_note_date) {
      const body = el("div", "memo-body", c.last_note);
      memo.title = c.last_note;
      memo.append(el("span", "wk", `${shortDate(c.last_note_date)}（全 ${c.note_count} 件）`), body);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  if (!rows.length) wrap.append(el("p", "hint", "該当する案件がありません。"));
  view.append(wrap);
}

// ---- タイムライン（開始日〜終了予定日、状況で色分け）
function renderTimeline() {
  const DAY_W = 4;
  const LEFT_W = 360;
  const all = filtered();
  const today = todayMs();
  // 日付が分からない案件も表示する: 開始日だけ・終了予定日だけは点線の帯、どちらも無い案件は一番下にまとめる
  const span = (c) => {
    if (c.start_date && c.end_date) return { s: parseDate(c.start_date), e: parseDate(c.end_date), kind: "" };
    if (c.start_date) {
      const s0 = parseDate(c.start_date);
      return { s: s0, e: Math.max(today, s0 + 7 * DAY_MS), kind: "no-end" };
    }
    if (c.end_date) {
      const e0 = parseDate(c.end_date);
      return { s: e0 - 7 * DAY_MS, e: e0, kind: "no-start" };
    }
    return null;
  };
  // 締切（終了予定日）の早い順。終了予定日が無い案件（開始日だけ）は、日付のある案件の最後
  const dated = all.filter((c) => span(c))
    .sort((a, b) => byEnd(a, b) || span(a).s - span(b).s);
  const undated = all.filter((c) => !span(c)).sort(byEnd);

  let min = today - 60 * DAY_MS;
  let max = today + 120 * DAY_MS;
  for (const c of dated) {
    const { s, e } = span(c);
    min = Math.min(min, s - 14 * DAY_MS);
    max = Math.max(max, e + 30 * DAY_MS);
  }
  const m0 = new Date(min);
  const start = Date.UTC(m0.getUTCFullYear(), m0.getUTCMonth(), 1);
  const days = Math.ceil((max - start) / DAY_MS) + 1;
  const W = days * DAY_W;
  const x = (ms) => ((ms - start) / DAY_MS) * DAY_W;

  const tl = el("div", "tl");
  tl.style.width = `${LEFT_W + W}px`;

  // ヘッダー（月・週）
  const head = el("div", "tl-row tl-head");
  const hl = el("div", "tl-left", "案件");
  const ht = el("div", "tl-track");
  ht.style.width = `${W}px`;
  const bg = el("div", "tl-bg");
  bg.style.left = `${LEFT_W}px`;
  bg.style.width = `${W}px`;
  for (let ms = start; ms < start + days * DAY_MS;) {
    const d = new Date(ms);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const m = el("div", "tl-month", `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`);
    m.style.left = `${x(ms)}px`;
    m.style.width = `${x(next) - x(ms)}px`;
    ht.append(m);
    const line = el("div", "mline");
    line.style.left = `${x(ms)}px`;
    bg.append(line);
    ms = next;
  }
  for (let ms = mondayOf(start); ms < start + days * DAY_MS; ms += 7 * DAY_MS) {
    if (ms < start) continue;
    const wk = el("div", "tl-week", String(new Date(ms).getUTCDate()));
    wk.style.left = `${x(ms)}px`;
    wk.style.width = `${7 * DAY_W}px`;
    ht.append(wk);
  }
  const tline = el("div", "today");
  tline.style.left = `${x(today)}px`;
  bg.append(tline);
  head.append(hl, ht);
  tl.append(head, bg);

  const addRow = (c) => {
    const row = el("div", "tl-row");
    const left = el("div", "tl-left");
    // 2 段: 上に案件番号・企業名（小さく）、下に案件名（太字）
    const top = el("div", "tl-meta");
    top.append(el("span", "no", caseLabel(c)));
    if (c.customer) top.append(el("span", "cu", c.customer));
    left.append(top, el("div", "nm", c.name));
    left.title = `${caseLabel(c)} ${c.customer} ${c.name}`;
    left.addEventListener("click", () => openDrawer(c));
    const track = el("div", "tl-track");
    track.style.width = `${W}px`;
    const sp = span(c);
    const bar = el("div", `tl-bar ${sp ? sp.kind : "no-date"}`, c.status);
    bar.style.setProperty("--c", STATUS_COLOR[c.status]);
    let note;
    if (sp) {
      const s = x(sp.s);
      bar.style.left = `${s}px`;
      bar.style.width = `${Math.max(x(sp.e + DAY_MS) - s, 6)}px`;
      note = sp.kind === "no-end" ? "終了予定 未定" : sp.kind === "no-start" ? `開始日 未定・〜${shortDate(c.end_date)}` : shortDate(c.end_date);
    } else {
      bar.style.left = `${x(today)}px`; // 日付が無い案件は今日の位置に札を置く
      note = "開始日・終了予定日 未定";
    }
    bar.title = `${caseLabel(c)} ${c.name}\n${c.status}\n${c.start_date || "開始日未定"} 〜 ${c.end_date || "終了予定日未定"}`;
    bar.append(el("span", "after", [c.pl && `PL ${c.pl}`, note].filter(Boolean).join(" / ")));
    bar.addEventListener("click", () => openDrawer(c));
    track.append(bar);
    row.append(left, track);
    tl.append(row);
  };
  dated.forEach(addRow);
  if (undated.length) {
    const sep = el("div", "tl-row tl-sep");
    const sl = el("div", "tl-left", `日付未設定（${undated.length} 件）`);
    const st = el("div", "tl-track");
    st.style.width = `${W}px`;
    sep.append(sl, st);
    tl.append(sep);
    undated.forEach(addRow);
  }
  view.append(tl);
  view.scrollLeft = Math.max(0, x(today) - 200);
}

// ------------------------------------------------------------ ドロワー（詳細・編集）
const form = $("#case-form");
const drawer = $("#drawer");

function renderAreaChecks(selected) {
  const box = $("#area-checks");
  box.innerHTML = "";
  const names = [...state.areas, ...selected.filter((a) => !state.areas.includes(a))];
  for (const a of names) {
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
}

// 案件番号の選択肢: 登録済みの番号（検索欄で番号・案件名から絞り込める）。
// 終了（アーカイブ）した案件だけの番号は出さない（今の案件の番号は残す）。同じ番号で試験が複数ある場合は「試験名」で区別
function fillCaseNoSelect(current = "") {
  const others = state.cases.filter((x) => x.id !== state.current?.id);
  const byNo = new Map();
  for (const c of others) {
    if (!byNo.has(c.case_no)) byNo.set(c.case_no, []);
    byNo.get(c.case_no).push(c);
  }
  const finished = (n) => byNo.has(n) && byNo.get(n).every((c) => c.status === ARCHIVE);
  let opts = state.masters.case_nos.filter((n) => n === current || !finished(n));
  if (current && !opts.includes(current)) opts.push(current);
  sortNames(opts);
  // 表示は番号だけ。プルダウンの中の検索欄では、番号と案件名で探せる（data-search）
  const sel = form.case_no;
  sel.innerHTML = "";
  sel.append(new Option(opts.length ? "選択してください" : "案件番号がありません（管理サイトで登録）", ""));
  for (const n of opts) {
    const o = new Option(n, n);
    o.dataset.search = (byNo.get(n) || []).map((c) => c.name).join(" ");
    sel.append(o);
  }
  sel.value = current;
  sel._ss?.refresh();
}

// 詳細パネル: 案件番号（= PJ名）からガントチャートへ移動
function syncNoCopy() {
  const no = form.case_no.value;
  const a = $("#d-no-link");
  a.hidden = !no;
  if (no) {
    a.href = ganttUrl(no, state.current && state.current.case_no === no ? state.current.id : null);
    const n = state.current && state.current.case_no === no ? state.current.task_count : null;
    a.title = `ガントチャートでこの案件のタスクを表示${n !== null ? `（${n} 件）` : ""}`;
  }
}
form.case_no.addEventListener("change", syncNoCopy);
// 案件番号・企業名は、プルダウンの中で検索して選べる
searchSelect(form.case_no, { placeholder: "番号・案件名で検索" });
searchSelect(form.customer, { placeholder: "企業名で検索", allowEmpty: true });

// 選択肢の並び: 数字は数の順（C-2026-2 → C-2026-10）、日本語は五十音順
const sortNames = (list) => list.sort((a, b) => a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" }));

function fillCustomerSelect(current = "") {
  const opts = [...state.masters.customers];
  if (current && !opts.includes(current)) opts.push(current);
  sortNames(opts);
  const sel = form.customer;
  sel.innerHTML = "";
  sel.append(new Option("（未選択）", ""));
  for (const n of opts) sel.append(new Option(n, n));
  sel.value = current;
  sel._ss?.refresh();
}

// リンク: 有効な URL が入力されたら「開く」をアクティブにする
function syncLinks() {
  document.querySelectorAll("#links-section .open-link").forEach((a) => {
    const url = safeUrl(form[a.dataset.for].value.trim());
    form[a.dataset.for].classList.toggle("missing", !url && !("free" in a.dataset)); // リンクが無い欄は赤背景（自由リンクは除く）
    if (url) {
      a.href = url;
      a.setAttribute("aria-disabled", "false");
      a.title = url;
      if ("free" in a.dataset) a.textContent = `${form[a.dataset.for.replace("_url", "_label")].value.trim() || "開く"} ↗`;
    } else {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
      a.title = "URL を入力すると開けます";
      if ("free" in a.dataset) a.textContent = "開く ↗";
    }
  });
}
for (const key of [...LINKS.map(([k]) => k), "link1_url", "link2_url", "link1_label", "link2_label"]) form[key].addEventListener("input", syncLinks);

function openDrawer(c = null) {
  state.current = c;
  form.reset();
  $("#case-error").textContent = "";
  const sel = form.status;
  sel.innerHTML = "";
  for (const s of state.statuses) sel.append(new Option(s, s));
  fillCaseNoSelect(c?.case_no || "");
  fillCustomerSelect(c?.customer || "");
  if (c) {
    $("#d-no").textContent = caseLabel(c);
    history.replaceState(null, "", `/cases?id=${c.id}`);
    // 登録日・終了日（自動で記録。右上に薄く表示）
    const day = (v) => (v ? v.slice(0, 10).replaceAll("-", "/") : "");
    $("#d-dates").textContent = [c.created_at && `登録 ${day(c.created_at)}`, c.finished_at && `終了 ${day(c.finished_at)}`]
      .filter(Boolean).join("　");
    $("#d-dates").title = [c.created_at && `登録日時 ${c.created_at.slice(0, 16)}`, c.finished_at && `終了日時 ${c.finished_at.slice(0, 16)}`]
      .filter(Boolean).join("\n");
    $("#d-title").textContent = c.name;
    for (const k of ["name", "detail", "status", "pl", "assignees", "start_date", "end_date",
      "box_url", "teams_url", "overview_url", "plan_url", "link1_label", "link1_url", "link2_label", "link2_url", "contact"]) form[k].value = c[k] || "";
    renderAreaChecks(c.areas);
    $("#case-top-actions").hidden = false;
    $("#btn-delete").hidden = false;
    $("#btn-finish").hidden = c.status === ARCHIVE;
    $("#archive-note").hidden = c.status !== ARCHIVE;
    $("#logs").hidden = false;
    loadNotes(c);
    loadMonthly(c);
    loadCaseTasks(c);
  } else {
    $("#d-no").textContent = "新規";
    $("#d-dates").textContent = "";
    $("#d-title").textContent = "案件追加";
    sel.value = state.status || "打診"; // 案件追加の初期値は「打診」（状況で絞り込み中ならその状況）
    renderAreaChecks(state.area ? [state.area] : []);
    $("#case-top-actions").hidden = true;
    $("#btn-delete").hidden = true;
    $("#btn-finish").hidden = true;
    $("#archive-note").hidden = true;
    $("#logs").hidden = true;
    $("#tasks-section").hidden = true;
  }
  syncLinks();
  syncNoCopy();
  if (!drawer.open) drawer.showModal();
  // 一番上（終了・削除ボタン）から表示する。入力欄にフォーカスしても画面は動かさない
  (c ? $("#note-form").body : form.case_no.previousElementSibling.querySelector(".ss-btn")).focus({ preventScroll: true });
  $("#drawer .drawer-body").scrollTop = 0;
}

// 案件の終了: アーカイブ（カンバンの一番右）へ移す。戻すときは状況を選び直して保存
$("#btn-finish").addEventListener("click", async () => {
  const c = state.current;
  if (!c) return;
  await changeStatus(c, ARCHIVE);
  if (c.status === ARCHIVE) drawer.close();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ["case_no", "customer", "name", "detail", "status", "pl", "assignees", "start_date", "end_date",
    "box_url", "teams_url", "overview_url", "plan_url", "link1_label", "link1_url", "link2_label", "link2_url", "contact"]) body[k] = form[k].value.trim();
  // 試験名（番号）は入力しない: 編集では今の値を引き継ぎ、新規で同じ案件番号があればサーバーが自動で番号を付ける
  body.trial = state.current && state.current.case_no === body.case_no ? state.current.trial || "" : "";
  body.start_date ||= null;
  body.end_date ||= null;
  body.areas = [...form.querySelectorAll('input[name="areas"]:checked')].map((i) => i.value);
  if (!body.case_no) {
    $("#case-error").textContent = "案件番号を選択してください（未登録の場合は ＋ で登録）";
    return;
  }
  if (body.start_date && body.end_date && body.end_date < body.start_date) {
    $("#case-error").textContent = "終了予定日は開始日以降にしてください";
    return;
  }
  try {
    const c = state.current;
    const saved = c
      ? await api(`/api/cases/${c.id}`, { method: "PUT", body: JSON.stringify(body) })
      : await api("/api/cases", { method: "POST", body: JSON.stringify(body) });
    await loadCases();
    const fresh = state.cases.find((x) => x.id === saved.id);
    render();
    toast(c ? "保存しました" : "案件を追加しました。続けて進捗メモを記入できます");
    openDrawer(fresh);
  } catch (err) {
    $("#case-error").textContent = err.message;
  }
});

drawer.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => drawer.close()));
// 個々の案件へのリンク: 開いている間はアドレス欄をその案件のリンク（/cases?id=）にする
const caseUrl = (c) => `${location.origin}/cases?id=${c.id}`;
drawer.addEventListener("close", () => {
  if (new URLSearchParams(location.search).has("id")) history.replaceState(null, "", "/cases");
});
$("#btn-copy-link").addEventListener("click", async () => {
  const c = state.current;
  if (!c) return;
  const url = caseUrl(c);
  try {
    await navigator.clipboard.writeText(url);
    toast(`リンクをコピーしました: ${url}`);
  } catch (_) {
    prompt("このリンクをコピーしてください", url); // クリップボードが使えないとき
  }
});
drawer.addEventListener("click", (e) => { if (e.target === drawer) drawer.close(); }); // 背景クリックで閉じる

// ---- 進捗メモ（日付ごと。同じ日に複数可。日付は今日が初期値）
const noteForm = $("#note-form");
let notes = [];
let noteEditing = null; // 編集中の進捗メモ（null = 新規）

function resetNoteForm() {
  noteEditing = null;
  noteForm.note_date.value = today();
  noteForm.body.value = "";
  $("#note-submit").textContent = "進捗を追加";
  $("#note-cancel").hidden = true;
  $("#note-state").textContent = "";
}

function editNote(n) {
  noteEditing = n;
  noteForm.note_date.value = n.note_date;
  noteForm.body.value = n.body;
  $("#note-submit").textContent = "保存";
  $("#note-cancel").hidden = false;
  $("#note-state").textContent = `${n.note_date.replaceAll("-", "/")} のメモを編集中`;
  noteForm.body.focus();
}

async function loadNotes(c) {
  notes = await api(`/api/cases/${c.id}/notes`);
  renderNotes();
  resetNoteForm();
}

function renderNotes() {
  const ol = $("#note-list");
  ol.innerHTML = "";
  if (!notes.length) {
    ol.append(el("li", "note-empty", "まだ進捗メモがありません。"));
    return;
  }
  for (const n of notes) {
    const li = el("li");
    if (n.note_date === today()) li.classList.add("current");
    const h = el("div", "nh");
    h.append(el("b", "", n.note_date.replaceAll("-", "/")), el("span", "upd", `更新 ${n.updated_at.slice(0, 16)}`));
    const edit = el("button", "", "編集");
    edit.type = "button";
    edit.addEventListener("click", () => editNote(n));
    const del = el("button", "", "削除");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`${n.note_date.replaceAll("-", "/")} の進捗メモを削除しますか？`)) return;
      try {
        await api(`/api/cases/${state.current.id}/notes/${n.id}`, { method: "DELETE" });
        await afterNoteChange();
        toast("進捗メモを削除しました");
      } catch (err) { toast(err.message, true); }
    });
    h.append(edit, del);
    li.append(h, el("div", "nb", n.body));
    ol.append(li);
  }
}

async function afterNoteChange() {
  const id = state.current.id;
  notes = await api(`/api/cases/${id}/notes`);
  renderNotes();
  resetNoteForm();
  await loadCases();
  state.current = state.cases.find((x) => x.id === id);
  render();
}

$("#note-cancel").addEventListener("click", resetNoteForm);

noteForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = noteForm.body.value.trim();
  if (!body) return;
  const payload = JSON.stringify({ note_date: noteForm.note_date.value || today(), body });
  try {
    if (noteEditing) await api(`/api/cases/${state.current.id}/notes/${noteEditing.id}`, { method: "PUT", body: payload });
    else await api(`/api/cases/${state.current.id}/notes`, { method: "POST", body: payload });
    const wasEdit = !!noteEditing;
    await afterNoteChange();
    toast(wasEdit ? "進捗メモを保存しました" : "進捗メモを追加しました");
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- ガントチャートのタスク（PJ名 = 案件番号）を詳細パネルの一番下に表示
async function loadCaseTasks(c) {
  const sec = $("#tasks-section");
  sec.hidden = false;
  $("#case-task-link").href = ganttUrl(c.case_no, c.id);
  const box = $("#case-task-list");
  box.innerHTML = "";
  box.append(el("p", "hint", "読み込み中…"));
  const tasks = (await api("/api/tasks")).filter((t) => t.project === c.case_no)
    .sort((a, b) => a.end_date.localeCompare(b.end_date) || a.start_date.localeCompare(b.start_date));
  if (state.current?.id !== c.id) return; // 読み込み中に別の案件へ切り替えた場合
  $("#case-task-count").textContent = `${tasks.length} 件`;
  box.innerHTML = "";
  if (!tasks.length) {
    box.append(el("p", "hint", "この案件のタスクはまだありません。ガントチャートでタスクを追加し、PJ名にこの案件番号を選ぶと表示されます。"));
    return;
  }
  const table = el("table", "case-task-table");
  table.innerHTML = "<thead><tr><th>タスク</th><th>領域</th><th>担当者</th><th>優先度</th><th>期間</th><th>終了日</th></tr></thead>";
  const tbody = el("tbody");
  const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  for (const t of tasks) {
    const tr = el("tr");
    const left = Math.round((parseDate(t.end_date) - todayMs()) / DAY_MS);
    const due = left < 0 ? "overdue" : left <= 3 ? "soon" : "";
    const td = (text, cls = "") => { const x = el("td", cls, text); tr.append(x); return x; };
    const name = td(t.task, due ? `t-name ${due}` : "t-name");
    if (t.detail) name.title = t.detail;
    td(t.area, "nowrap");
    td((t.assignee || "").split(" ").filter(Boolean).join("・") || "—", "nowrap");
    const pr = td(t.priority, "nowrap prio");
    pr.dataset.v = t.priority;
    td(`${md(t.start_date)} 〜 ${md(t.end_date)}`, "nowrap");
    const end = td(t.end_date.replaceAll("-", "/"), `nowrap ${due}`);
    if (due) end.title = due === "overdue" ? `期限超過（${-left} 日経過）` : `期限まであと ${left} 日`;
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
}

// ---- 進捗メモ / 月報 のタブ切り替え
function setLogTab(tab) {
  document.querySelectorAll(".log-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.log === tab));
  $("#notes-section").hidden = tab !== "weekly";
  $("#monthly-section").hidden = tab !== "monthly";
  store.set("cases.logTab", tab);
}
document.querySelectorAll(".log-tabs button").forEach((b) => b.addEventListener("click", () => setLogTab(b.dataset.log)));
setLogTab(store.get("cases.logTab") === "monthly" ? "monthly" : "weekly");

// ---- 月報（月ごとに 1 件、同じ月に保存すると上書き）
const monthlyForm = $("#monthly-form");
let monthly = [];
const thisMonth = () => fmtDate(todayMs()).slice(0, 7);
const monthLabel = (m) => `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月`;

function setMonth(month) {
  monthlyForm.month.value = month;
  const existing = monthly.find((r) => r.month === month);
  monthlyForm.body.value = existing ? existing.body : "";
  $("#monthly-label").textContent = `${monthLabel(month)}${month === thisMonth() ? "・今月" : ""}`;
  $("#monthly-state").textContent = existing ? "この月は記入済みです（上書き保存されます）" : "新規記入";
}

async function loadMonthly(c) {
  monthly = await api(`/api/cases/${c.id}/monthly`);
  renderMonthly();
  setMonth(thisMonth());
}

function renderMonthly() {
  const ol = $("#monthly-list");
  ol.innerHTML = "";
  if (!monthly.length) {
    ol.append(el("li", "note-empty", "まだ月報がありません。"));
    return;
  }
  for (const r of monthly) {
    const li = el("li");
    if (r.month === thisMonth()) li.classList.add("current");
    const h = el("div", "nh");
    h.append(el("b", "", monthLabel(r.month)), el("span", "upd", `更新 ${r.updated_at.slice(0, 16)}`));
    const edit = el("button", "", "編集");
    edit.type = "button";
    edit.addEventListener("click", () => { setMonth(r.month); monthlyForm.body.focus(); });
    const del = el("button", "", "削除");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!confirm(`${monthLabel(r.month)}の月報を削除しますか？`)) return;
      try {
        await api(`/api/cases/${state.current.id}/monthly/${r.id}`, { method: "DELETE" });
        await afterMonthlyChange();
        toast("月報を削除しました");
      } catch (err) { toast(err.message, true); }
    });
    h.append(edit, del);
    li.append(h, el("div", "nb", r.body));
    ol.append(li);
  }
}

async function afterMonthlyChange() {
  const month = monthlyForm.month.value || thisMonth();
  monthly = await api(`/api/cases/${state.current.id}/monthly`);
  renderMonthly();
  setMonth(month);
}

monthlyForm.month.addEventListener("change", () => { if (monthlyForm.month.value) setMonth(monthlyForm.month.value); });

monthlyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = monthlyForm.body.value.trim();
  if (!body || !monthlyForm.month.value) return;
  try {
    await api(`/api/cases/${state.current.id}/monthly`, {
      method: "PUT",
      body: JSON.stringify({ month: monthlyForm.month.value, body }),
    });
    await afterMonthlyChange();
    toast("月報を保存しました");
  } catch (err) {
    toast(err.message, true);
  }
});

// ---- CSV インポート（案件番号で追加・更新）
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
  const fd = new FormData();
  fd.append("file", $("#import-file").files[0]);
  try {
    const res = await fetch("/api/cases/import", { method: "POST", body: fd });
    if (res.status === 401) { location.href = "/login?next=/cases"; return; }
    const data = await res.json();
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "取り込みに失敗しました");
    $("#dlg-import").close();
    await Promise.all([loadCases(), loadMasters()]);
    render();
    toast(`インポート完了: 追加 ${data.added} 件 / 更新 ${data.updated} 件 / 月報 ${data.monthly} 件 / 進捗メモ ${data.notes} 件`);
  } catch (err) {
    $("#import-error").textContent = err.message;
  }
});

// ---- 案件削除（案件番号の入力が必要）
const delForm = $("#form-delete");
$("#btn-delete").addEventListener("click", () => {
  const c = state.current;
  delForm.reset();
  $("#delete-no").textContent = `「${caseLabel(c)}」`;
  $("#delete-error").textContent = "";
  delForm.querySelector("button[type=submit]").disabled = true;
  $("#dlg-delete").showModal();
  delForm.confirm.focus();
});
delForm.confirm.addEventListener("input", () => {
  delForm.querySelector("button[type=submit]").disabled = delForm.confirm.value !== state.current?.case_no;
});
delForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const c = state.current;
  try {
    await api(`/api/cases/${c.id}?confirm=${encodeURIComponent(delForm.confirm.value)}`, { method: "DELETE" });
    $("#dlg-delete").close();
    drawer.close();
    await loadCases();
    render();
    toast(`案件 ${caseLabel(c)} を削除しました`);
  } catch (err) {
    $("#delete-error").textContent = err.message;
  }
});
$("#dlg-delete [data-close]").addEventListener("click", () => $("#dlg-delete").close());

// ------------------------------------------------------------ 選択肢（案件番号・企業名は管理サイトで登録）
async function loadMasters() {
  const [case_nos, customers] = await Promise.all(["case_nos", "customers"].map((k) => api(`/api/masters/${k}`)));
  state.masters = { case_nos, customers };
}

// ------------------------------------------------------------ データ読み込み・ツールバー
async function loadCases() {
  state.cases = await api("/api/cases");
  refreshPersonFilter();
}

function refreshPersonFilter() {
  const sel = $("#f-person");
  const names = new Set();
  for (const c of state.cases) {
    if (c.pl) names.add(c.pl);
    people(c).forEach((p) => names.add(p));
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b, "ja"));
  sel.innerHTML = "";
  sel.append(new Option("すべて", ""));
  for (const n of sorted) sel.append(new Option(n, n));
  if (!names.has(state.person)) state.person = "";
  sel.value = state.person;
}

function setView(v) {
  state.view = v;
  store.set("cases.view", v);
  document.querySelectorAll("#view-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  render();
}

document.querySelectorAll("#view-tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#btn-add").addEventListener("click", () => openDrawer());
$("#q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("#f-area").addEventListener("change", (e) => { state.area = e.target.value; render(); });
$("#f-person").addEventListener("change", (e) => { state.person = e.target.value; render(); });
$("#f-cancel").addEventListener("change", (e) => {
  state.showCancel = e.target.checked;
  if (!state.showCancel && state.status === "キャンセル") state.status = "";
  render();
});

(async () => {
  try {
    const [statuses, areas] = await Promise.all([api("/api/cases/statuses"), api("/api/masters/areas")]);
    state.statuses = statuses;
    state.areas = areas;
    const fa = $("#f-area");
    for (const a of areas) fa.append(new Option(a, a));
    // URL パラメータ: ?case=案件番号 でその案件の詳細を開く（ガントチャートからの移動用）、?q= で検索
    const params = new URLSearchParams(location.search);
    state.q = params.get("q") || "";
    await Promise.all([loadCases(), loadMasters()]);
    const saved = store.get("cases.view");
    const target = params.get("case") || params.get("pj");
    const hits = target ? state.cases.filter((c) => c.case_no === target) : [];
    const byId = state.cases.find((c) => String(c.id) === params.get("id")); // 個々の案件へのリンク（?id=）
    const found = byId || (hits.length === 1 ? hits[0] : null);
    if (target && !found) state.q = target; // 案件が無い・同じ番号で試験が複数ある場合は検索語として扱う
    $("#q").value = state.q;
    setView(["board", "list", "timeline"].includes(saved) ? saved : "board");
    if (found) openDrawer(found);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
