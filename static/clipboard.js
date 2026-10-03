"use strict";

// コピーの共通部品。ふつうは Clipboard API で 1 クリックでコピーする。
// http のアクセス（LAN のサーバーなど）では Clipboard API が使えないので、見えない入力欄に入れて「コピー」する方法に切り替える
// （確認のダイアログを出さずにコピーできる）。それも使えないときだけ、コピー用の入力欄を出す。
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 次の方法へ */ }
  try {
    // 開いているウィンドウ（<dialog>）の中にいるとき、ウィンドウの外の要素にはフォーカスできない（コピーが失敗する）。
    // そのため、見えない入力欄は開いているウィンドウの中に作る
    const host = document.querySelector("dialog[open]") || document.body;
    const prev = document.activeElement;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    host.append(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS・Windows の一部のブラウザで select() だけでは選べないことがある
    let ok = false;
    try { ok = document.execCommand("copy"); } finally { ta.remove(); if (prev && prev.focus) prev.focus({ preventScroll: true }); }
    if (ok) return true;
  } catch (_) { /* 最後の方法へ */ }
  prompt("自動でコピーできませんでした。この内容をコピーしてください", text);
  return false;
}

// 「Markdown の文字」と「見た目どおりの書式つき（HTML）」の両方をコピーする。
// 貼り付け先が書式つきの文章を受け付ける（Teams・Outlook・Word など）ときは書式つきで、
// 文字だけの欄（メモ帳・GitHub など）では Markdown の文字のまま貼り付けられる。
async function copyRich(plain, html) {
  try {
    if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      return true;
    }
  } catch (_) { /* 次の方法へ（http のアクセスなど） */ }
  // http でも使える方法: コピーの動きに割り込んで、2 種類の内容を直接セットする
  try {
    const host = document.querySelector("dialog[open]") || document.body;
    const prev = document.activeElement;
    const ta = document.createElement("textarea");
    ta.value = plain;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    host.append(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, plain.length);
    const onCopy = (e) => {
      e.clipboardData.setData("text/plain", plain);
      e.clipboardData.setData("text/html", html);
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy, { once: true });
    let ok = false;
    try { ok = document.execCommand("copy"); } finally { document.removeEventListener("copy", onCopy); ta.remove(); if (prev && prev.focus) prev.focus({ preventScroll: true }); }
    if (ok) return true;
  } catch (_) { /* 最後の方法へ */ }
  return copyText(plain); // 書式つきでコピーできない環境では、Markdown の文字だけをコピーする
}
