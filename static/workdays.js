"use strict";

// 期限までの日数を「営業日」（土日を除く）で数える。祝日は考慮しない。
// workDaysLeft(終了日の ms) = 今日から終了日まで何営業日か（今日は数えず、終了日は数える。終了日が過去ならマイナス）
// 例: 金曜の今日 → 翌月曜が終了日なら 1 営業日、翌火曜なら 2 営業日
function weekdaysAfter(fromMs, n) {
  let c = Math.floor(n / 7) * 5;
  const dow = new Date(fromMs).getUTCDay();
  for (let i = 1; i <= n % 7; i++) {
    const d = (dow + i) % 7;
    if (d !== 0 && d !== 6) c++;
  }
  return c;
}
function workDaysLeft(endMs, fromMs = todayMs()) {
  const cal = Math.round((endMs - fromMs) / 86400000);
  if (cal === 0) return 0;
  return cal > 0 ? weekdaysAfter(fromMs, cal) : -weekdaysAfter(endMs, -cal);
}
