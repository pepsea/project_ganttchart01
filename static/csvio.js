"use strict";

// CSV エクスポート・インポートのボタン（共有資料・参考リンク・グループ目標で共通）
// setupCsvTools({ exportUrl, importUrl, note, summary(result) => 文字列, after: async () => 再読み込み, toast })
function setupCsvTools(opts) {
  // 全画面共通: ログアウトの隣に置く
  const tools = document.createElement("span");
  tools.className = "csv-tools";
  document.querySelector(".toolbar .logout").after(tools);
  const exp = document.createElement("a");
  exp.className = "button";
  exp.href = opts.exportUrl;
  exp.textContent = "CSV E";
  exp.title = "CSV エクスポート：すべてのデータを CSV でダウンロード（このファイルをインポートすれば元に戻せます）";
  const imp = document.createElement("button");
  imp.type = "button";
  imp.textContent = "CSV I";
  imp.title = "CSV インポート";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = ".csv,text/csv";
  file.hidden = true;
  tools.append(exp, imp, file);

  imp.addEventListener("click", () => {
    file.value = "";
    file.click();
  });
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    if (!confirm(`「${f.name}」を取り込みます。\n\n${opts.note}\n・空欄のセルは今の値のまま変わりません\n・削除はされません\n・1 行でもエラーがあれば何も取り込みません\n\nよろしいですか？`)) return;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await fetch(opts.importUrl, { method: "POST", body: fd });
      if (res.status === 401) { location.href = "/login"; return; }
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : `${res.status} ${res.statusText}`);
      await opts.after();
      opts.toast(`インポート完了: ${opts.summary(data)}`);
    } catch (err) {
      opts.toast(`インポートできませんでした: ${err.message}`, true);
    }
  });
}
