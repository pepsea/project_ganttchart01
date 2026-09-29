"use strict";

// 管理サイト: 領域・案件番号・基盤番号・顧客の登録／削除と、PJ名（案件番号＋基盤番号）の一覧
const CARDS = [
  { kind: "areas", title: "領域", desc: "ガントチャートのタスクと案件で使う領域です。", placeholder: "例: リピドミクス", color: true },
  { kind: "case_nos", title: "案件番号", desc: "案件管理で案件に割り当てる番号です。ガントチャートの PJ名（案件）にもなります。", placeholder: "例: C-2026-009" },
  { kind: "platforms", title: "基盤番号", desc: "ガントチャートの PJ名（基盤）として使う番号です。基盤名・目標は「基盤技術」ページで設定します。", placeholder: "例: K-003" },
  { kind: "customers", title: "企業名", desc: "案件管理の企業名として選択する企業です。", placeholder: "例: H製薬" },
  { kind: "pj", title: "PJ名", desc: "ガントチャートで選べる PJ名の一覧です（案件番号＋基盤番号）。登録・削除は各カードで行います。", readonly: true },
];

const $ = (sel, root = document) => root.querySelector(sel);
let data = {};
let caseNames = {};
const filters = {};

function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 4000 : 2200);
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
      else if (Array.isArray(d.detail)) msg = d.detail.map((x) => x.msg).join("\n");
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// ガントチャートと同じ領域の色
const areaColor = (i) => `hsl(${(210 + i * 67) % 360} 62% 50%)`;
const usageText = (usage) => Object.entries(usage).map(([k, v]) => `${k} ${v} 件`).join("・");

let closedNos = new Set(); // 終了（アーカイブ）・キャンセルの案件だけの番号
let closedLabel = {};

async function load() {
  const [masters, cases, platforms] = await Promise.all([api("/api/admin/masters"), api("/api/cases"), api("/api/platforms")]);
  data = masters;
  // 終了した案件番号: その番号の案件がすべてアーカイブ（終了）かキャンセル
  const byNo = {};
  for (const c of cases) (byNo[c.case_no] ||= []).push(c.status);
  closedNos = new Set(Object.entries(byNo)
    .filter(([, sts]) => sts.every((s) => s === "アーカイブ" || s === "キャンセル")).map(([n]) => n));
  closedLabel = Object.fromEntries(Object.entries(byNo).map(([n, sts]) =>
    [n, sts.every((s) => s === "キャンセル") ? "キャンセル" : sts.every((s) => s === "アーカイブ") ? "終了" : "終了・キャンセル"]));
  // 番号の横に表示する名前（案件名・基盤名）
  caseNames = Object.fromEntries([
    ...cases.map((c) => [c.case_no, c.name]),
    ...platforms.filter((p) => p.title).map((p) => [p.name, p.title]),
  ]);
  render();
}

function render() {
  const root = $("#cards");
  // 入力中の値とフォーカスを保持
  const typing = {};
  root.querySelectorAll("form input").forEach((i) => { typing[i.name] = i.value; });
  const focused = document.activeElement?.name;
  root.innerHTML = "";
  for (const card of CARDS) root.append(renderCard(card));
  root.querySelectorAll("form input").forEach((i) => { i.value = typing[i.name] || ""; });
  if (focused) root.querySelector(`[name="${focused}"]`)?.focus();
}

