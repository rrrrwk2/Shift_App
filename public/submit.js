// =========================================================
// シフト希望の提出画面の動き
//
// この画面は、状況によって4つの表示を切り替える
//   form    : 入力画面（まだ出していない／修正中）
//   done    : 提出済み（完了）画面
//   closed  : 締切を過ぎていて、まだ出していない人向けの画面
//   request : 締切後の「変更の申請」を書く画面
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
  app: $("app"),
  staffSelect: $("staff-select"),
  periodSelect: $("period-select"),
  deadlineInfo: $("deadline-info"),
  flash: $("flash"),
  loading: $("loading"),
  pickName: $("pick-name"),
  // 入力画面
  formView: $("form-view"),
  defaultStart: $("default-start"),
  defaultEnd: $("default-end"),
  calendar: $("calendar"),
  dayListCard: $("day-list-card"),
  dayList: $("day-list"),
  minDays: $("min-days"),
  maxDays: $("max-days"),
  note: $("note"),
  submitButton: $("submit-button"),
  cancelEditButton: $("cancel-edit-button"),
  formMessage: $("form-message"),
  // 完了画面
  doneView: $("done-view"),
  doneTitle: $("done-title"),
  doneUpdated: $("done-updated"),
  summary: $("summary"),
  summaryDays: $("summary-days"),
  editButton: $("edit-button"),
  requestButtonDone: $("request-button-done"),
  // 締切後・未提出
  closedView: $("closed-view"),
  closedText: $("closed-text"),
  requestButtonClosed: $("request-button-closed"),
  // 変更の申請
  requestView: $("request-view"),
  requestMessage: $("request-message"),
  requestSend: $("request-send"),
  requestCancel: $("request-cancel"),
  requestMessageArea: $("request-message-area"),
  myRequests: $("my-requests"),
  myRequestsList: $("my-requests-list"),
};

// 画面の状態
let accessKey = loadKey(KEY_NAME);
let periodList = []; // サーバーから受け取った月ごとの締切情報
let current = null; // 今選んでいる人・月の { submission, change_requests, period_info, can_edit }
// 入力中の日： "2026-12-03" → { status: "ok" | "maybe", start_time, end_time }
let days = new Map();

// ---------------------------------------------------------
// 起動
// ---------------------------------------------------------
init();

async function init() {
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
  els.formView.addEventListener("submit", onSubmit);
  els.cancelEditButton.addEventListener("click", () => showView("done"));
  els.editButton.addEventListener("click", startEditing);
  els.requestButtonDone.addEventListener("click", startRequest);
  els.requestButtonClosed.addEventListener("click", startRequest);
  els.requestView.addEventListener("submit", onSendRequest);
  els.requestCancel.addEventListener("click", decideView);

  // ブラウザの「戻る」「進む」で古い画面がそのまま出てこないよう、
  // キャッシュから表示されたときは読み込み直す
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) location.reload();
  });

  if (accessKey) {
    await start();
  } else {
    showKeySection();
  }
}

