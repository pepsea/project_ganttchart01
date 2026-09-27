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
  QC: "#d99a00",
  アフターフォロー: "#1f9fb4",
  キャンセル: "#a9adb6",
};
// 期限（終了予定日）の色分け対象外
const NO_DEADLINE = new Set(["アフターフォロー", "キャンセル"]);
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
  masters: { case_nos: [], customers: [] }, // 登録済みの案件番号（= ガントチャートの PJ名）・顧客
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

// 終了予定日: 過ぎたら赤（overdue）、2 週間を切ったらオレンジ（soon）。アフターフォロー・キャンセルは対象外
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
const ganttUrl = (no) => `/?pj=${encodeURIComponent(no)}`;

function caseNoTag(c) {
  const tag = el("span", "pj-tag");
  tag.title = `案件番号（PJ名）: ${c.case_no}`;
  const link = el("a", "mini-link", "ガント ↗");
  link.href = ganttUrl(c.case_no);
  link.target = "_blank";
  link.rel = "noopener";
  link.title = `ガントチャートでこの案件のタスクを表示（${c.task_count ?? 0} 件）`;
  link.addEventListener("click", (e) => e.stopPropagation());
  tag.append(c.case_no, link);
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
    if (q && ![c.case_no, c.customer, c.name].some((v) => (v || "").toLowerCase().includes(q))) return false;
    return true;
  });
}

const byEnd = (a, b) =>
  (a.end_date || "9999").localeCompare(b.end_date || "9999") || a.case_no.localeCompare(b.case_no);

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

