// =========================================================
// シフト希望の提出画面の動き
// =========================================================

const KEY_NAME = "shiftapp.key"; // 合言葉を覚えておく場所の名前
const STAFF_NAME = "shiftapp.staff"; // 前回選んだ名前を覚えておく場所の名前

// 画面の部品をまとめて取っておく
const $ = (id) => document.getElementById(id);
const els = {
  keySection: $("key-section"),
  keyInput: $("key-input"),
  keyButton: $("key-button"),
  keyMessage: $("key-message"),
  form: $("form"),
  staffSelect: $("staff-select"),
  periodSelect: $("period-select"),
  defaultStart: $("default-start"),
  defaultEnd: $("default-end"),
  calendar: $("calendar"),
  dayListCard: $("day-list-card"),
  dayList: $("day-list"),
  minDays: $("min-days"),
  maxDays: $("max-days"),
  note: $("note"),
  submitButton: $("submit-button"),
  formMessage: $("form-message"),
};

// 画面の状態
let accessKey = loadKey(KEY_NAME);
// 選んだ日： "2026-12-03" → { status: "ok" | "maybe", start_time, end_time }
let days = new Map();

// ---------------------------------------------------------
// 起動
// ---------------------------------------------------------
init();

async function init() {
  fillPeriodSelect(els.periodSelect);
  fillDaysSelect(els.minDays, "以上");
  fillDaysSelect(els.maxDays, "まで");

  els.keyButton.addEventListener("click", onKeyEntered);
  els.keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onKeyEntered();
  });
  els.staffSelect.addEventListener("change", onTargetChanged);
  els.periodSelect.addEventListener("change", onTargetChanged);
  els.defaultStart.addEventListener("input", renderDayList);
  els.defaultEnd.addEventListener("input", renderDayList);
  els.form.addEventListener("submit", onSubmit);

  if (accessKey) {
    await start();
  } else {
    showKeySection();
  }
}

// 合言葉が正しければスタッフ一覧を読み込んでフォームを表示する
async function start() {
  try {
    const { staff } = await api("/api/staff", { key: accessKey });
    fillStaffSelect(staff);
    els.keySection.hidden = true;
    els.form.hidden = false;
    await onTargetChanged();
  } catch (err) {
    if (err instanceof AuthError) {
      clearKey(KEY_NAME);
      accessKey = "";
      showKeySection(err.message);
    } else {
      showKeySection(`読み込みに失敗しました：${err.message}`);
    }
  }
}

function showKeySection(message = "") {
  els.form.hidden = true;
  els.keySection.hidden = false;
  els.keyMessage.textContent = message;
  els.keyInput.focus();
}

async function onKeyEntered() {
  const value = els.keyInput.value.trim();
  if (!value) return;
  accessKey = value;
  saveKey(KEY_NAME, value);
  await start();
}

// ---------------------------------------------------------
// 選択肢を作る
// ---------------------------------------------------------
function fillStaffSelect(staff) {
  els.staffSelect.innerHTML = '<option value="">選んでください</option>';
  for (const s of staff) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    els.staffSelect.append(opt);
  }
  // 前回選んだ名前があれば、最初から選んでおく
  const last = loadKey(STAFF_NAME);
  if (last && staff.some((s) => String(s.id) === last)) {
    els.staffSelect.value = last;
  }
}

function fillDaysSelect(select, suffix) {
  select.innerHTML = '<option value="">指定なし</option>';
  for (let n = 1; n <= 7; n++) {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = `週${n}日${suffix}`;
    select.append(opt);
  }
}

// ---------------------------------------------------------
// 名前か月が変わったら、前に出した内容を読み込む
// ---------------------------------------------------------
async function onTargetChanged() {
  setMessage("");
  const staffId = els.staffSelect.value;
  if (staffId) saveKey(STAFF_NAME, staffId);

  resetForm();
  if (staffId) {
    try {
      const { submission } = await api(
        `/api/submission?staff_id=${staffId}&period=${els.periodSelect.value}`,
        { key: accessKey }
      );
      if (submission) {
        applySubmission(submission);
        setMessage(`前回の提出内容を表示しています（${formatUpdated(submission.updated_at)}）`);
      }
    } catch (err) {
      setMessage(err.message, "error");
    }
  }
  renderCalendar();
  renderDayList();
}

function resetForm() {
  days = new Map();
  els.defaultStart.value = "17:00";
  els.defaultEnd.value = "";
  els.minDays.value = "";
  els.maxDays.value = "";
  els.note.value = "";
}

function applySubmission(sub) {
  els.defaultStart.value = sub.default_start ?? "";
  els.defaultEnd.value = sub.default_end ?? "";
  els.minDays.value = sub.min_days_per_week ?? "";
  els.maxDays.value = sub.max_days_per_week ?? "";
  els.note.value = sub.note ?? "";
  for (const d of sub.days) {
    days.set(d.date, {
      status: d.status,
      start_time: d.start_time ?? "",
      end_time: d.end_time ?? "",
    });
  }
}

