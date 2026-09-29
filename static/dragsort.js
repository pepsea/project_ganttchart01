"use strict";

// ドラッグ＆ドロップで順番を入れ替える共通部品（共有資料・参考リンクで使う）。
// 行の左端のつまみ（⠿）をつかんで、置きたい場所で離す。同じ一覧の中だけで入れ替えられる。
//   enableDragSort(li, handle, { group, id, ids, onDrop })
//   group  : 一覧を区別するもの（別の一覧には置けない）
//   id     : この行の id
//   ids()  : 今の一覧の全 id を上から順に返す
//   onDrop : 新しい順番（id の配列）を受け取って保存する
let dragSortState = null; // { group, id }

function enableDragSort(li, handle, { group, id, ids, onDrop }) {
  handle.addEventListener("mousedown", () => { li.draggable = true; });
  handle.addEventListener("click", (e) => e.stopPropagation());
  li.addEventListener("dragstart", (e) => {
    dragSortState = { group, id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
    li.classList.add("dragging");
  });
  li.addEventListener("dragend", () => {
    li.draggable = false;
    dragSortState = null;
    li.classList.remove("dragging");
    document.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  });
  li.addEventListener("dragover", (e) => {
    if (!dragSortState || dragSortState.group !== group || dragSortState.id === id) return;
    e.preventDefault();
    const r = li.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    li.classList.toggle("drop-after", after);
    li.classList.toggle("drop-before", !after);
  });
  li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = dragSortState && dragSortState.group === group ? dragSortState.id : null;
    const after = li.classList.contains("drop-after");
    li.classList.remove("drop-before", "drop-after");
    if (from === null || from === id) return;
    const order = ids().filter((x) => x !== from);
    order.splice(order.indexOf(id) + (after ? 1 : 0), 0, from);
    onDrop(order);
  });
}

// つまみ（⠿）。並び替えできないとき（検索・絞り込み中）は薄くする
function dragHandle(enabled) {
  const h = document.createElement("span");
  h.className = `drag-handle${enabled ? "" : " off"}`;
  h.textContent = "⠿";
  h.title = enabled ? "ドラッグして順番を入れ替え" : "検索・絞り込みを解除するとドラッグで入れ替えられます";
  return h;
}
