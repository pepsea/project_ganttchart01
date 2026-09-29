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

// 基盤一覧の並び替え: 見出しをクリックでその列、もう一度で逆順（ブラウザに記憶）
const PF_COLS = [
  ["name", "基盤番号", (p) => p.name],
  ["title", "基盤名", (p) => p.title],
  ["areas", "領域", (p) => p.areas[0] ? String(state.areas.indexOf(p.areas[0])).padStart(3, "0") + p.areas.join(" ") : ""],
  ["owner", "PL", (p) => p.owner],
  ["members", "メンバー", (p) => p.members],
  ["task_count", "タスク", (p) => p.task_count],
  ["last_topic_date", "最新ディスカッション", (p) => p.last_topic_date],
  ["last_month", "最新の月報", (p) => p.last_month],
];
const pfSort = (() => {
  try { return JSON.parse(localStorage.getItem("platforms.sort")) || { key: "name", desc: false }; }
  catch (_) { return { key: "name", desc: false }; }
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
  const table = el("table", "pf-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const [key, label] of PF_COLS) {
    const th = el("th", `sortable${pfSort.key === key ? " sorted" : ""}`);
    th.append(label, el("span", "sort-mark", pfSort.key === key ? (pfSort.desc ? " ▼" : " ▲") : ""));
    th.title = "クリックで並び替え（もう一度で逆順）";
    th.addEventListener("click", () => {
      // 日付・件数は最初に押したとき新しい順・多い順
      const firstDesc = ["task_count", "last_topic_date", "last_month"].includes(key);
      if (pfSort.key === key) pfSort.desc = !pfSort.desc;
      else { pfSort.key = key; pfSort.desc = firstDesc; }
      try { localStorage.setItem("platforms.sort", JSON.stringify(pfSort)); } catch (_) { /* 保存できなくても並び替えは行う */ }
      renderList();
    });
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
  state.editing = false;
  state.dirty = false;
  state.current = null;
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
  state.current = name;
  state.dirty = false;
  const url = `/platforms?id=${enc(name)}`;
  if (fromList && location.pathname + location.search !== url) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
  const base = `/api/platforms/${enc(name)}`;
  [state.goals, state.topics, state.monthly] = await Promise.all(
    [api(`${base}/goals`), api(`${base}/topics`), api(`${base}/monthly`)]);
  renderList();
  renderDetail();
  const p = state.platforms.find((x) => x.name === name);
  $("#back-name").textContent = p ? `${p.name}　${p.title || ""}` : name;
  showView(true);
  $("#detail").scrollTop = 0;
}

$("#btn-back").addEventListener("click", () => backToList());
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
  const tasks = state.tasks.filter((t) => t.project === p.name).sort((a, b) => a.end_date.localeCompare(b.end_date));

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
  } else {
    modeBar.append(el("span", "hint", `基本情報・全体目標の修正は「編集する」から${p.updated_at ? `（最終更新 ${p.updated_at.slice(0, 16)}）` : ""}。目標・ディスカッション・月報はいつでも編集できます`));
    const edit = el("button", "", "✎ 編集する");
    edit.title = "基盤名・領域・PL・メンバー・全体目標を修正します";
    edit.addEventListener("click", () => setEditing(true));
    modeBar.append(edit);
  }
  root.append(modeBar);

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
    stat("目標の達成", `${p.goal_done}<small> / ${p.goal_total}</small>`),
    stat("期限超過の目標", `${overdue}<small> 件</small>`, overdue ? "warn" : ""),
    stat("次の期限", p.next_due ? `${p.next_due.slice(5).replace("-", "/")}<small> （あと ${daysLeft(p.next_due)} 日）</small>` : "—"),
  );
  head.append(summary);
  root.append(head);

  // 全体目標
  const visionSec = el("section", "pf-section");
  const vh = el("h3", "", "全体目標");
  vh.append(el("span", "hint", "この基盤で最終的に実現したいこと・目指す姿"));
  visionSec.append(vh);
  if (state.editing) {
    const vision = el("textarea", "vision");
    vision.name = "vision";
    vision.value = p.vision;
    vision.placeholder = "例: 受託解析の共通パイプラインを整備し、納期を 30% 短縮する";
    visionSec.append(vision);
  } else {
    visionSec.append(el("div", `vision-text${p.vision ? "" : " hint"}`, p.vision || "未記入"));
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

  // 並び: 目標 → ガントチャートのタスク → ディスカッション・月報（タブ）
  root.append(renderGoals(p));
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
  else if (kind) state[kind] = await api(`${base}/${kind}`);
  state.platforms = await api("/api/platforms");
  renderList();
  renderDetail();
  if (keep) restoreUnsaved(keep);
}

