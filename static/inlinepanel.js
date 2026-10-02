"use strict";

// 右の窓（項目の詳細）で、ポップアップを使わずその場に書くための共通部品（基盤技術・グループで使う）。
// el() は各画面のスクリプトで定義したものを使う
const panelDrafts = new Map(); // 書きかけの入力（再描画しても消えないように保持）。key → { values, changed }
const panelDirty = () => [...panelDrafts.values()].some((d) => d.changed);
// 書きかけを捨ててよいか確認（keys を指定するとその入力だけ）
function confirmDiscard(keys = null) {
  const list = keys ? keys.map((k) => panelDrafts.get(k)).filter(Boolean) : [...panelDrafts.values()];
  if (list.some((d) => d.changed) && !confirm("書きかけの内容が保存されていません。破棄しますか？")) return false;
  if (keys) keys.forEach((k) => panelDrafts.delete(k)); else panelDrafts.clear();
  return true;
}
const editKey = (e) => (e ? `${e.kind}:${e.id ?? "new"}` : "");

function panelField(label, input, cls = "") {
  const l = el("label", `gpn-field ${cls}`.trim());
  l.append(el("span", "", label), input);
  return l;
}
function panelInput(name, attrs = {}) {
  const i = el(attrs.tag || "input");
  i.name = name;
  for (const [k, v] of Object.entries(attrs)) if (k !== "tag") i[k] = v;
  return i;
}
// 入力欄に値を入れ、書きかけを panelDrafts に残す。Ctrl / ⌘ + Enter で保存、Esc で取消
function bindPanelForm(form, key, initial, onCancel) {
  const draft = panelDrafts.get(key) || { values: {}, changed: false };
  panelDrafts.set(key, draft);
  for (const [n, v] of Object.entries(initial)) {
    const i = form.elements.namedItem(n);
    if (i) i.value = n in draft.values ? draft.values[n] : (v ?? "");
  }
  form.addEventListener("input", (e) => {
    if (!e.target.name) return;
    draft.values[e.target.name] = e.target.value;
    draft.changed = true;
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
    else if (e.key === "Escape" && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
  });
}
function panelActions(form, { submitLabel, onCancel, onDelete }) {
  const bar = el("div", "gpn-form-actions");
  if (onDelete) {
    const del = el("button", "danger-outline", "削除…");
    del.type = "button";
    del.addEventListener("click", onDelete);
    bar.append(del);
  }
  bar.append(el("span", "spacer"), el("span", "hint", "Ctrl+Enter で保存"));
  if (onCancel) {
    const c = el("button", "", "キャンセル");
    c.type = "button";
    c.addEventListener("click", onCancel);
    bar.append(c);
  }
  const s = el("button", "primary", submitLabel);
  s.type = "submit";
  bar.append(s);
  const err = el("p", "error");
  form.append(err, bar);
  return err;
}
const focusLater = (input) => requestAnimationFrame(() => input.focus());

// 窓の幅: 左端のつまみをドラッグして変えられる（幅はブラウザに保存。ダブルクリックで元の幅）
function enablePanelResize(panel, handle, storeKey) {
  const get = () => { try { return localStorage.getItem(storeKey); } catch (_) { return null; } };
  const set = (v) => { try { localStorage.setItem(storeKey, v); } catch (_) { /* ignore */ } };
  const clamp = (w) => Math.max(320, Math.min(w, window.innerWidth - 40));
  const apply = (w) => { panel.style.width = `${clamp(w)}px`; };
  const saved = Number(get());
  if (saved) apply(saved);
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("gpn-resizing");
    const move = (ev) => apply(window.innerWidth - ev.clientX);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("gpn-resizing");
      set(String(parseInt(panel.style.width, 10)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("dblclick", () => { panel.style.width = ""; set(""); });
  window.addEventListener("resize", () => { if (panel.style.width) apply(parseInt(panel.style.width, 10)); });
}
