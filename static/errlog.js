"use strict";

// 画面（ブラウザ）で起きた JavaScript のエラーを、サーバーのログに送る（「バックアップ」画面からダウンロードできるログに残る）
(() => {
  let sent = 0;
  function report(message, source, line) {
    if (sent >= 10) return; // 同じ画面で出続けても、送るのは 10 件まで
    sent++;
    try {
      const body = JSON.stringify({ message: String(message || "").slice(0, 300), source: String(source || ""), line: line || 0, page: location.pathname + location.search });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/logs/client", new Blob([body], { type: "application/json" }));
      else fetch("/api/logs/client", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true });
    } catch (_) { /* 報告できなくても何もしない */ }
  }
  window.addEventListener("error", (e) => report(e.message, e.filename, e.lineno));
  window.addEventListener("unhandledrejection", (e) => report(`未処理のエラー: ${(e.reason && e.reason.message) || e.reason}`, "", 0));
})();