// ---- 目標: 一覧で読みやすく表示し、目標をクリックすると編集画面を開く
function renderGoals(p) {
  const sec = el("section", "pf-section pf-goals");
  const h = el("h3", "", "目標");
  const done = state.goals.filter((g) => g.status === "達成").length;
  h.append(el("span", "count-badge", `${done} / ${state.goals.length} 達成`));
  h.append(el("span", "hint", "目標をクリックすると編集できます"));
  const add = el("button", "primary right", "＋ 目標を追加");
  add.type = "button";
  add.addEventListener("click", () => openGoalDialog(p, null));
  h.append(add);
  sec.append(h);

  if (!state.goals.length) {
    sec.append(el("p", "hint", "まだ目標がありません。「＋ 目標を追加」から登録してください。"));
    return sec;
  }
  const ul = el("ul", "goal-list");
  for (const g of state.goals) {
    const li = el("li");
    li.tabIndex = 0;
    li.title = "クリックして編集";
    const due = goalDue(g);
    li.classList.toggle("done", g.status === "達成");
    if (due) li.classList.add(due);
    const st = el("span", "status-badge", g.status);
    st.dataset.v = g.status;
    const main = el("div", "g-main");
    const titleRow = el("div", "g-title");
    titleRow.append(g.title);
    if (safeUrl(g.url)) titleRow.append(" ", linkButton("リンク", g.url, "目標のリンク"));
    main.append(titleRow);
    if (g.note) main.append(el("div", "g-note", g.note));
    const d = el("span", `g-due ${due}`, g.due_date ? slashDate(g.due_date) : "期限なし");
    if (due) d.title = due === "overdue" ? `期限超過（${-daysLeft(g.due_date)} 日経過）` : `期限まであと ${daysLeft(g.due_date)} 日`;
    li.append(st, main, d, el("span", "g-edit", "編集 ›"));
    const open = () => openGoalDialog(p, g);
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    ul.append(li);
  }
  sec.append(ul);
  return sec;
}

// 目標の追加・編集ダイアログ
let goalEditing = null; // { platform, goal }
function openGoalDialog(p, g) {
  goalEditing = { platform: p.name, goal: g };
  const f = $("#form-goal");
  f.reset();
  f.status.innerHTML = "";
  for (const st of state.statuses) f.status.append(new Option(st, st));
  f.status.value = g ? g.status : "未着手";
  f.title.value = g ? g.title : "";
  f.due_date.value = g?.due_date || "";
  f.note.value = g?.note || "";
  f.url.value = g?.url || "";
  $("#goal-title").textContent = g ? "目標の編集" : "目標の追加";
  $("#goal-meta").textContent = g ? `${p.name} ${p.title}　／　最終更新 ${g.updated_at.slice(0, 16)}` : `${p.name} ${p.title}`;
  $("#goal-submit").textContent = g ? "保存" : "追加";
  $("#goal-delete").hidden = !g;
  $("#goal-error").textContent = "";
  $("#dlg-goal").showModal();
  (g ? f.status : f.title).focus();
}
$("#dlg-goal [data-close]").addEventListener("click", () => $("#dlg-goal").close());
$("#form-goal").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const { platform, goal } = goalEditing;
  const body = { title: f.title.value.trim(), status: f.status.value, due_date: f.due_date.value || null, note: f.note.value, url: f.url.value.trim() };
  if (body.url && !safeUrl(body.url)) { $("#goal-error").textContent = "リンクは http:// または https:// で始まる URL を入力してください"; return; }
  if (!body.title) { $("#goal-error").textContent = "目標を入力してください"; return; }
  const url = `/api/platforms/${enc(platform)}/goals`;
  try {
    await api(goal ? `${url}/${goal.id}` : url, { method: goal ? "PUT" : "POST", body: JSON.stringify(body) });
    $("#dlg-goal").close();
    await refreshAfterChange("goals");
    toast(goal ? "目標を保存しました" : "目標を追加しました");
  } catch (err) {
    $("#goal-error").textContent = err.message;
  }
});
$("#goal-delete").addEventListener("click", () => {
  const { platform, goal } = goalEditing;
  if (!goal) return;
  $("#dlg-goal").close();
  confirmPasswordDelete(`/api/platforms/${enc(platform)}/goals/${goal.id}`, "目標", `目標: ${goal.title}`, "goals");
});

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
// 左: タスク名（実施中 = 青、3 日以内 = オレンジ、超過 = 赤）・担当者・開始日・終了日・残り日数
// 右: 日付の帯（領域の色）、今日の線、土日
function renderTasks(p, tasks) {
  const sec = el("section", "pf-section pf-tasks");
  const h = el("h3", "", "ガントチャートのタスク");
  h.append(el("span", "hint", `${tasks.length} 件（表示のみ。追加・編集はガントチャートで）`));
  const legend = el("span", "pg-legend");
  for (const [cls, label] of [["overdue", "期限超過"], ["soon", "期限3日以内"], ["active", "実施中"]]) {
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
    const left = daysLeft(t.end_date);
    const due = left < 0 ? "overdue" : left <= 3 ? "soon" : "";
    const active = !due && daysLeft(t.start_date) <= 0 ? "active" : ""; // 実施中 = 今日が開始日〜終了日の間
    const row = el("div", "pg-row");
    const lc = el("div", "pg-left");
    const name = el("span", `t-name ${due || active}`.trim(), t.task);
    name.title = `${t.task}${t.detail ? "\n\n" + t.detail : ""}`;
    const rest = left < 0 ? `${-left} 日超過` : left === 0 ? "今日まで" : `あと ${left} 日`;
    const rc = el("span", `days-left${left < 0 ? " over" : left <= 7 ? " near" : ""}`, rest);
    lc.append(name, el("span", "who", t.assignee || "—"), el("span", "dt", slashDate(t.start_date)),
      el("span", "dt", slashDate(t.end_date)), rc);
    const track = el("div", "pg-track");
    const bar = el("div", "pg-bar");
    const s0 = x(parseDate(t.start_date));
    bar.style.left = `${s0}px`;
    bar.style.width = `${Math.max(x(parseDate(t.end_date) + DAY_MS) - s0, 6)}px`;
    bar.style.setProperty("--c", areaColor(t.area));
    bar.append(el("span", `prio p-${t.priority}`), el("span", "lbl", t.task));
    bar.title = `${t.task}\n領域: ${t.area} / 担当: ${t.assignee || "-"} / 優先度: ${t.priority}\n${t.start_date} 〜 ${t.end_date}（${rest}）`;
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
  syncExportLinks();
});

