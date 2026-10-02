"use strict";

// 簡易 Markdown → HTML 変換（外部ライブラリなし）。入力は先に HTML エスケープするので、書かれた HTML は実行されない。
// 対応: 見出し(#)・太字(**)・斜体(*)・取り消し線(~~)・インラインコード(`)・コードブロック(```)・箇条書き(- * +)・番号付き(1.)・
//       入れ子の箇条書き（インデント）・引用(>)・区切り線(---)・表(| a | b |)・リンク([名前](https://…)・自動リンク)
(function () {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : "");

  function inline(text) {
    const codes = [];
    let s = esc(text).replace(/``([^`](?:[\s\S]*?[^`])?)``(?!`)|`([^`]+)`/g, (_, c2, c1) => { codes.push((c2 ?? c1).trim()); return `\u0000${codes.length - 1}\u0000`; });
    // 画像: ![説明](https://…)。アドレスは http / https のみ（画像そのものは保管せず、アドレスから表示する）
    const imgs = [];
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, u) => {
      imgs.push(`<img src="${u}" alt="${alt}" title="${alt}" loading="lazy" referrerpolicy="no-referrer">`);
      return `\u0001${imgs.length - 1}\u0001`;
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${safeHref(u.replace(/&amp;/g, "&"))}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (m, pre, u) => `${pre}<a href="${u.replace(/&amp;/g, "&")}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\s][^_]*)_(?![_\w])/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0001(\d+)\u0001/g, (_, i) => imgs[Number(i)])
      .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  // opts.interactive = true のとき、チェックボックスを押せる（data-line = 元の文章の行番号。押したときの書き換えは呼び出し側で行う）
  // それ以外は表示だけ（押せない）
  window.mdToHtml = function (src, opts = {}, nested = false) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      // コードブロック
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      // 見出し
      let m = /^(#{1,6})\s+(.*)$/.exec(line);
      if (m) { out.push(`<h${m[1].length}>${inline(m[2].trim())}</h${m[1].length}>`); i++; continue; }
      // 区切り線
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      // 引用
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${window.mdToHtml(buf.join("\n"), opts, true)}</blockquote>`);
        continue;
      }
      // 表
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
          rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      // 箇条書き・番号付き（インデントで入れ子）
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const stack = []; // { indent, tag }
        let html = "";
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          const indent = mm[1].replace(/\t/g, "    ").length;
          const tag = /\d/.test(mm[2]) ? "ol" : "ul";
          while (stack.length && indent < stack[stack.length - 1].indent) { html += `</li></${stack.pop().tag}>`; }
          // チェックボックス: - [ ] 未完了 / - [x] 完了
          const task = /^\[([ xX])\]\s+(.*)$/.exec(mm[3]);
          const li = task ? '<li class="md-task">' : "<li>";
          if (!stack.length || indent > stack[stack.length - 1].indent) { stack.push({ indent, tag }); html += `<${tag}>${li}`; }
          else html += `</li>${li}`;
          if (task) {
            const checked = task[1] !== " ";
            const can = opts.interactive && !nested; // 引用の中は行番号がずれるので、押せない
            html += `<input type="checkbox" class="md-check"${checked ? " checked" : ""}${can ? ` data-line="${i}"` : " disabled"}> <span class="${checked ? "md-done" : ""}">${inline(task[2])}</span>`;
          } else html += inline(mm[3]);
          i++;
        }
        while (stack.length) html += `</li></${stack.pop().tag}>`;
        out.push(html);
        continue;
      }
      // 段落（連続する行は改行でつなぐ）
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(inline(lines[i++].trim()));
      out.push(`<p>${buf.join("<br>")}</p>`);
    }
    return out.join("\n");
  };
})();
