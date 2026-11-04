// =========================================================
// シフト希望の提出画面の動き
//
// この画面は、状況によって4つの表示を切り替える
//   form    : 入力画面（まだ出していない／修正中）
//   done    : 提出済み（完了）画面
//   closed  : 締切を過ぎていて、まだ出していない人向けの画面
//   request : 締切後の「変更の申請」を書く画面
// =========================================================

// 画面の部品をまとめて取っておく
const $ = (id) => document.getElementById(id);
const els = {
  bootSection: $("boot-section"),
  bootMessage: $("boot-message"),
  bootReload: $("boot-reload"),
  linkSection: $("link-section"),
  linkHint: $("link-hint"),
  linkSelect: $("link-select"),
  linkButton: $("link-button"),
  linkMessage: $("link-message"),
  app: $("app"),
  meName: $("me-name"),
  periodSelect: $("period-select"),
  deadlineInfo: $("deadline-info"),
  flash: $("flash"),
  loading: $("loading"),
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
  // シフトを見る
  tabSubmit: $("tab-submit"),
  tabShift: $("tab-shift"),
  shiftView: $("shift-view"),
  shiftMeta: $("shift-meta"),
  myShiftList: $("my-shift-list"),
  allShiftCard: $("all-shift-card"),
  allShiftTable: $("all-shift-table"),
};

// 画面の状態
let idToken = ""; // LINEが発行した「本人の証明書」。サーバーに送って本人確認してもらう
let periodList = []; // サーバーから受け取った月ごとの締切情報
let current = null; // 今選んでいる月の { submission, change_requests, period_info, can_edit }
// 入力中の日： "2026-12-03" → { status: "ok" | "maybe", start_time, end_time }
let days = new Map();

// ---------------------------------------------------------
// 起動
// ---------------------------------------------------------
init();

async function init() {
  fillDaysSelect(els.minDays, "以上");
  fillDaysSelect(els.maxDays, "まで");

  els.bootReload.addEventListener("click", () => location.reload());
  els.linkButton.addEventListener("click", onLink);
  els.periodSelect.addEventListener("change", onPeriodChanged);
  els.tabSubmit.addEventListener("click", () => switchTab("submit"));
  els.tabShift.addEventListener("click", () => switchTab("shift"));
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

  try {
    // 1. LINEにつなぐための設定（LIFF ID）をサーバーからもらう
    const { liff_id } = await api("/api/config");
    if (!liff_id) {
      showBoot("LINE連携の設定がまだ終わっていません。作成担当に連絡してください。");
      return;
    }

    // 2. LINEの部品を準備する
    if (typeof liff === "undefined") {
      showBoot("LINEの部品を読み込めませんでした。通信状態を確認してください。", true);
      return;
    }
    await liff.init({ liffId: liff_id });

    // 3. LINEにログインしていなければ、ログイン画面へ（LINEアプリの中なら自動でログイン済み）
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return;
    }

    // 4. 本人の証明書（IDトークン）を受け取る
    idToken = liff.getIDToken();
    if (!idToken) {
      showBoot("LINEから本人確認の情報を受け取れませんでした。LINEから開き直してください。", true);
      return;
    }

    await loadMe();
  } catch (err) {
    handleError(err);
  }
}

// 自分がどの名前と結びついているかを確かめて、次の画面に進む
async function loadMe() {
  const me = await api("/api/me", { token: idToken });
  if (!me.linked) {
    showLinkSection(me);
    return;
  }
  els.meName.textContent = `${me.staff.name} さん`;

  const periodsData = await api("/api/periods");
  periodList = periodsData.periods;
  fillPeriodSelect(els.periodSelect, periodsData);

  // LINEの「シフト公開」のお知らせのリンク（?view=shift&period=…）から開いたとき
  const params = new URLSearchParams(location.search);
  const wanted = params.get("period");
  if (wanted && periodList.some((p) => p.period === wanted)) els.periodSelect.value = wanted;
  if (params.get("view") === "shift") setTab("shift");

  els.bootSection.hidden = true;
  els.linkSection.hidden = true;
  els.app.hidden = false;
  await onPeriodChanged();
}

// 起動中のお知らせを出す（reload が true なら「もう一度読み込む」ボタンも出す）
function showBoot(message, reload = false) {
  els.app.hidden = true;
  els.linkSection.hidden = true;
  els.bootSection.hidden = false;
  els.bootMessage.textContent = message;
  els.bootReload.hidden = !reload;
}

// どの画面でも共通のエラー処理
function handleError(err) {
  if (err instanceof AuthError) {
    // LINEの本人確認が切れたなど
    showBoot(err.message, true);
  } else {
    showBoot(`読み込みに失敗しました：${err.message}`, true);
  }
}

// ---------------------------------------------------------
// 最初の1回だけ：名前とLINEアカウントを結びつける
// ---------------------------------------------------------
function showLinkSection(me) {
  els.bootSection.hidden = true;
  els.app.hidden = true;
  els.linkSection.hidden = false;
  els.linkHint.textContent = `LINE「${me.line_name || "あなた"}」さんとして登録します。最初の1回だけです。一度登録すると、この名前では他の人は提出できなくなります。間違えたときは作成担当に連絡してください。`;

  els.linkSelect.innerHTML = '<option value="">選んでください</option>';
  for (const s of me.candidates) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    els.linkSelect.append(opt);
  }
  if (me.candidates.length === 0) {
    els.linkMessage.textContent =
      "選べる名前がありません。作成担当に、名簿への登録をお願いしてください。";
    els.linkButton.disabled = true;
  }
}