$("#f-area").addEventListener("change", (e) => {
  state.filterArea = e.target.value;
  store.set("platforms.area", state.filterArea);
  renderList();
  syncExportLinks();
});

// ---- CSV エクスポート（左の領域の絞り込みを反映）
function syncExportLinks() {
  const month = $("#export-month").value;
  const conds = [];
  if (state.filterArea) conds.push(`領域「${state.filterArea}」`);
  if (state.filterPerson) conds.push(`メンバー「${state.filterPerson}」`);
  $("#export-scope").textContent = conds.length ? `対象: ${conds.join("・")}の基盤（左の絞り込みを反映）` : "対象: すべての基盤";
  document.querySelectorAll("#export-menu [data-export]").forEach((a) => {
    const params = new URLSearchParams();
    if (state.filterArea) params.set("area", state.filterArea);
    if (state.filterPerson) params.set("person", state.filterPerson);
    if (a.hasAttribute("data-month")) {
      if (month) params.set("month", month);
      a.toggleAttribute("aria-disabled", !month);
    }
    const q = params.toString();
    a.href = `/api/platforms/${a.dataset.export}${q ? `?${q}` : ""}`;
  });
}
$("#export-month").value = thisMonth();
$("#export-month").addEventListener("input", syncExportLinks);
syncExportLinks();
// メニューの外をクリックしたら閉じる
document.addEventListener("click", (e) => {
  const menu = $("#export-menu");
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
document.querySelectorAll("#export-menu a[data-export]").forEach((a) =>
  a.addEventListener("click", () => setTimeout(() => { $("#export-menu").open = false; }, 100)));

// ---- CSV インポート（エクスポートした 4 種類を自動判別）
$("#btn-import").addEventListener("click", () => {
  if (state.dirty && !confirm("基本情報・全体目標に未保存の変更があります。インポート後に画面を更新すると失われます。続けますか？")) return;
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
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await fetch("/api/platforms/import", { method: "POST", body: fd });
    if (res.status === 401) { location.href = "/login?next=/platforms"; return; }
    const d = await res.json();
    if (!res.ok) throw new Error(typeof d.detail === "string" ? d.detail : "取り込みに失敗しました");
    $("#dlg-import").close();
    const label = { backup: "全データ", platforms: "基盤一覧＋月報", monthly: "月報一覧", goals: "目標一覧", topics: "ディスカッション一覧" }[d.kind];
    const parts = [];
    if (d.platforms_added) parts.push(`基盤 新規 ${d.platforms_added}`);
    if (d.platforms_updated) parts.push(`基盤 更新 ${d.platforms_updated}`);
    if (d.monthly) parts.push(`月報 ${d.monthly}`);
    if (d.goals_added || d.goals_updated) parts.push(`目標 追加 ${d.goals_added}・更新 ${d.goals_updated}`);
    if (d.topics_added || d.topics_updated) parts.push(`ディスカッション 追加 ${d.topics_added}・更新 ${d.topics_updated}`);
    state.dirty = false;
    state.editing = false;
    state.platforms = await api("/api/platforms");
    renderList();
    if (state.current) await select(state.current);
    toast(`インポート完了（${label}）: ${parts.join(" / ") || "変更なし"}`);
  } catch (err) {
    $("#import-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
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
    syncExportLinks();
    renderList();
    const want = new URLSearchParams(location.search).get("id");
    if (want && platforms.some((p) => p.name === want)) await select(want);
    else showView(false);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`, true);
  }
})();
