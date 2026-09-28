"use strict";

// 個人: 左に人の一覧、右に選んだ人のタスク（状態を色で表示）と担当（領域・グループ・基盤技術・案件・サービス）。表示のみ
const $ = (sel, root = document) => root.querySelector(sel);
const state = { people: [], current: null, q: "", areas: [] };
// タスクの状態（ガントチャートと同じ色）: 期限超過 = 赤、期限 3 日以内 = オレンジ、実施中 = 青、開始前 = 灰
const TASK_STATES = [["overdue", "期限超過"], ["soon", "期限3日以内"], ["active", "実施中"], ["waiting", "開始前"]];
const stateLabel = (k) => TASK_STATES.find(([x]) => x === k)?.[1] || "";

// ------------------------------------------------------------ utils
function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
const slashDate = (s) => (s ? s.replaceAll("-", "/") : "");
const enc = encodeURIComponent;
// 領域の色（ガントチャートなどと同じ）
function areaColor(area) {
  let i = state.areas.indexOf(area);
  if (i < 0) i = state.areas.length;
  return `hsl(${(210 + i * 67) % 360} 62% 50%)`;
}
function areaPill(a, cls = "area-pill") {
  const s = el("span", cls, a);
  s.style.setProperty("--c", areaColor(a));
  return s;
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: options.body ? { "Content-Type": "application/json" } : {}, ...options });
  if (res.status === 401) {
    location.href = `/login?next=${enc(location.pathname + location.search)}`;
    throw new Error("ログインが必要です");
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function toast(msg, isErr = true) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 4000 : 2200);
}

// 別タブで開くリンク
function extLink(parts, href, cls = "chip") {
  const a = el("a", cls);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.append(...(Array.isArray(parts) ? parts : [parts]));
  return a;
}
const roleTag = (role) => el("span", `role-tag${role === "PL" ? " pl" : ""}`, role);

// タスクの状態ごとの件数（小さな色付きの数字）
function stateCounts(counts, withZero = false) {
  const box = el("span", "st-counts");
  for (const [k, label] of TASK_STATES) {
    const n = counts[k] || 0;
    if (!n && !withZero) continue;
    const s = el("span", `st-count st-${k}`, String(n));
    s.title = `${label} ${n} 件`;
    box.append(s);
  }
  return box;
}

// ------------------------------------------------------------ 一覧
function renderList() {
  const ul = $("#pp-items");
  ul.innerHTML = "";
  const q = state.q.toLowerCase();
  const list = state.people.filter((p) => !q || p.name.toLowerCase().includes(q));
  if (!list.length) {
    ul.append(el("li", "hint pp-empty", state.people.length ? "該当する人がいません" : "まだ登録がありません"));
    return;
  }
  for (const p of list) {
    const li = el("li", "pp-item");
    li.classList.toggle("on", p.name === state.current);
    const top = el("div", "pp-top");
    top.append(el("span", "ttl", p.name), stateCounts(p.task_counts));
    const meta = [`タスク ${p.tasks}`, p.cases && `案件 ${p.cases}`, p.platforms && `基盤 ${p.platforms}`,
      p.groups && `グループ ${p.groups}`, p.services && `サービス ${p.services}`].filter(Boolean).join("・");
    li.append(top, el("div", "meta", meta));
    li.addEventListener("click", () => select(p.name));
    ul.append(li);
  }
}

// 保存していないメモがあるか
let memoDirty = false;
window.addEventListener("beforeunload", (e) => { if (memoDirty) { e.preventDefault(); e.returnValue = ""; } });

async function select(name) {
  if (memoDirty && name !== state.current && !confirm("保存していないメモがあります。破棄して切り替えますか？")) return;
  memoDirty = false;
  state.current = name;
  history.replaceState(null, "", `/people?name=${enc(name)}`);
  renderList();
  const root = $("#detail");
  root.innerHTML = "";
  root.append(el("p", "hint pp-empty", "読み込み中…"));
  try {
    const d = await api(`/api/people/${enc(name)}`);
    if (state.current === name) renderDetail(d);
  } catch (err) {
    toast(`読み込めませんでした: ${err.message}`);
  }
}

