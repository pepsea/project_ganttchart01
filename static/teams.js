"use strict";

// Teams で共有: Microsoft の共有画面（teams.microsoft.com/share）を別ウィンドウで開く。
// 送り先（人・チャット・チャネル）を選ぶと、メッセージとこのシステムへのリンクが投稿される。
// ※ リンクは、このシステムにつながるネットワーク（社内 LAN・VPN など）にいる人だけが開ける
function shareToTeams(url, text) {
  const q = new URLSearchParams({ href: url, msgText: text, preview: "true" });
  const w = 700, h = 640;
  const left = Math.max(0, (screen.width - w) / 2), top = Math.max(0, (screen.height - h) / 2);
  window.open(`https://teams.microsoft.com/share?${q}`, "teams-share",
    `width=${w},height=${h},left=${left},top=${top},noopener`);
}
