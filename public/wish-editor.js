// =========================================================
// 希望の代理入力（一覧画面で使う）
//
// 遅れて出した人の希望や、口頭・LINEで聞いた変更を、管理者が代わりに入力する。
// ・締切を過ぎていても保存できる
// ・保存すると「代理入力：（入力した管理者の名前）」が記録に残る
// ・本人があとから自分で提出し直したら、本人の提出に置きかわる
// =========================================================

const wishEls = {
  dialog: document.getElementById("wish-dialog"),
  title: document.getElementById("wish-title"),
  info: document.getElementById("wish-info"),
  start: document.getElementById("wish-start"),
  end: document.getElementById("wish-end"),
  calendar: document.getElementById("wish-calendar"),
  dayCard: document.getElementById("wish-day-card"),
  dayList: document.getElementById("wish-day-list"),
  min: document.getElementById("wish-min"),
  max: document.getElementById("wish-max"),
  note: document.getElementById("wish-note"),
  save: document.getElementById("wish-save"),
  remove: document.getElementById("wish-delete"),
  cancel: document.getElementById("wish-cancel"),
  message: document.getElementById("wish-message"),
};

// 編集中の内容
let wishTarget = null; // { person, period, sub, onSaved, closedDates }
let wishDays = new Map(); // "2026-12-03" → { status: "ok" | "maybe", start_time, end_time }

// 週の日数の選択肢（最初に1回だけ作る）
for (const [select, suffix] of [
  [wishEls.min, "以上"],
  [wishEls.max, "まで"],
]) {
  select.innerHTML = '<option value="">指定なし</option>';
  for (let n = 1; n <= 7; n++) select.insertAdjacentHTML("beforeend", `<option value="${n}">週${n}日${suffix}</option>`);
}

wishEls.cancel.addEventListener("click", () => wishEls.dialog.close());
wishEls.save.addEventListener("click", onSaveWish);
wishEls.remove.addEventListener("click", onDeleteWish);
wishEls.start.addEventListener("input", renderWishDayList);
wishEls.end.addEventListener("input", renderWishDayList);

// 編集画面を開く
//   person : 名簿の1人（{ id, name, ... }）
//   period : "2026-12"
//   sub    : その人の今の希望（未提出なら null）
//   onSaved: 保存・削除できたあとに呼ぶ（一覧を読み込み直すため）
//   closedDates: 定休日（Set）。カレンダーで選べなくする
function openWishEditor(person, period, sub, onSaved, closedDates = new Set()) {
  wishTarget = { person, period, sub, onSaved, closedDates };
  wishEls.title.textContent = `${person.name} さんの ${formatPeriod(period)} の希望`;

  // 今の状態と、代理入力であることの説明
  let status = "まだ提出されていません。";
  if (sub) {
    status = sub.entered_by
      ? `${formatUpdated(sub.updated_at)} に ${sub.entered_by} さんが代理入力した内容です。`
      : `${formatUpdated(sub.updated_at)} に本人が提出した内容です。`;
  }
  wishEls.info.textContent = `${status}保存すると「代理入力：あなたの名前」として記録され、締切後でも反映されます。本人があとから提出し直した場合は、本人の内容に置きかわります。`;

  // 入力欄に今の内容を入れる（未提出なら空。時間は 17:00〜）
  wishEls.start.value = sub ? sub.default_start ?? "" : "17:00";
  wishEls.end.value = sub?.default_end ?? "";
  wishEls.min.value = sub?.min_days_per_week ?? "";
  wishEls.max.value = sub?.max_days_per_week ?? "";
  wishEls.note.value = sub?.note ?? "";
  // 定休日に残っている希望は外す（定休日はあとから設定されることもあるため）
  wishDays = new Map(
    (sub?.days ?? [])
      .filter((d) => !closedDates.has(d.date))
      .map((d) => [d.date, { status: d.status, start_time: d.start_time ?? "", end_time: d.end_time ?? "" }])
  );

  wishEls.remove.hidden = !sub;
  wishEls.message.textContent = "";
  renderWishCalendar();
  renderWishDayList();
  wishEls.dialog.showModal();
  wishEls.dialog.scrollTop = 0;
}

