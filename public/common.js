// =========================================================
// 提出画面と一覧画面の両方で使う共通の処理
// =========================================================

// ---------------------------------------------------------
// 合言葉の保存（ブラウザに覚えさせて、毎回入力しなくていいようにする）
// ---------------------------------------------------------
function loadKey(name) {
  try {
    return localStorage.getItem(name) || "";
  } catch {
    return "";
  }
}

function saveKey(name, value) {
  try {
    localStorage.setItem(name, value);
  } catch {
    // 保存できない環境（プライベートモードなど）では、その場だけ使う
  }
}

function clearKey(name) {
  try {
    localStorage.removeItem(name);
  } catch {
    // 何もしない
  }
}

// ---------------------------------------------------------
// サーバー（/api/〜）とのやりとり
// ---------------------------------------------------------
class AuthError extends Error {}

async function api(path, { method = "GET", body, key } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      "X-Access-Key": key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // JSONでない返事（通信エラーなど）
  }

  if (res.status === 401) throw new AuthError(data?.error || "合言葉が違います");
  if (!res.ok) {
    const err = new Error(data?.error || `通信エラー（${res.status}）`);
    err.status = res.status; // 403（締切後）などを見分けられるようにしておく
    throw err;
  }
  return data;
}

// ---------------------------------------------------------
// 日付まわり
// ---------------------------------------------------------
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 数字を2けたにする（3 → "03"）
const pad2 = (n) => String(n).padStart(2, "0");

// 年と月から "2026-12" の形を作る
const toPeriod = (year, month) => `${year}-${pad2(month)}`;

// "2026-12" と日にちから "2026-12-03" の形を作る
const toDate = (period, day) => `${period}-${pad2(day)}`;

// その月が何日まであるか
function daysInMonth(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

// その月の1日が何曜日か（0=日曜）
function firstWeekday(period) {
  const [y, m] = period.split("-").map(Number);
  return new Date(y, m - 1, 1).getDay();
}

// 日付の曜日（0=日曜）
function weekdayOf(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

// "2026-12-03" → "12/3(木)"
function formatDate(date) {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}(${WEEKDAYS[weekdayOf(date)]})`;
}

// "2026-12" → "2026年12月"
function formatPeriod(period) {
  const [y, m] = period.split("-").map(Number);
  return `${y}年${m}月`;
}

// 月の選択肢を作る。サーバーから受け取った
// { periods: [{ period, deadline, open }], initial } を使う
function fillPeriodSelect(select, { periods, initial }) {
  select.innerHTML = "";
  for (const p of periods) {
    const opt = document.createElement("option");
    opt.value = p.period;
    opt.textContent = formatPeriod(p.period) + (p.open ? "" : "（締切済み）");
    select.append(opt);
  }
  select.value = initial;
}

// データベースの時刻（世界標準時）を日本時間の "12/3 18:40" にする
function formatUpdated(utc) {
  if (!utc) return "";
  const d = new Date(utc.replace(" ", "T") + "Z");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// "17:00" と "22:00" → "17:00〜22:00"（終了が空なら "17:00〜"）
function formatRange(start, end) {
  if (!start && !end) return "";
  return `${start || ""}〜${end || ""}`;
}

// 文字をHTMLに入れても安全な形にする
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
