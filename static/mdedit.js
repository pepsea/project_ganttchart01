"use strict";

// Markdown を書きやすくする入力補助（textarea 用）。
//  ・箇条書き（- * + / 1. / - [ ]）の行で Enter → 次の行にも同じ箇条書きの印を出す（番号は 1 つ増える）。
//    何も書いていない箇条書きの行で Enter → 印を消して箇条書きを終える（入れ子なら 1 段戻す）
//  ・箇条書きの行（または複数行の選択）で Tab → 1 段下げる（入れ子の箇条書きになる）、Shift+Tab → 1 段戻す
//  ・引用（> ）の行で Enter → 次の行にも > を出す
//  ・Ctrl/⌘ + B → 太字、Ctrl/⌘ + I → 斜体
// 入力は「元に戻す」（Ctrl/⌘ + Z）で戻せるよう、可能なら execCommand("insertText") で入れる。
function enableMarkdownEditing(ta) {
  const INDENT = "  "; // 1 段 = 半角スペース 2 つ
  const LIST = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
  const QUOTE = /^(\s*>\s?)/;

  function insert(text) {
    ta.focus();
    let ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (_) { ok = false; }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  const lineStart = (pos) => ta.value.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (pos) => { const i = ta.value.indexOf("\n", pos); return i < 0 ? ta.value.length : i; };

  // 選択している行をまとめて下げる / 戻す
  function shiftLines(back) {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const from = lineStart(s);
    const to = lineEnd(e > s && value[e - 1] === "\n" ? e - 1 : e);
    const lines = value.slice(from, to).split("\n");
    let firstDelta = 0, total = 0;
    const out = lines.map((l, i) => {
      let nl = l, d = 0;
      if (!back) { nl = INDENT + l; d = INDENT.length; }
      else if (l.startsWith(INDENT)) { nl = l.slice(INDENT.length); d = -INDENT.length; }
      else if (l.startsWith("\t")) { nl = l.slice(1); d = -1; }
      else if (l.startsWith(" ")) { nl = l.slice(1); d = -1; }
      if (i === 0) firstDelta = d;
      total += d;
      return nl;
    });
    ta.setSelectionRange(from, to);
    insert(out.join("\n"));
    ta.setSelectionRange(Math.max(from, s + firstDelta), e + total);
  }

  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換中は何もしない
    const { selectionStart: s, selectionEnd: end, value } = ta;
    const mod = e.ctrlKey || e.metaKey;

    // 太字・斜体
    if (mod && !e.shiftKey && !e.altKey && (e.key === "b" || e.key === "i")) {
      e.preventDefault();
      const mark = e.key === "b" ? "**" : "*";
      const sel = value.slice(s, end);
      insert(`${mark}${sel}${mark}`);
      if (s === end) ta.setSelectionRange(s + mark.length, s + mark.length);
      return;
    }

    if (e.key === "Tab" && !mod && !e.altKey) {
      const ls = lineStart(s);
      const multi = value.slice(s, end).includes("\n");
      const inList = LIST.test(value.slice(ls, lineEnd(s)));
      if (multi || inList) {
        e.preventDefault();
        shiftLines(e.shiftKey);
      }
      return; // 箇条書き以外の行では、いつもどおり次の入力欄へ移る
    }

    if (e.key === "Enter" && !mod && !e.shiftKey && !e.altKey && s === end) {
      const ls = lineStart(s);
      const line = value.slice(ls, lineEnd(s));
      const before = value.slice(ls, s); // 行頭からカーソルまで
      const m = LIST.exec(line);
      if (m) {
        if (s - ls < m[0].length) return; // 印より前でのEnterは、ふつうの改行
        const rest = line.slice(m[0].length);
        if (rest.trim() === "" && before.length >= m[0].length) {
          // 何も書いていない箇条書きの行: 入れ子なら 1 段戻し、そうでなければ印を消して終える
          e.preventDefault();
          ta.setSelectionRange(ls, lineEnd(s));
          if (m[1].length >= INDENT.length) insert(m[1].slice(INDENT.length) + m[2] + m[3] + (m[4] || ""));
          else insert("");
          return;
        }
        e.preventDefault();
        let marker = m[2];
        const num = /^(\d+)([.)])$/.exec(marker);
        if (num) marker = `${Number(num[1]) + 1}${num[2]}`;
        insert(`\n${m[1]}${marker}${m[3]}${m[4] ? "[ ] " : ""}`);
        return;
      }
      const q = QUOTE.exec(line);
      if (q && s - ls >= q[0].length) {
        e.preventDefault();
        if (line.slice(q[0].length).trim() === "") { ta.setSelectionRange(ls, lineEnd(s)); insert(""); } // 空の引用行で終える
        else insert(`\n${q[1]}`);
      }
    }
  });
}