// 合言葉が正しければ、月の一覧とスタッフ一覧を読み込んで画面を出す
async function start() {
  try {
    const [periodsData, staffData] = await Promise.all([
      api("/api/periods", { key: accessKey }),
      api("/api/staff", { key: accessKey }),
    ]);
    periodList = periodsData.periods;
    fillPeriodSelect(els.periodSelect, periodsData);
    fillStaffSelect(staffData.staff);
    els.keySection.hidden = true;
    els.app.hidden = false;
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
  els.app.hidden = true;
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
// 名前か月が変わったら、その人・その月の状況を読み込む
// ---------------------------------------------------------
async function onTargetChanged() {
  hideFlash();
  renderDeadlineInfo();

  const staffId = els.staffSelect.value;
  if (!staffId) {
    current = null;
    showView(null);
    els.pickName.hidden = false;
    return;
  }
  saveKey(STAFF_NAME, staffId);
  await refresh();
}

// サーバーから最新の状況を読み込んで、表示を決め直す
async function refresh() {
  els.pickName.hidden = true;
  els.loading.hidden = false;
  showView(null);
  try {
    current = await api(
      `/api/submission?staff_id=${els.staffSelect.value}&period=${els.periodSelect.value}`,
      { key: accessKey }
    );
    decideView();
  } catch (err) {
    if (err instanceof AuthError) {
      clearKey(KEY_NAME);
      accessKey = "";
      showKeySection(err.message);
    } else {
      showFlash(err.message, "error");
    }
  } finally {
    els.loading.hidden = true;
  }
}

// 状況に合わせて、どの画面を出すか決める
function decideView() {
  if (!current) return;
  renderMyRequests();
  if (current.submission) {
    renderDone();
    showView("done");
  } else if (current.can_edit) {
    loadIntoForm(null);
    showView("form");
  } else {
    els.closedText.textContent = `${formatPeriod(els.periodSelect.value)}分の提出期限（${current.period_info.deadline}）を過ぎているため、ここからは提出できません。入れる日がある場合は、変更の申請で作成担当に伝えてください。`;
    showView("closed");
  }
}

// 画面の切り替え（name が null なら全部隠す）
function showView(name) {
  els.formView.hidden = name !== "form";
  els.doneView.hidden = name !== "done";
  els.closedView.hidden = name !== "closed";
  els.requestView.hidden = name !== "request";
  // 自分の申請一覧は、完了画面と締切後の画面のときだけ出す
  els.myRequests.hidden =
    !(name === "done" || name === "closed") || !current?.change_requests?.length;
}

function renderDeadlineInfo() {
  const info = periodList.find((p) => p.period === els.periodSelect.value);
  if (!info) {
    els.deadlineInfo.textContent = "";
    return;
  }
  els.deadlineInfo.textContent = info.open
    ? `提出期限：${info.deadline}まで`
    : `提出期限：${info.deadline}（締切済み）`;
  els.deadlineInfo.classList.toggle("closed", !info.open);
}

// ---------------------------------------------------------
// 完了画面
// ---------------------------------------------------------
function renderDone() {
  const sub = current.submission;
  els.doneTitle.textContent = "提出済みです";
  els.doneUpdated.textContent = `最終更新：${formatUpdated(sub.updated_at)}`;

  const rows = [
    ["対象の月", formatPeriod(sub.period)],
    ["基本の時間", formatRange(sub.default_start, sub.default_end) || "指定なし"],
    ["週の日数", weeklyText(sub)],
    ["備考", sub.note || "なし"],
  ];
  els.summary.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");

  if (sub.days.length === 0) {
    els.summaryDays.innerHTML = "<li>入れる日はありません</li>";
  } else {
    els.summaryDays.innerHTML = sub.days
      .map((d) => {
        const mark =
          d.status === "ok"
            ? '<span class="badge-ok">○</span>'
            : '<span class="badge-maybe">△</span>';
        const time = formatRange(d.start_time, d.end_time);
        return `<li><span>${formatDate(d.date)}</span>${mark}<span class="hint" style="margin:0">${escapeHtml(time)}</span></li>`;
      })
      .join("");
  }

  // 締切前（または管理用の合言葉）なら修正、締切後なら申請
  els.editButton.hidden = !current.can_edit;
  els.requestButtonDone.hidden = current.can_edit;
}

function weeklyText(sub) {
  const min = sub.min_days_per_week;
  const max = sub.max_days_per_week;
  if (min && max) return min === max ? `週${min}日` : `週${min}〜${max}日`;
  if (min) return `週${min}日以上`;
  if (max) return `週${max}日まで`;
  return "指定なし";
}

// 自分が出した変更申請の一覧
function renderMyRequests() {
  const list = current?.change_requests ?? [];
  els.myRequestsList.innerHTML = list
    .map(
      (r) => `<li>
        <div class="request-head">
          <span class="${r.status === "done" ? "status-done" : "status-open"}">${
            r.status === "done" ? "対応済み" : "未対応"
          }</span>
          <span class="hint" style="margin:0">${escapeHtml(formatUpdated(r.created_at))}</span>
        </div>
        <div class="request-body">${escapeHtml(r.message)}</div>
      </li>`
    )
    .join("");
}

// 「内容を修正する」を押したとき
function startEditing() {
  hideFlash();
  loadIntoForm(current.submission);
  showView("form");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------------------------------------------------------
// 入力画面
// ---------------------------------------------------------

// 入力欄に内容を入れる（sub が null なら空の状態にする）
function loadIntoForm(sub) {
  setFormMessage("");
  days = new Map();
  els.defaultStart.value = sub ? sub.default_start ?? "" : "17:00";
  els.defaultEnd.value = sub?.default_end ?? "";
  els.minDays.value = sub?.min_days_per_week ?? "";
  els.maxDays.value = sub?.max_days_per_week ?? "";
  els.note.value = sub?.note ?? "";
  for (const d of sub?.days ?? []) {
    days.set(d.date, {
      status: d.status,
      start_time: d.start_time ?? "",
      end_time: d.end_time ?? "",
    });
  }
  // 修正中のときだけ「修正をやめる」を出す
  els.cancelEditButton.hidden = !sub;
  els.submitButton.textContent = sub ? "修正して送信する" : "この内容で送信する";
  renderCalendar();
  renderDayList();
}

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
  const now = days.get(date);
  if (!now) {
    days.set(date, { status: "ok", start_time: "", end_time: "" });
  } else if (now.status === "ok") {
    now.status = "maybe";
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

// 選んだ日ごとの時間
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

// 送信
async function onSubmit(event) {
  event.preventDefault(); // ページが再読み込みされないようにする
  setFormMessage("");

  const body = {
    staff_id: Number(els.staffSelect.value),
    period: els.periodSelect.value,
    default_start: els.defaultStart.value,
    default_end: els.defaultEnd.value,
    min_days_per_week: els.minDays.value ? Number(els.minDays.value) : null,
    max_days_per_week: els.maxDays.value ? Number(els.maxDays.value) : null,
    note: els.note.value.trim(),
    days: [...days.keys()].sort().map((date) => ({
      date,
      status: days.get(date).status,
      start_time: days.get(date).start_time,
      end_time: days.get(date).end_time,
    })),
  };

  els.submitButton.disabled = true;
  try {
    await api("/api/submission", { method: "POST", body, key: accessKey });
    // 送信できたら完了画面に切り替える
    await refresh();
    els.doneTitle.textContent = "提出しました！";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    if (err instanceof AuthError) {
      clearKey(KEY_NAME);
      accessKey = "";
      showKeySection(err.message);
    } else if (err.status === 403) {
      // 入力している間に締切を過ぎた場合など
      await refresh();
      showFlash(err.message, "error");
    } else {
      setFormMessage(err.message, "error");
    }
  } finally {
    els.submitButton.disabled = false;
  }
}

// ---------------------------------------------------------
// 変更の申請
// ---------------------------------------------------------
function startRequest() {
  hideFlash();
  els.requestMessage.value = "";
  els.requestMessageArea.textContent = "";
  showView("request");
  els.requestMessage.focus();
}

async function onSendRequest(event) {
  event.preventDefault();
  const message = els.requestMessage.value.trim();
  if (!message) {
    els.requestMessageArea.textContent = "変更したい内容を書いてください";
    els.requestMessageArea.className = "message error";
    return;
  }

  els.requestSend.disabled = true;
  try {
    await api("/api/change-request", {
      method: "POST",
      body: { staff_id: Number(els.staffSelect.value), period: els.periodSelect.value, message },
      key: accessKey,
    });
    await refresh();
    showFlash("申請を送りました。作成担当が確認します。");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    els.requestMessageArea.textContent = err.message;
    els.requestMessageArea.className = "message error";
  } finally {
    els.requestSend.disabled = false;
  }
}

// ---------------------------------------------------------
// メッセージ表示
// ---------------------------------------------------------
function setFormMessage(text, type = "") {
  els.formMessage.textContent = text;
  els.formMessage.className = "message" + (type ? ` ${type}` : "");
}

function showFlash(text, type = "success") {
  els.flash.textContent = text;
  els.flash.className = `message flash ${type}`;
  els.flash.hidden = false;
}

function hideFlash() {
  els.flash.hidden = true;
}
