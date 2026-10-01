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
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) return true;
  } catch (_) { /* 最後の方法へ */ }
  prompt("自動でコピーできませんでした。この内容をコピーしてください", text);
  return false;
}
