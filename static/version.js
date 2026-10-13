"use strict";

// 画面の右上（ログアウトの隣）にバージョンを表示する。クリックすると更新日時だけを表示する
(async () => {
  const logout = document.querySelector(".toolbar .logout, a.logout");
  if (!logout) return;
  let v;
  try {
    const res = await fetch("/api/version");
    if (!res.ok) return;
    v = await res.json();
  } catch (_) { return; }
  const a = document.createElement("a");
  a.className = "app-version";
  a.href = "#";
  a.textContent = `v${v.version}`;
  a.title = "クリックで更新日時";
  logout.before(a);

  // 更新日時の小さな表示（もう一度クリック・ほかをクリック・Esc で閉じる）
  let pop = null;
  const close = () => { if (pop) { pop.remove(); pop = null; } };
  a.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pop) return close();
    pop = document.createElement("div");
    pop.className = "version-pop";
    pop.textContent = v.updated ? `更新日時 ${v.updated.replaceAll("-", "/")}` : "更新日時は不明です";
    const r = a.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    document.body.append(pop);
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
})();
