"use strict";

// 画面の右上（ログアウトの隣）にバージョンを表示する。クリックすると更新履歴（CHANGELOG.md）を表示する
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
  a.title = `バージョン ${v.version}${v.commit ? `（コミット ${v.commit}）` : ""}${v.built ? `\nビルド ${v.built}` : ""}\nクリックで更新履歴`;
  logout.before(a);

  let dlg = null;
  a.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "version-dialog";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "閉じる";
      close.addEventListener("click", () => dlg.close());
      const body = document.createElement("div");
      body.className = "md version-body";
      if (!window.mdToHtml) {
        await new Promise((resolve) => {
          const s = document.createElement("script");
          s.src = "/static/markdown.js";
          s.onload = resolve;
          s.onerror = resolve;
          document.head.append(s);
        });
      }
      body.innerHTML = window.mdToHtml ? window.mdToHtml(v.changelog || "更新履歴はありません") : "";
      if (!window.mdToHtml) body.textContent = v.changelog || "更新履歴はありません";
      const meta = document.createElement("p");
      meta.className = "hint";
      meta.textContent = `いまのバージョン: ${v.version}${v.commit ? `　コミット: ${v.commit}` : ""}${v.built ? `　ビルド: ${v.built}` : ""}`;
      const actions = document.createElement("div");
      actions.className = "actions";
      actions.append(close);
      dlg.append(meta, body, actions);
      document.body.append(dlg);
      dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close(); });
    }
    dlg.showModal();
  });
})();
