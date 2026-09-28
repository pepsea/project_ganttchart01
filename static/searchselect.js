"use strict";

// 検索できるプルダウン: 既存の <select> を隠し、開くと一番上に検索欄が付いた一覧を表示する。
// 値は元の <select> に入るので、フォームの読み書き（form.xxx.value）はそのまま使える。
// 選択肢を入れ替えた・値を変えたあとは sel._ss.refresh() で表示を更新する。
// 検索の対象は選択肢の文字と data-search（例: 案件番号の選択肢に案件名を入れる）。
function searchSelect(sel, { placeholder = "検索", allowEmpty = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "ss";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ss-btn";
  const panel = document.createElement("div");
  panel.className = "ss-panel";
  panel.hidden = true;
  const q = document.createElement("input");
  q.type = "search";
  q.className = "ss-q";
  q.placeholder = placeholder;
  q.autocomplete = "off";
  const list = document.createElement("ul");
  list.className = "ss-list";
  panel.append(q, list);
  wrap.append(btn, panel);
  sel.classList.add("ss-native");
  sel.removeAttribute("required"); // 隠した select は必須チェックできないため（保存時に確認する）
  sel.tabIndex = -1;
  sel.before(wrap);

  let items = [];
  let active = 0;

  function refresh() {
    const o = sel.selectedOptions[0];
    btn.textContent = o ? o.text : "";
    btn.classList.toggle("empty", !sel.value);
  }

  function renderList() {
    const text = q.value.trim().toLowerCase();
    items = [...sel.options].filter((o) => (o.value || allowEmpty) &&
      (!text || `${o.text} ${o.dataset.search || ""}`.toLowerCase().includes(text)));
    list.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "ss-none";
      li.textContent = "該当なし";
      list.append(li);
      return;
    }
    active = Math.max(0, Math.min(active, items.length - 1));
    items.forEach((o, i) => {
      const li = document.createElement("li");
      li.textContent = o.text;
      li.classList.toggle("on", o.value === sel.value);
      li.classList.toggle("active", i === active);
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(o.value); });
      list.append(li);
    });
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  function open() {
    q.value = "";
    active = Math.max(0, [...sel.options].filter((o) => o.value || allowEmpty).findIndex((o) => o.value === sel.value));
    panel.hidden = false;
    wrap.classList.add("open");
    renderList();
    q.focus();
  }

  function close() {
    panel.hidden = true;
    wrap.classList.remove("open");
  }

  function choose(value) {
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    refresh();
    close();
    btn.focus();
  }

  btn.addEventListener("click", () => (panel.hidden ? open() : close()));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
  });
  q.addEventListener("input", () => { active = 0; renderList(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); renderList(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); renderList(); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[active]) choose(items[active].value); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); }
  });
  q.addEventListener("blur", () => setTimeout(() => { if (!wrap.contains(document.activeElement)) close(); }, 0));
  document.addEventListener("mousedown", (e) => { if (!wrap.contains(e.target)) close(); });

  sel._ss = { refresh, open, close };
  refresh();
  return sel._ss;
}