function renderCard(card) {
  const box = el("section", "admin-card");
  const items = card.kind === "pj"
    ? [
      ...data.case_nos.items.map((x) => ({ ...x, type: "case" })),
      ...data.platforms.items.map((x) => ({ ...x, type: "platform" })),
    ]
    : data[card.kind].items;

  const head = el("header");
  const h = el("h2", "", card.title);
  h.append(el("span", "count", `${items.length} 件`));
  head.append(h, el("p", "desc", card.desc));
  box.append(head);

  const err = el("p", "error");
  if (!card.readonly) {
    const form = el("form");
    const input = el("input");
    input.name = `new-${card.kind}`;
    input.placeholder = card.placeholder;
    input.autocomplete = "off";
    const btn = el("button", "primary", "登録");
    btn.type = "submit";
    form.append(input, btn);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      try {
        await api(`/api/masters/${card.kind}`, { method: "POST", body: JSON.stringify({ name }) });
        input.value = "";
        await load();
        toast(`${card.title}「${name}」を登録しました`);
        $(`[name="new-${card.kind}"]`)?.focus();
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
    box.append(form);
  }
  box.append(err);

  if (items.length > 8) {
    const fb = el("div", "filter-box");
    const fi = el("input");
    fi.type = "search";
    fi.placeholder = "絞り込み";
    fi.value = filters[card.kind] || "";
    fi.addEventListener("input", () => {
      filters[card.kind] = fi.value;
      rerender();
    });
    fb.append(fi);
    box.append(fb);
  }

  let rerender;
  if (card.kind === "case_nos") {
    const active = items.filter((x) => !closedNos.has(x.name));
    const closed = items.filter((x) => closedNos.has(x.name));
    const ul = el("ul");
    box.append(ul);
    const sub = el("div", "closed-area");
    const sh = el("h3", "", "終了・キャンセルの案件番号");
    sh.append(el("span", "count", `${closed.length} 件`));
    sub.append(sh);
    const ul2 = el("ul");
    sub.append(ul2);
    box.append(sub);
    rerender = () => { renderList(ul, card, active, err); renderList(ul2, card, closed, err); };
    rerender();
    return box;
  }
  const ul = el("ul");
  box.append(ul);
  rerender = () => renderList(ul, card, items, err);
  rerender();
  return box;
}

function renderList(ul, card, items, err) {
  ul.innerHTML = "";
  const q = (filters[card.kind] || "").trim().toLowerCase();
  const shown = items.filter((x) => !q || x.name.toLowerCase().includes(q) || (caseNames[x.name] || "").toLowerCase().includes(q));
  if (!shown.length) {
    ul.append(el("li", "empty", items.length ? "該当なし" : "まだ登録がありません"));
    return;
  }
  items.forEach((item, i) => {
    if (!shown.includes(item)) return;
    const li = el("li");
    if (card.color) {
      const sw = el("span", "swatch");
      sw.style.background = areaColor(i);
      li.append(sw);
    }
    if (card.kind === "pj") li.append(el("span", `type-badge ${item.type}`, item.type === "case" ? "案件" : "基盤"));
    const name = el("span", "name", item.name);
    if (card.kind === "case_nos" && closedNos.has(item.name)) li.append(el("span", "closed-badge", closedLabel[item.name]));
    const sub = card.kind !== "areas" && card.kind !== "customers" && caseNames[item.name];
    if (sub) {
      name.append(" ", el("span", "sub", caseNames[item.name]));
      name.title = `${item.name} ${caseNames[item.name]}`;
    }
    // 番号・名前が隠れないよう使用状況は表示しない（ツールチップで確認できる）
    li.title = usageText(item.usage) ? `使用中: ${usageText(item.usage)}` : "未使用";
    li.append(name);
    if (!card.readonly) {
      const edit = el("button", "", "修正");
      edit.title = "名前を修正（使用中のタスク・案件にも反映）";
      edit.addEventListener("click", () => startEdit(li, card, item, err));
      li.append(edit);
      const used = Object.keys(item.usage).length > 0;
      const del = el("button", "", "削除");
      del.disabled = used;
      del.title = used ? `使用中のため削除できません（${usageText(item.usage)}）` : "削除";
      del.addEventListener("click", async () => {
        if (!confirm(`${card.title}「${item.name}」を削除しますか？`)) return;
        try {
          await api(`/api/masters/${card.kind}/${encodeURIComponent(item.name)}`, { method: "DELETE" });
          await load();
          toast(`${card.title}「${item.name}」を削除しました`);
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
      li.append(del);
    }
    ul.append(li);
  });
}

// 名前をその場で修正。使用中のタスク・案件などにも新しい名前が反映される
function startEdit(li, card, item, err) {
  li.innerHTML = "";
  li.classList.add("editing");
  const input = el("input", "edit-input");
  input.value = item.name;
  const save = el("button", "primary", "保存");
  const cancel = el("button", "", "取消");
  li.append(input, save, cancel);
  input.focus();
  input.select();
  const usage = usageText(item.usage);
  const submit = async () => {
    const name = input.value.trim();
    if (!name || name === item.name) return load();
    if (usage && !confirm(`「${item.name}」を「${name}」に変更します。\n使用中の ${usage} も新しい名前に変わります。よろしいですか？`)) return;
    try {
      await api(`/api/masters/${card.kind}/${encodeURIComponent(item.name)}`, { method: "PUT", body: JSON.stringify({ name }) });
      await load();
      toast(`${card.title}「${item.name}」を「${name}」に変更しました`);
    } catch (ex) {
      err.textContent = ex.message;
    }
  };
  save.addEventListener("click", submit);
  cancel.addEventListener("click", () => { err.textContent = ""; load(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === "Escape") { err.textContent = ""; load(); }
  });
}

load().catch((e) => toast(`読み込みに失敗しました: ${e.message}`, true));
