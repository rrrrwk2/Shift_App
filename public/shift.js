// =========================================================
// シフト作成画面の動き（作成担当用）
//
// ・みんなの希望（submissions）は見るだけで書き換えない
// ・組んだシフトは「下書き」（assignments）に保存する
// ・「公開する」を押した時点の下書きが、スタッフに見えるシフトになる
// =========================================================

const $ = (id) => document.getElementById(id);
const els = {
  content: $("content"),
  periodSelect: $("period-select"),
  status: $("status"),
  reloadButton: $("reload-button"),
  generateButton: $("generate-button"),
  notifyCheck: $("notify-check"),
  publishButton: $("publish-button"),
  actionMessage: $("action-message"),
  grid: $("shift-grid"),
  issuesCard: $("issues-card"),
  issuesTitle: $("issues-title"),
  issuesList: $("issues-list"),
  dialog: $("cell-dialog"),
  cellTitle: $("cell-title"),
  cellPref: $("cell-pref"),
  cellStart: $("cell-start"),
  cellEnd: $("cell-end"),
  cellSave: $("cell-save"),
  cellRemove: $("cell-remove"),
  cellCancel: $("cell-cancel"),
  cellMessage: $("cell-message"),
};

// 画面の状態（load() で読み込む）
let state = null;
// {
//   period, staff, rules, schedule,
//   prefs:   Map("staffId|date" → { status, start_time, end_time })   … 希望
//   subs:    Map(staffId → 提出内容)
//   shifts:  Map("staffId|date" → { start_time, end_time })           … 下書き
// }
let editing = null; // ダイアログで編集中のマス { staffId, date }

const keyOf = (staffId, date) => `${staffId}|${date}`;

init();

async function init() {
  els.periodSelect.addEventListener("change", load);
  els.reloadButton.addEventListener("click", load);
  els.generateButton.addEventListener("click", onGenerate);
  els.publishButton.addEventListener("click", onPublish);
  // 表のマスをタップしたとき（マス1つ1つではなく、表全体で受け取る）
  els.grid.addEventListener("click", (e) => {
    const cell = e.target.closest("td[data-staff]");
    if (cell) openCell(Number(cell.dataset.staff), cell.dataset.date);
  });
  els.cellSave.addEventListener("click", onSaveCell);
  els.cellRemove.addEventListener("click", onRemoveCell);
  els.cellCancel.addEventListener("click", () => els.dialog.close());

  // LINEでログインして、管理者だと確認できたら読み込む（admin-auth.js）
  await adminLogin(async () => {
    fillPeriodSelect(els.periodSelect, await api("/api/periods"));
    await load();
    watchOtherEdits();
  });
}

function handleError(err) {
  if (err instanceof AuthError || err.status === 403) {
    handleAuthError(err); // 本人確認が切れた・管理者でなくなった（admin-auth.js）
  } else {
    setMessage(err.message, "error");
  }
}