// ------------------------------------------------------------ 詳細
function renderDetail(d) {
  const root = $("#detail");
  root.innerHTML = "";

  // 見出し: 名前とタスクの状態ごとの件数
  const head = el("div", "pp-head");
  const nameBox = el("div");
  nameBox.append(el("h2", "", d.name));
  const roles = [d.groups.length && `グループ ${d.groups.length}`, d.platforms.length && `基盤技術 ${d.platforms.length}`,
    d.cases.length && `案件 ${d.cases.length}`, d.services.length && `サービス ${d.services.length}`].filter(Boolean);
  nameBox.append(el("div", "hint", roles.length ? `担当: ${roles.join("・")}` : "担当の登録はありません"));
  head.append(nameBox, el("span", "spacer"));
  const stats = el("div", "stats");
  for (const [k, label] of TASK_STATES) {
    const s = el("div", `stat st-${k}`);
    s.append(el("div", "k", label));
    const v = el("div", "v", String(d.task_counts[k] || 0));
    v.append(el("small", "", " 件"));
    s.append(v);
    stats.append(s);
  }
  head.append(stats);
  root.append(head);

  // メモ（人ごとに 1 件。タスクの上）
  const ms = el("section", "pp-section pp-memo");
  const mh = el("h3", "", "メモ");
  const upd = el("span", "hint memo-upd", d.memo_updated_at ? `最終更新 ${d.memo_updated_at.slice(0, 16)}` : "");
  const save = el("button", "primary memo-save", "保存");
  save.type = "button";
  save.disabled = true;
  mh.append(upd, save);
  const ta = el("textarea", "memo-text");
  ta.rows = 4;
  ta.placeholder = `${d.name} さんについてのメモ（予定、注意事項、引き継ぎなど）`;
  ta.value = d.memo || "";
  ta.addEventListener("input", () => {
    memoDirty = ta.value !== (d.memo || "");
    save.disabled = !memoDirty;
    save.textContent = memoDirty ? "保存（未保存）" : "保存";
  });
  save.addEventListener("click", async () => {
    try {
      const r = await api(`/api/people/${enc(d.name)}/memo`, { method: "PUT", body: JSON.stringify({ body: ta.value }) });
      d.memo = r.memo;
      d.memo_updated_at = r.memo_updated_at;
      memoDirty = false;
      save.disabled = true;
      save.textContent = "保存";
      upd.textContent = `最終更新 ${r.memo_updated_at.slice(0, 16)}`;
      toast("メモを保存しました", false);
    } catch (err) {
      toast(`保存できませんでした: ${err.message}`);
    }
  });
  ms.append(mh, ta);
  root.append(ms);

  // タスク（ガントチャートで担当者がこの人のもの。終了日順）
  const ts = el("section", "pp-section");
  const th = el("h3", "", `タスク`);
  th.append(el("span", "count", `${d.tasks.length} 件`));
  const legend = el("span", "legend");
  for (const [k, label] of TASK_STATES) {
    const lg = el("span", `st-${k}`);
    lg.append(el("i"), label);
    legend.append(lg);
  }
  th.append(legend, extLink("ガントチャートで開く ↗", `/?q=${enc(d.name)}`, "open-btn"));
  ts.append(th);
  if (!d.tasks.length) ts.append(el("p", "hint", "担当のタスクはありません"));
  const ul = el("ul", "task-list");
  for (const t of d.tasks) {
    const li = el("li", `st-${t.state}`);
    li.append(el("span", "st-badge", stateLabel(t.state)), el("span", "t-name", t.task));
    li.append(t.project
      ? extLink(`${t.project}${t.project_name ? `｜${t.project_name}` : ""}`, `/?pj=${enc(t.project)}`, "t-pj")
      : el("span", "t-pj none", "PJ名なし"));
    li.append(areaPill(t.area, "t-area"), el("span", `t-prio p-${t.priority}`, `優先度 ${t.priority}`),
      el("span", "t-date", `${slashDate(t.start_date)} 〜 ${slashDate(t.end_date)}`));
    li.title = `${t.task}\n${stateLabel(t.state)} / 優先度 ${t.priority}\n${t.start_date} 〜 ${t.end_date}`;
    ul.append(li);
  }
  ts.append(ul);
  root.append(ts);

  // 担当（領域・グループ・基盤技術・案件・サービス）
  const grid = el("div", "pp-grid");
  const box = (title, items, empty = "なし") => {
    const sec = el("section", "pp-section");
    const h = el("h3", "", title);
    h.append(el("span", "count", `${items.length} 件`));
    sec.append(h);
    const list = el("div", "chips");
    if (items.length) list.append(...items);
    else list.append(el("span", "hint", empty));
    sec.append(list);
    return sec;
  };
  grid.append(
    box("担当領域", d.areas.map((a) => areaPill(a))),
    box("担当グループ", d.groups.map((g) => extLink([roleTag(g.role), g.name, el("span", "arrow", "↗")], `/groups?id=${g.id}&year=all`))),
    box("担当基盤技術", d.platforms.map((p) => extLink([roleTag(p.role), el("b", "", p.name), p.title, el("span", "arrow", "↗")],
      `/platforms?id=${enc(p.name)}`))),
    box("担当サービス", d.services.map((s) => extLink([roleTag(s.role), el("b", "", s.service_no), s.name, el("span", "arrow", "↗")],
      `/services#svc-${enc(s.service_no)}`))),
  );
  root.append(grid);

  // 担当案件（キャンセル以外。終了予定日順）
  const cs = el("section", "pp-section");
  const ch = el("h3", "", "担当案件");
  ch.append(el("span", "count", `${d.cases.length} 件`), el("span", "hint", "キャンセル以外"));
  cs.append(ch);
  if (!d.cases.length) cs.append(el("p", "hint", "なし"));
  const cl = el("ul", "case-list");
  for (const c of d.cases) {
    const li = el("li");
    li.append(roleTag(c.role), extLink([el("b", "", c.trial && /^\d+$/.test(c.trial) ? `${c.case_no}-${c.trial}` : c.case_no),
      c.trial && !/^\d+$/.test(c.trial) ? el("span", "trial", c.trial) : "", ` ${c.name} ↗`], `/cases?case=${enc(c.case_no)}`, "c-link"),
      el("span", "c-cust", c.customer || ""), el("span", "c-status", c.status),
      el("span", "c-end", c.end_date ? `終了予定 ${slashDate(c.end_date)}` : "終了予定 未設定"));
    cl.append(li);
  }
  cs.append(cl);
  root.append(cs);
}

// ------------------------------------------------------------ 読み込み
$("#pp-q").addEventListener("input", (e) => {
  state.q = e.target.value.trim();
  renderList();
});

(async () => {
  try {
    [state.people, state.areas] = await Promise.all([api("/api/people"), api("/api/masters/areas")]);
    const want = new URLSearchParams(location.search).get("name");
    const target = state.people.find((p) => p.name === want) || state.people[0];
    renderList();
    if (target) await select(target.name);
  } catch (err) {
    toast(`読み込みに失敗しました: ${err.message}`);
  }
})();