// 最初の画面（カード・一覧）には未設定のリンクだけを赤で出す（設定済みのリンクは詳細画面の「開く」から）
function linkIcons(c) {
  const box = el("span", "links");
  for (const [key, short, label] of LINKS) {
    if (safeUrl(c[key])) continue;
    const s = el("span", "link-ic", short);
    s.title = `${label}: 未設定（案件を開いて登録）`;
    box.append(s);
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
  if (c.customer) card.append(el("div", "cust", c.customer));

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

async function changeStatus(c, status) {
  if (status === "キャンセル" && !confirm(`案件「${c.name}」をキャンセルにしますか？`)) return;
  const prev = c.status;
  try {
    Object.assign(c, await api(`/api/cases/${c.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }));
    render();
    toast(`${c.case_no} を「${status}」に変更しました`);
  } catch (err) {
    c.status = prev;
    toast(err.message, true);
  }
}

// ---- 一覧
const COLUMNS = [
  ["status", "状況"], ["case_no", "案件番号"], ["customer", "顧客名"], ["name", "案件名"], ["pl", "PL"],
  ["assignees", "担当者"], ["areas", "領域"], ["start_date", "開始日"], ["end_date", "終了予定日"],
  ["links", "未設定リンク"], ["last_note_date", "最新の進捗"],
];

function renderList() {
  const wrap = el("div", "table-wrap");
  const table = el("table", "cases");
  const thead = el("thead");
  const hr = el("tr");
  for (const [key, label] of COLUMNS) {
    const th = el("th", "", label);
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
    cell(c.case_no, "nowrap");
    cell(c.customer);
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
    if (c.last_note_date) memo.append(el("span", "wk", `${shortDate(c.last_note_date)}（全 ${c.note_count} 件）`), c.last_note);
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
  const LEFT_W = 320;
  const all = filtered();
  const dated = all.filter((c) => c.start_date && c.end_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || byEnd(a, b));
  const undated = all.length - dated.length;

  const today = todayMs();
  let min = today - 60 * DAY_MS;
  let max = today + 120 * DAY_MS;
  for (const c of dated) {
    min = Math.min(min, parseDate(c.start_date) - 14 * DAY_MS);
    max = Math.max(max, parseDate(c.end_date) + 30 * DAY_MS);
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

  for (const c of dated) {
    const row = el("div", "tl-row");
    const left = el("div", "tl-left");
    left.append(el("span", "no", c.case_no), el("span", "nm", `${c.customer ? c.customer + "｜" : ""}${c.name}`));
    left.title = `${c.case_no} ${c.customer} ${c.name}`;
    left.addEventListener("click", () => openDrawer(c));
    const track = el("div", "tl-track");
    track.style.width = `${W}px`;
    const bar = el("div", "tl-bar", c.status);
    bar.style.setProperty("--c", STATUS_COLOR[c.status]);
    const s = x(parseDate(c.start_date));
    bar.style.left = `${s}px`;
    bar.style.width = `${Math.max(x(parseDate(c.end_date) + DAY_MS) - s, 6)}px`;
    bar.title = `${c.case_no} ${c.name}\n${c.status}\n${c.start_date} 〜 ${c.end_date}`;
    const after = el("span", "after", [c.pl && `PL ${c.pl}`, shortDate(c.end_date)].filter(Boolean).join(" / "));
    bar.append(after);
    bar.addEventListener("click", () => openDrawer(c));
    track.append(bar);
    row.append(left, track);
    tl.append(row);
  }
  view.append(tl);
  if (undated) view.append(el("div", "tl-note", `※ 開始日・終了予定日が未設定の案件 ${undated} 件はタイムラインに表示されません（カンバン・一覧で確認できます）。`));
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

// 案件番号: 他の案件で使用中の番号は除外（自分の番号は残す）
function fillCaseNoSelect(current = "") {
  const used = new Set(state.cases.filter((x) => x.id !== state.current?.id).map((x) => x.case_no));
  const opts = state.masters.case_nos.filter((n) => !used.has(n));
  if (current && !opts.includes(current)) opts.push(current);
  const sel = form.case_no;
  sel.innerHTML = "";
  sel.append(new Option(opts.length ? "選択してください" : "未使用の案件番号がありません（管理サイトで登録）", ""));
  for (const n of opts) sel.append(new Option(n, n));
  sel.value = current;
}

// 詳細パネル: 案件番号（= PJ名）からガントチャートへ移動
function syncNoCopy() {
  const no = form.case_no.value;
  const a = $("#d-no-link");
  a.hidden = !no;
  if (no) {
    a.href = ganttUrl(no);
    const n = state.current && state.current.case_no === no ? state.current.task_count : null;
    a.title = `ガントチャートでこの案件のタスクを表示${n !== null ? `（${n} 件）` : ""}`;
  }
}
form.case_no.addEventListener("change", syncNoCopy);

function fillCustomerSelect(current = "") {
  const opts = [...state.masters.customers];
  if (current && !opts.includes(current)) opts.push(current);
  const sel = form.customer;
  sel.innerHTML = "";
  sel.append(new Option("（未選択）", ""));
  for (const n of opts) sel.append(new Option(n, n));
  sel.value = current;
}

// リンク: 有効な URL が入力されたら「開く」をアクティブにする
function syncLinks() {
  document.querySelectorAll("#case-form .open-link").forEach((a) => {
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
    $("#d-no").textContent = c.case_no;
    $("#d-title").textContent = c.name;
    for (const k of ["name", "detail", "status", "pl", "assignees", "start_date", "end_date",
      "box_url", "teams_url", "overview_url", "plan_url", "link1_label", "link1_url", "link2_label", "link2_url"]) form[k].value = c[k] || "";
    renderAreaChecks(c.areas);
    $("#btn-delete").hidden = false;
    $("#logs").hidden = false;
    loadNotes(c);
    loadMonthly(c);
    loadCaseTasks(c);
  } else {
    $("#d-no").textContent = "新規";
    $("#d-title").textContent = "案件追加";
    sel.value = state.status || "顧客開発";
    renderAreaChecks(state.area ? [state.area] : []);
    $("#btn-delete").hidden = true;
    $("#logs").hidden = true;
    $("#tasks-section").hidden = true;
  }
  syncLinks();
  syncNoCopy();
  if (!drawer.open) drawer.showModal();
  (c ? $("#note-form").body : form.case_no).focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {};
  for (const k of ["case_no", "customer", "name", "detail", "status", "pl", "assignees", "start_date", "end_date",
    "box_url", "teams_url", "overview_url", "plan_url", "link1_label", "link1_url", "link2_label", "link2_url"]) body[k] = form[k].value.trim();
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
  $("#case-task-link").href = ganttUrl(c.case_no);
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
    td(t.assignee || "—", "nowrap");
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
  $("#delete-no").textContent = `「${c.case_no}」`;
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
    toast(`案件 ${c.case_no} を削除しました`);
  } catch (err) {
    $("#delete-error").textContent = err.message;
  }
});
$("#dlg-delete [data-close]").addEventListener("click", () => $("#dlg-delete").close());

// ------------------------------------------------------------ 選択肢（案件番号・顧客は管理サイトで登録）
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
    const found = target && state.cases.find((c) => c.case_no === target);
    if (target && !found) state.q = target; // 案件が無い場合は検索語として扱う
    $("#q").value = state.q;
    setView(["board", "list", "timeline"].includes(saved) ? saved : "board");
    if (found) openDrawer(found);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