// ---------------------------------------------------------
// 読み込み
// ---------------------------------------------------------
async function load() {
  const period = els.periodSelect.value;
  try {
    const [sub, sch] = await Promise.all([
      adminApi(`/api/admin/submissions?period=${period}`),
      adminApi(`/api/admin/schedule?period=${period}`),
    ]);

    const prefs = new Map();
    const subs = new Map();
    for (const s of sub.submissions) {
      subs.set(s.staff_id, s);
      for (const d of s.days) prefs.set(keyOf(s.staff_id, d.date), d);
    }
    const shifts = new Map(sch.assignments.map((a) => [keyOf(a.staff_id, a.date), a]));

    state = { period, staff: sub.staff, rules: sub.rules, schedule: sch.schedule, prefs, subs, shifts };
    render();
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------
// ほかの管理者の変更を反映する
//   30秒ごと（と、この画面に戻ってきたとき）に下書きの「変更の番号」を確かめて、
//   変わっていたら読み込み直す。マスを編集している最中は待つ
// ---------------------------------------------------------
function watchOtherEdits() {
  const check = async () => {
    if (!state || document.hidden || els.dialog.open) return;
    try {
      const sch = await adminApi(`/api/admin/schedule?period=${state.period}`);
      if (sch.schedule.draft_version === state.schedule.draft_version) return;
      await load();
      if (sch.schedule.updated_by && sch.schedule.updated_by !== adminName) {
        setMessage(`${sch.schedule.updated_by}さんの変更を反映しました`, "success");
      }
    } catch {
      // 通信できなかったときは、次の確認まで待つ
    }
  };
  setInterval(check, 30 * 1000);
  document.addEventListener("visibilitychange", check);
}

function render() {
  renderStatus();
  renderGrid();
}

// ---------------------------------------------------------
// 下書き・公開の状態
// ---------------------------------------------------------
function renderStatus() {
  const { schedule, shifts } = state;
  // 下書きは、マスを変えるたびに自動で保存されている（保存ボタンはいらない）
  const by = schedule.updated_by ? ` ${schedule.updated_by}さん` : "";
  const draft = schedule.exists
    ? `下書き：${shifts.size}コマ（自動保存済み・最終更新 ${formatUpdated(schedule.updated_at)}${by}）`
    : "下書き：まだありません";
  let pub = "公開：まだ";
  if (schedule.published_at) {
    pub = `公開：${formatUpdated(schedule.published_at)}`;
    if (schedule.changed_since_publish) pub += "（公開後に変更あり。もう一度公開するとスタッフに反映）";
  }
  els.status.innerHTML = `<div>${escapeHtml(draft)}</div><div class="${
    schedule.changed_since_publish ? "status-alert" : ""
  }">${escapeHtml(pub)}</div>`;

  els.generateButton.textContent = schedule.exists ? "希望から下書きを再作成" : "希望から下書きを作成";
  els.publishButton.textContent = schedule.published_at ? "公開内容を更新する" : "公開する";
  els.publishButton.disabled = shifts.size === 0 || (schedule.published_at && !schedule.changed_since_publish);
}

async function onGenerate() {
  const period = state.period;
  const again = state.schedule.exists;
  if (
    again &&
    !confirm("今の下書きを消して、希望の○から作り直します。手で直したところも消えます。よろしいですか？")
  ) {
    return;
  }
  els.generateButton.disabled = true;
  try {
    const res = await adminApi("/api/admin/schedule/generate", {
      method: "POST",
      body: { period, overwrite: again },
    });
    await load();
    setMessage(`希望の○から下書きを作りました（${res.count}コマ）`, "success");
  } catch (err) {
    handleError(err);
  } finally {
    els.generateButton.disabled = false;
  }
}

async function onPublish() {
  const notify = els.notifyCheck.checked;
  const what = state.schedule.published_at ? "公開内容を今の下書きで更新" : "このシフトを公開";
  if (!confirm(`${formatPeriod(state.period)}の${what}します。${notify ? "LINEでみんなに知らせます。" : ""}よろしいですか？`)) {
    return;
  }
  els.publishButton.disabled = true;
  try {
    const res = await adminApi("/api/admin/schedule/publish", {
      method: "POST",
      body: { period: state.period, notify },
    });
    await load();
    setMessage(
      `${res.updated ? "公開内容を更新しました" : "公開しました"}${res.notified ? `（LINEで${res.notified}人に知らせました）` : ""}`,
      "success"
    );
  } catch (err) {
    handleError(err);
    renderStatus();
  }
}

function setMessage(text, type = "") {
  els.actionMessage.textContent = text;
  els.actionMessage.className = "message" + (type ? ` ${type}` : "");
}

// ---------------------------------------------------------
// シフト表
// ---------------------------------------------------------

// "17:00" → "17"、"17:30" → "17:30"（マスの中は狭いので短くする）
const shortTime = (t) => (t ? t.replace(/:00$/, "") : "");

function renderGrid() {
  const { period, staff, rules, prefs, shifts } = state;
  const dates = Array.from({ length: daysInMonth(period) }, (_, i) => toDate(period, i + 1));

  // 日ごとに、入っている人数を数える（全体・男性・女性・ベテラン）
  // ※ 判定のしくみ（rules.js の judgeDay）は「○と△」の形で受け取るので、△の側は0にしておく
  const zero = () => Object.fromEntries(dates.map((d) => [d, 0]));
  const newCounter = () => ({ all: zero(), male: zero(), female: zero(), veteran: zero() });
  const count = { ok: newCounter(), maybe: newCounter() };

  let body = "<tbody>";
  for (const person of staff) {
    let days = 0;
    let cells = "";
    for (const date of dates) {
      const pref = prefs.get(keyOf(person.id, date));
      const shift = shifts.get(keyOf(person.id, date));
      const cls = ["cell", pref ? `pref-${pref.status}` : "pref-none"];
      let inner = pref ? `<span class="pref">${pref.status === "ok" ? "○" : "△"}</span>` : "";
      if (shift) {
        days++;
        cls.push("assigned");
        if (!pref) cls.push("outside"); // 希望が出ていない日に入れた
        const c = count.ok;
        c.all[date]++;
        if (person.gender === "male") c.male[date]++;
        if (person.gender === "female") c.female[date]++;
        if (person.level === "veteran") c.veteran[date]++;
        const end = shift.end_time ? shortTime(shift.end_time) : "L";
        inner += `<span class="shift-time">${escapeHtml(shortTime(shift.start_time) || "?")}-${escapeHtml(end)}</span>`;
      }
      cells += `<td class="${cls.join(" ")}" data-staff="${person.id}" data-date="${date}">${inner}</td>`;
    }
    body += `<tr><td class="name">${escapeHtml(person.name)}</td><td>${GENDER_SHORT[person.gender] ?? "-"}</td><td class="${
      person.level === "veteran" ? "level-veteran" : ""
    }">${LEVEL_SHORT[person.level] ?? "-"}</td><td>${days}</td>${cells}</tr>`;
  }
  body += "</tbody>";

  const judged = Object.fromEntries(dates.map((d) => [d, judgeDay(d, count, rules)]));

  // 見出し
  let head = "<thead><tr><th class='name'>名前</th><th>性別</th><th>レベル</th><th>日数</th>";
  for (const date of dates) {
    const wd = weekdayOf(date);
    const holiday = isHoliday(date);
    const dayCls = wd === 0 || holiday ? "sun" : wd === 6 ? "sat" : "";
    head += `<th class="${dayCls} ${judged[date].level}" title="${escapeHtml(
      judged[date].items.map((i) => i.text).join("、")
    )}">${Number(date.slice(-2))}<br>${holiday ? "祝" : WEEKDAYS[wd]}</th>`;
  }
  head += "</tr></thead>";

  // 下の合計（行ごとに、その項目の判定で色をつける → 何が原因か分かる）
  const footRow = (label, values, cls, ruleKey) => {
    let row = `<tr class="${cls}"><td class='name'>${label}</td><td colspan='3'></td>`;
    for (const date of dates) {
      const item = judged[date].items.find((i) => i.key === ruleKey);
      const target = judged[date].targets[ruleKey];
      const text = values[date] || (target != null ? "0" : "");
      row += `<td class="${item?.level ?? ""}">${text}${target != null ? `<span class="target">/${target}</span>` : ""}</td>`;
    }
    return row + "</tr>";
  };
  let foot = "<tfoot>";
  foot += footRow("入る人数（定員）", count.ok.all, "", "capacity");
  foot += footRow("　うち男性", count.ok.male, "sub-count", "male");
  foot += footRow("　うち女性", count.ok.female, "sub-count", "female");
  foot += footRow("　うちベテラン", count.ok.veteran, "sub-count", "veteran");
  foot += "</tfoot>";

  els.grid.innerHTML = head + body + foot;
  renderIssues(dates, judged);
}

// ---------------------------------------------------------
// 調整が必要なところ
//   ・定員・男女・ベテランが足りない／多い日
//   ・希望が出ていない日に入れた人
//   ・週の日数の希望（週◯日以上・まで）に合っていない人
// ---------------------------------------------------------
function renderIssues(dates, judged) {
  const { staff, prefs, shifts, subs } = state;
  const lines = [];

  for (const d of dates) {
    if (!judged[d].level) continue;
    lines.push(
      `<li><span class="issue-date">${formatDate(d)}${isHoliday(d) ? "祝" : ""}</span>${judged[d].items
        .map((i) => `<span class="issue-chip ${i.level}">${escapeHtml(i.text)}</span>`)
        .join("")}</li>`
    );
  }

  for (const person of staff) {
    // 希望が出ていない日に入っている
    const outside = dates.filter((d) => shifts.has(keyOf(person.id, d)) && !prefs.has(keyOf(person.id, d)));
    if (outside.length) {
      lines.push(
        `<li><span class="issue-date">${escapeHtml(person.name)}</span><span class="issue-chip ng">希望が出ていない日：${outside
          .map(formatDate)
          .join("、")}</span></li>`
      );
    }

    // 週の日数（月曜〜日曜で数える）
    const sub = subs.get(person.id);
    if (!sub || (sub.min_days_per_week == null && sub.max_days_per_week == null)) continue;
    for (const week of weeksOf(dates)) {
      const n = week.days.filter((d) => shifts.has(keyOf(person.id, d))).length;
      const label = `${formatDate(week.days[0])}〜${formatDate(week.days[week.days.length - 1])}`;
      if (sub.max_days_per_week != null && n > sub.max_days_per_week) {
        lines.push(
          `<li><span class="issue-date">${escapeHtml(person.name)}</span><span class="issue-chip over">${label} ${n}日（希望は週${sub.max_days_per_week}日まで）</span></li>`
        );
      }
      // 月の始まりと終わりの、途中で切れている週は「少なすぎ」は見ない
      if (week.full && sub.min_days_per_week != null && n < sub.min_days_per_week) {
        lines.push(
          `<li><span class="issue-date">${escapeHtml(person.name)}</span><span class="issue-chip warn">${label} ${n}日（希望は週${sub.min_days_per_week}日以上）</span></li>`
        );
      }
    }
  }

  els.issuesCard.hidden = lines.length === 0;
  els.issuesTitle.textContent = `調整が必要なところ（${lines.length}件）`;
  els.issuesList.innerHTML = lines.join("");
}

// 月の日付を、月曜はじまりの週ごとに分ける（full: 7日そろっている週か）
function weeksOf(dates) {
  const weeks = [];
  let current = null;
  for (const d of dates) {
    if (!current || weekdayOf(d) === 1) {
      current = { days: [] };
      weeks.push(current);
    }
    current.days.push(d);
  }
  for (const w of weeks) w.full = w.days.length === 7;
  return weeks;
}

// ---------------------------------------------------------
// マスの編集（入れる・外す・時間を変える）
// ---------------------------------------------------------
function openCell(staffId, date) {
  const person = state.staff.find((p) => p.id === staffId);
  const pref = state.prefs.get(keyOf(staffId, date));
  const shift = state.shifts.get(keyOf(staffId, date));
  const sub = state.subs.get(staffId);
  editing = { staffId, date };

  els.cellTitle.textContent = `${formatDate(date)} ${person.name} さん`;

  // 希望の説明と、時間の初期値（下書き → その日の希望 → 基本の時間 の順）
  let prefText;
  if (!sub) prefText = "希望：まだ提出していません";
  else if (!pref) prefText = "希望：この日は希望が出ていません";
  else {
    const start = pref.start_time || sub.default_start;
    const end = pref.end_time || sub.default_end;
    prefText = `希望：${pref.status === "ok" ? "○（入れる）" : "△（相談可）"} ${formatRange(start, end) || "時間指定なし"}`;
  }
  if (sub?.note) prefText += `／備考：${sub.note}`;
  els.cellPref.textContent = prefText;

  els.cellStart.value = shift?.start_time ?? pref?.start_time ?? sub?.default_start ?? "";
  els.cellEnd.value = shift?.end_time ?? pref?.end_time ?? sub?.default_end ?? "";
  els.cellSave.textContent = shift ? "時間を変える" : "入れる";
  els.cellRemove.hidden = !shift;
  els.cellMessage.textContent = "";
  els.dialog.showModal();
}

async function onSaveCell() {
  const { staffId, date } = editing;
  await saveCell("/api/admin/schedule/assign", {
    period: state.period,
    staff_id: staffId,
    date,
    start_time: els.cellStart.value,
    end_time: els.cellEnd.value,
  });
}

async function onRemoveCell() {
  const { staffId, date } = editing;
  await saveCell("/api/admin/schedule/unassign", { period: state.period, staff_id: staffId, date });
}

async function saveCell(path, body) {
  els.cellSave.disabled = els.cellRemove.disabled = true;
  try {
    await adminApi(path, { method: "POST", body });
    els.dialog.close();
    await load();
  } catch (err) {
    if (err instanceof AuthError) {
      els.dialog.close();
      handleError(err);
    } else {
      els.cellMessage.textContent = err.message;
    }
  } finally {
    els.cellSave.disabled = els.cellRemove.disabled = false;
  }
}
