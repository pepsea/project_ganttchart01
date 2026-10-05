"use strict";

// 複数行の入力欄（メモ・詳細・月報・進捗メモなど）で、Ctrl+Enter（Mac は ⌘+Enter）を押すと保存する。
//  ・入力欄がフォーム（追加・編集の画面）の中にあるとき: そのフォームを送信する（「保存」「追加」「登録」ボタンと同じ）
//  ・フォームの外にあるとき（個人のメモなど）: 近くの「保存」ボタンを押す
// すでに画面ごとの処理（メモ・議論の「保存と同時に表示」など）が Ctrl+Enter を使っているときは、何もしない。
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return; // 日本語入力の変換中・処理済みは除く
  const ta = e.target;
  if (!(ta instanceof HTMLTextAreaElement) || ta.readOnly || ta.disabled) return;
  const form = ta.form || ta.closest("form");
  if (form) {
    e.preventDefault();
    form.requestSubmit(); // 必須項目が空なら、ふつうの入力チェックが働く
    return;
  }
  // フォームの外: 入力欄を含む枠を内側から外へたどり、最初に見つかった「保存」ボタンを押す
  for (let n = ta.parentElement; n && n !== document.body; n = n.parentElement) {
    const b = [...n.querySelectorAll("button")].find((x) =>
      !x.disabled && x.offsetParent !== null && (/^保存/.test(x.textContent.trim()) || x.classList.contains("memo-save") || x.id === "btn-save"));
    if (b) {
      e.preventDefault();
      b.click();
      return;
    }
  }
});