// ---------------------------------------------------------
// カレンダー
// ---------------------------------------------------------
function renderCalendar() {
  const period = els.periodSelect.value;
  els.calendar.innerHTML = "";

  // 曜日の見出し
  WEEKDAYS.forEach((w, i) => {
    const head = document.createElement("div");
    head.className = "head" + (i === 0 ? " sun" : i === 6 ? " sat" : "");
    head.textContent = w;
    els.calendar.append(head);
  });

  // 1日の曜日まで空白を入れる
  for (let i = 0; i < firstWeekday(period); i++) {
    els.calendar.append(document.createElement("div"));
  }

  // 日付のマス
  for (let day = 1; day <= daysInMonth(period); day++) {
    const date = toDate(period, day);
    const wd = weekdayOf(date);
    const status = days.get(date)?.status;

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className =
      "day" + (wd === 0 ? " sun" : wd === 6 ? " sat" : "") + (status ? ` ${status}` : "");
    cell.innerHTML = `<span class="num">${day}</span><span class="mark">${
      status === "ok" ? "○" : status === "maybe" ? "△" : ""
    }</span>`;
    cell.setAttribute("aria-label", `${formatDate(date)} ${statusLabel(status)}`);
    cell.addEventListener("click", () => toggleDay(date));
    els.calendar.append(cell);
  }
}

// タップするたびに 空欄 → ○ → △ → 空欄 と切り替える
function toggleDay(date) {
  const current = days.get(date);
  if (!current) {
    days.set(date, { status: "ok", start_time: "", end_time: "" });
  } else if (current.status === "ok") {
    current.status = "maybe";
  } else {
    days.delete(date);
  }
  renderCalendar();
  renderDayList();
}

function statusLabel(status) {
  if (status === "ok") return "入れる";
  if (status === "maybe") return "相談可";
  return "入れない";
}

// ---------------------------------------------------------
// 選んだ日ごとの時間
// ---------------------------------------------------------
function renderDayList() {
  const sorted = [...days.keys()].sort();
  els.dayListCard.hidden = sorted.length === 0;
  els.dayList.innerHTML = "";

  for (const date of sorted) {
    const d = days.get(date);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="day-label">
        ${formatDate(date)}
        <span class="${d.status === "ok" ? "badge-ok" : "badge-maybe"}">${
          d.status === "ok" ? "○" : "△"
        }</span>
      </div>
      <div class="row">
        <input type="time" aria-label="開始" />
        <span class="sep">〜</span>
        <input type="time" aria-label="終了" />
      </div>
    `;
    const [startInput, endInput] = li.querySelectorAll("input");
    startInput.value = d.start_time;
    endInput.value = d.end_time;
    startInput.title = `空欄なら ${els.defaultStart.value || "指定なし"}`;
    endInput.title = `空欄なら ${els.defaultEnd.value || "ラストまで"}`;
    startInput.addEventListener("input", () => (d.start_time = startInput.value));
    endInput.addEventListener("input", () => (d.end_time = endInput.value));
    els.dayList.append(li);
  }
}

// ---------------------------------------------------------
// 送信
// ---------------------------------------------------------
async function onSubmit(event) {
  event.preventDefault(); // ページが再読み込みされないようにする
  setMessage("");

  if (!els.staffSelect.value) {
    setMessage("名前を選んでください", "error");
    return;
  }

  const body = {
    staff_id: Number(els.staffSelect.value),
    period: els.periodSelect.value,
    default_start: els.defaultStart.value,
    default_end: els.defaultEnd.value,
    min_days_per_week: els.minDays.value ? Number(els.minDays.value) : null,
    max_days_per_week: els.maxDays.value ? Number(els.maxDays.value) : null,
    note: els.note.value.trim(),
    days: [...days.entries()].sort().map(([date, d]) => ({
      date,
      status: d.status,
      start_time: d.start_time,
      end_time: d.end_time,
    })),
  };

  els.submitButton.disabled = true;
  try {
    await api("/api/submission", { method: "POST", body, key: accessKey });
    const count = body.days.length;
    setMessage(
      `送信しました！（${formatPeriod(body.period)}・${count}日分）出し直すときはこの画面からもう一度送信してください。`,
      "success"
    );
  } catch (err) {
    if (err instanceof AuthError) {
      clearKey(KEY_NAME);
      accessKey = "";
      showKeySection(err.message);
    } else {
      setMessage(err.message, "error");
    }
  } finally {
    els.submitButton.disabled = false;
  }
}

// ---------------------------------------------------------
// ちょっとした表示用の処理
// ---------------------------------------------------------
function setMessage(text, type = "") {
  els.formMessage.textContent = text;
  els.formMessage.className = "message" + (type ? ` ${type}` : "");
}

// データベースの時刻（UTC）を日本時間の "12/3 18:40" にする
function formatUpdated(utc) {
  if (!utc) return "";
  const d = new Date(utc.replace(" ", "T") + "Z");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}更新`;
}