async function onLink() {
  const staffId = Number(els.linkSelect.value);
  if (!staffId) {
    els.linkMessage.textContent = "名前を選んでください";
    return;
  }
  const name = els.linkSelect.selectedOptions[0].textContent;
  if (!confirm(`「${name}」として登録します。よろしいですか？`)) return;

  els.linkButton.disabled = true;
  try {
    await api("/api/me/link", { method: "POST", body: { staff_id: staffId }, token: idToken });
    await loadMe();
  } catch (err) {
    els.linkMessage.textContent = err.message;
  } finally {
    els.linkButton.disabled = false;
  }
}

// ---------------------------------------------------------
// 選択肢を作る
// ---------------------------------------------------------
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
// 月が変わったら、その月の状況を読み込む
// ---------------------------------------------------------
async function onPeriodChanged() {
  hideFlash();
  renderDeadlineInfo();
  if (tab === "shift") await loadShift();
  else await refresh();
}

// ---------------------------------------------------------
// 「希望を出す」と「シフトを見る」の切り替え
// ---------------------------------------------------------
let tab = "submit";

function setTab(name) {
  tab = name;
  els.tabSubmit.setAttribute("aria-selected", String(name === "submit"));
  els.tabShift.setAttribute("aria-selected", String(name === "shift"));
  els.deadlineInfo.hidden = name === "shift"; // 締切はシフトを見るときには関係ない
}

async function switchTab(name) {
  if (name === tab) return;
  setTab(name);
  await onPeriodChanged();
}

// ---------------------------------------------------------
// 公開されたシフトを見る
// ---------------------------------------------------------
async function loadShift() {
  showView(null);
  els.shiftView.hidden = true;
  els.loading.hidden = false;
  try {
    const data = await api(`/api/schedule?period=${els.periodSelect.value}`, { token: idToken });
    renderShift(data);
    els.shiftView.hidden = false;
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else showFlash(err.message, "error");
  } finally {
    els.loading.hidden = true;
  }
}

function renderShift(data) {
  const period = els.periodSelect.value;
  if (!data.published) {
    els.shiftMeta.textContent = "";
    els.myShiftList.innerHTML = `<li>${formatPeriod(period)}のシフトはまだ公開されていません。</li>`;
    els.allShiftCard.hidden = true;
    return;
  }
  els.shiftMeta.textContent = `${formatUpdated(data.published_at)} に公開されたシフトです。`;
  els.allShiftCard.hidden = false;

  // ---- あなたのシフト ----
  const mine = data.assignments.filter((a) => a.staff_id === data.me);
  els.myShiftList.innerHTML = mine.length
    ? mine
        .map(
          (a) =>
            `<li><span>${formatDate(a.date)}</span><span></span><span>${escapeHtml(
              formatRange(a.start_time, a.end_time || "ラスト") || "時間未定"
            )}</span></li>`
        )
        .join("")
    : "<li>この月のシフトはありません。</li>";

  // ---- みんなのシフト（名前 × 日付の表） ----
  const dates = Array.from({ length: daysInMonth(period) }, (_, i) => toDate(period, i + 1));
  const byKey = new Map(data.assignments.map((a) => [`${a.staff_id}|${a.date}`, a]));
  const short = (t) => (t ? t.replace(/:00$/, "") : "");

  let html = "<thead><tr><th class='name'>名前</th>";
  for (const d of dates) {
    const wd = weekdayOf(d);
    const holiday = isHoliday(d);
    html += `<th class="${wd === 0 || holiday ? "sun" : wd === 6 ? "sat" : ""}">${Number(d.slice(-2))}<br>${
      holiday ? "祝" : WEEKDAYS[wd]
    }</th>`;
  }
  html += "</tr></thead><tbody>";
  for (const person of data.staff) {
    // シフトが1日もない人は表に出さない
    if (!dates.some((d) => byKey.has(`${person.id}|${d}`))) continue;
    html += `<tr class="${person.id === data.me ? "me-row" : ""}"><td class="name">${escapeHtml(person.name)}</td>`;
    for (const d of dates) {
      const a = byKey.get(`${person.id}|${d}`);
      html += a
        ? `<td class="on">${escapeHtml(short(a.start_time) || "?")}-${escapeHtml(a.end_time ? short(a.end_time) : "L")}</td>`
        : "<td></td>";
    }
    html += "</tr>";
  }
  html += "</tbody>";
  els.allShiftTable.innerHTML = html;
}

// サーバーから最新の状況を読み込んで、表示を決め直す
async function refresh() {
  els.loading.hidden = false;
  els.shiftView.hidden = true;
  showView(null);
  try {
    current = await api(`/api/submission?period=${els.periodSelect.value}`, { token: idToken });
    decideView();
  } catch (err) {
    if (err instanceof AuthError) {
      handleError(err);
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

  // 締切前なら修正、締切後なら申請
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

  // 誰の分かはサーバーがLINEの本人確認で決めるので、名前は送らない
  const body = {
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
    await api("/api/submission", { method: "POST", body, token: idToken });
    // 送信できたら完了画面に切り替える
    await refresh();
    els.doneTitle.textContent = "提出しました！";
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    if (err instanceof AuthError) {
      handleError(err);
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
      body: { period: els.periodSelect.value, message },
      token: idToken,
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
