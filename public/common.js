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

// key   : 管理用の合言葉（一覧画面で使う）
// token : LINEのIDトークン（提出画面で使う）
async function api(path, { method = "GET", body, key, token } = {}) {
  const headers = {};
  if (key) headers["X-Access-Key"] = key;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // JSONでない返事（通信エラーなど）
  }

  if (res.status === 401) throw new AuthError(data?.error || "本人確認ができませんでした");
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

// ---------------------------------------------------------
// 日本の祝日
//
// 「国民の祝日に関する法律」の決まりをそのまま計算している。
//   ・日付が決まっている祝日（元日、建国記念の日 など）
//   ・「第2月曜日」のように曜日で決まる祝日（成人の日 など）
//   ・春分の日・秋分の日（天文の計算式。1980〜2099年まで使える）
//   ・振替休日（祝日が日曜なら、次の祝日でない日が休み）
//   ・国民の休日（祝日にはさまれた平日は休み）
// ※ 法律が変わったり、オリンピックのような特別な年があったりしたら直す必要がある
// ---------------------------------------------------------
const holidayCache = new Map(); // 年 → その年の祝日のSet（"2026-01-01" の形）

function isHoliday(date) {
  const year = Number(date.slice(0, 4));
  if (!holidayCache.has(year)) holidayCache.set(year, holidaysOf(year));
  return holidayCache.get(year).has(date);
}

function holidaysOf(year) {
  const ymd = (m, d) => `${year}-${pad2(m)}-${pad2(d)}`;
  // その月の第n月曜日が何日か
  const nthMonday = (m, n) => {
    const first = new Date(year, m - 1, 1).getDay(); // 1日の曜日
    return 1 + ((8 - first) % 7) + (n - 1) * 7;
  };
  const shift = (y) => y - 1980;
  const spring = Math.floor(20.8431 + 0.242194 * shift(year) - Math.floor(shift(year) / 4));
  const autumn = Math.floor(23.2488 + 0.242194 * shift(year) - Math.floor(shift(year) / 4));

  const list = [
    ymd(1, 1), // 元日
    ymd(1, nthMonday(1, 2)), // 成人の日
    ymd(2, 11), // 建国記念の日
    ymd(2, 23), // 天皇誕生日
    ymd(3, spring), // 春分の日
    ymd(4, 29), // 昭和の日
    ymd(5, 3), // 憲法記念日
    ymd(5, 4), // みどりの日
    ymd(5, 5), // こどもの日
    ymd(7, nthMonday(7, 3)), // 海の日
    ymd(8, 11), // 山の日
    ymd(9, nthMonday(9, 3)), // 敬老の日
    ymd(9, autumn), // 秋分の日
    ymd(10, nthMonday(10, 2)), // スポーツの日
    ymd(11, 3), // 文化の日
    ymd(11, 23), // 勤労感謝の日
  ];
  const set = new Set(list);

  // 振替休日：祝日が日曜日なら、そのあと最初の「祝日でない日」が休みになる
  for (const date of list) {
    if (weekdayOf(date) !== 0) continue;
    const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
    do {
      d.setDate(d.getDate() + 1);
    } while (set.has(toYmd(d)));
    set.add(toYmd(d));
  }

  // 国民の休日：前の日と次の日が祝日にはさまれた日（日曜以外）も休みになる
  for (let m = 1; m <= 12; m++) {
    const last = new Date(year, m, 0).getDate();
    for (let day = 1; day <= last; day++) {
      const date = ymd(m, day);
      if (set.has(date) || weekdayOf(date) === 0) continue;
      const prev = toYmd(new Date(year, m - 1, day - 1));
      const next = toYmd(new Date(year, m - 1, day + 1));
      if (set.has(prev) && set.has(next)) set.add(date);
    }
  }
  return set;
}

// Dateから "2026-12-03" の形にする
function toYmd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