// ---------------------------------------------------------
// カレンダー（タップで 空欄 → ○ → △ → 空欄）
// ---------------------------------------------------------
function renderWishCalendar() {
  const period = wishTarget.period;
  let html = WEEKDAYS.map((w, i) => `<div class="head${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${w}</div>`).join("");
  html += "<div></div>".repeat(firstWeekday(period));
  for (let day = 1; day <= daysInMonth(period); day++) {
    const date = toDate(period, day);
    const wd = weekdayOf(date);
    const status = wishDays.get(date)?.status;
    const dayCls = wd === 0 || isHoliday(date) ? " sun" : wd === 6 ? " sat" : "";
    if (wishTarget.closedDates.has(date)) {
      // 定休日は選べない
      html += `<button type="button" class="day closed${dayCls}" disabled aria-label="${formatDate(date)} 定休日">
        <span class="num">${day}</span><span class="mark">休</span>
      </button>`;
      continue;
    }
    html += `<button type="button" class="day${dayCls}${status ? ` ${status}` : ""}" data-date="${date}">
      <span class="num">${day}</span><span class="mark">${status === "ok" ? "○" : status === "maybe" ? "△" : ""}</span>
    </button>`;
  }
  wishEls.calendar.innerHTML = html;
}

wishEls.calendar.addEventListener("click", (e) => {
  const cell = e.target.closest("button[data-date]");
  if (!cell) return;
  const date = cell.dataset.date;
  const now = wishDays.get(date);
  if (!now) wishDays.set(date, { status: "ok", start_time: "", end_time: "" });
  else if (now.status === "ok") now.status = "maybe";
  else wishDays.delete(date);
  renderWishCalendar();
  renderWishDayList();
});

// 選んだ日ごとの時間（空欄なら基本の時間）
function renderWishDayList() {
  if (!wishTarget) return;
  const sorted = [...wishDays.keys()].sort();
  wishEls.dayCard.hidden = sorted.length === 0;
  wishEls.dayList.innerHTML = "";
  for (const date of sorted) {
    const d = wishDays.get(date);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="day-label">${formatDate(date)}
        <span class="${d.status === "ok" ? "badge-ok" : "badge-maybe"}">${d.status === "ok" ? "○" : "△"}</span>
      </div>
      <div class="row">
        <input type="time" aria-label="開始" />
        <span class="sep">〜</span>
        <input type="time" aria-label="終了" />
      </div>`;
    const [startInput, endInput] = li.querySelectorAll("input");
    startInput.value = d.start_time;
    endInput.value = d.end_time;
    startInput.addEventListener("input", () => (d.start_time = startInput.value));
    endInput.addEventListener("input", () => (d.end_time = endInput.value));
    wishEls.dayList.append(li);
  }
}

// ---------------------------------------------------------
// 保存・削除
// ---------------------------------------------------------
async function onSaveWish() {
  const { person, period, onSaved } = wishTarget;
  const body = {
    staff_id: person.id,
    period,
    default_start: wishEls.start.value,
    default_end: wishEls.end.value,
    min_days_per_week: wishEls.min.value ? Number(wishEls.min.value) : null,
    max_days_per_week: wishEls.max.value ? Number(wishEls.max.value) : null,
    note: wishEls.note.value.trim(),
    days: [...wishDays.keys()].sort().map((date) => ({ date, ...wishDays.get(date) })),
  };
  wishEls.save.disabled = true;
  try {
    await adminApi("/api/admin/submission", { method: "POST", body });
    wishEls.dialog.close();
    await onSaved(`${person.name} さんの希望を代理入力しました`);
  } catch (err) {
    if (err instanceof AuthError || err.status === 403) {
      wishEls.dialog.close();
      handleAuthError(err);
    } else {
      wishEls.message.textContent = err.message;
    }
  } finally {
    wishEls.save.disabled = false;
  }
}

async function onDeleteWish() {
  const { person, period, onSaved } = wishTarget;
  if (!confirm(`${person.name} さんの ${formatPeriod(period)} の希望を削除して、未提出に戻します。よろしいですか？`)) return;
  wishEls.remove.disabled = true;
  try {
    await adminApi("/api/admin/submission/delete", { method: "POST", body: { staff_id: person.id, period } });
    wishEls.dialog.close();
    await onSaved(`${person.name} さんの希望を削除しました`);
  } catch (err) {
    if (err instanceof AuthError || err.status === 403) {
      wishEls.dialog.close();
      handleAuthError(err);
    } else {
      wishEls.message.textContent = err.message;
    }
  } finally {
    wishEls.remove.disabled = false;
  }
}
