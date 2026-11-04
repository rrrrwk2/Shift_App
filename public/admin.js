// =========================================================
// 作成担当用の一覧画面の動き
// =========================================================

const ADMIN_KEY_NAME = "shiftapp.adminKey";

const $ = (id) => document.getElementById(id);
const els = {
  keySection: $("key-section"),
  keyInput: $("key-input"),
  keyButton: $("key-button"),
  keyMessage: $("key-message"),
  content: $("content"),
  periodSelect: $("period-select"),
  summary: $("summary"),
  reloadButton: $("reload-button"),
  grid: $("grid"),
  staffName: $("staff-name"),
  staffAdd: $("staff-add"),
  staffMessage: $("staff-message"),
  staffList: $("staff-list"),
  requestsCard: $("requests-card"),
  requestsTitle: $("requests-title"),
  requestsList: $("requests-list"),
};

let adminKey = loadKey(ADMIN_KEY_NAME);

init();

async function init() {
  els.keyButton.addEventListener("click", onKeyEntered);
  els.keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onKeyEntered();
  });
  els.periodSelect.addEventListener("change", load);
  els.reloadButton.addEventListener("click", load);
  els.staffAdd.addEventListener("click", onAddStaff);
  els.staffName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAddStaff();
  });

  if (adminKey) {
    await start();
  } else {
    showKeySection();
  }
}

async function start() {
  try {
    await api("/api/admin/check", { key: adminKey });
    // 月の選択肢（締切情報つき）をサーバーから受け取る
    fillPeriodSelect(els.periodSelect, await api("/api/periods", { key: adminKey }));
    els.keySection.hidden = true;
    els.content.hidden = false;
    await load();
  } catch (err) {
    handleError(err);
  }
}

function showKeySection(message = "") {
  els.content.hidden = true;
  els.keySection.hidden = false;
  els.keyMessage.textContent = message;
  els.keyInput.focus();
}

async function onKeyEntered() {
  const value = els.keyInput.value.trim();
  if (!value) return;
  adminKey = value;
  saveKey(ADMIN_KEY_NAME, value);
  await start();
}

function handleError(err) {
  if (err instanceof AuthError) {
    clearKey(ADMIN_KEY_NAME);
    adminKey = "";
    showKeySection(err.message);
  } else if (els.content.hidden) {
    // まだ一覧を表示していない段階のエラーは、合言葉の欄の下に出す
    showKeySection(err.message);
  } else {
    els.summary.textContent = err.message;
  }
}

// ---------------------------------------------------------
// データを読み込んで表と名簿を描く
// ---------------------------------------------------------
async function load() {
  const period = els.periodSelect.value;
  try {
    const data = await api(`/api/admin/submissions?period=${period}`, { key: adminKey });
    renderGrid(period, data.staff, data.submissions, data.period_info);
    renderRequests(data.change_requests);
    renderStaffList(data.staff);
  } catch (err) {
    handleError(err);
  }
}

function renderGrid(period, staff, submissions, periodInfo) {
  const total = daysInMonth(period);
  const dates = Array.from({ length: total }, (_, i) => toDate(period, i + 1));

  // staff_id → 提出内容 の対応表を作る
  const byStaff = new Map(submissions.map((s) => [s.staff_id, s]));

  // 日ごとの○△の人数を数える
  const okCount = Object.fromEntries(dates.map((d) => [d, 0]));
  const maybeCount = Object.fromEntries(dates.map((d) => [d, 0]));

  // ---- 見出し ----
  let html = "<thead><tr><th class='name'>名前</th><th>週の希望</th><th>基本の時間</th>";
  for (const date of dates) {
    const wd = weekdayOf(date);
    const cls = wd === 0 ? "sun" : wd === 6 ? "sat" : "";
    html += `<th class="${cls}">${Number(date.slice(-2))}<br>${WEEKDAYS[wd]}</th>`;
  }
  html += "<th>備考</th><th>更新</th></tr></thead><tbody>";

  // ---- 1人1行 ----
  let submittedCount = 0;
  for (const person of staff) {
    const sub = byStaff.get(person.id);
    if (sub) submittedCount++;
    const dayMap = new Map((sub?.days ?? []).map((d) => [d.date, d]));

    html += `<tr class="${sub ? "" : "unsubmitted"}"><td class="name">${escapeHtml(person.name)}</td>`;
    html += `<td>${sub ? weeklyText(sub) : "未提出"}</td>`;
    html += `<td>${sub ? escapeHtml(formatRange(sub.default_start, sub.default_end) || "-") : ""}</td>`;
    for (const date of dates) {
      const d = dayMap.get(date);
      if (!d) {
        html += "<td></td>";
        continue;
      }
      if (d.status === "ok") okCount[date]++;
      else maybeCount[date]++;
      const mark = d.status === "ok" ? "○" : "△";
      const time = formatRange(d.start_time, d.end_time);
      html += `<td class="${d.status}">${mark}${
        time ? `<span class="time">${escapeHtml(time)}</span>` : ""
      }</td>`;
    }
    html += `<td class="note">${escapeHtml(sub?.note ?? "")}</td>`;
    html += `<td>${sub ? escapeHtml(formatUpdated(sub.updated_at)) : ""}</td></tr>`;
  }
  html += "</tbody>";

  // ---- 合計 ----
  html += "<tfoot><tr><td class='name'>○の人数</td><td colspan='2'></td>";
  for (const date of dates) html += `<td>${okCount[date] || ""}</td>`;
  html += "<td colspan='2'></td></tr><tr><td class='name'>△の人数</td><td colspan='2'></td>";
  for (const date of dates) html += `<td>${maybeCount[date] || ""}</td>`;
  html += "<td colspan='2'></td></tr></tfoot>";

  els.grid.innerHTML = html;
  const deadline = periodInfo.open
    ? `提出期限 ${periodInfo.deadline}まで`
    : `提出期限 ${periodInfo.deadline}（締切済み）`;
  els.summary.textContent = `${formatPeriod(period)}：提出済み ${submittedCount} / ${staff.length}人 ・ ${deadline}`;
}

// 週の日数の希望を文章にする
function weeklyText(sub) {
  const min = sub.min_days_per_week;
  const max = sub.max_days_per_week;
  if (min && max) return min === max ? `週${min}日` : `週${min}〜${max}日`;
  if (min) return `週${min}日以上`;
  if (max) return `週${max}日まで`;
  return "-";
}

// ---------------------------------------------------------
// 変更の申請
// ---------------------------------------------------------
function renderRequests(requests) {
  const openCount = requests.filter((r) => r.status === "open").length;
  els.requestsCard.hidden = requests.length === 0;
  els.requestsTitle.textContent = `変更の申請（未対応 ${openCount}件）`;
  els.requestsList.innerHTML = "";

  for (const r of requests) {
    const li = document.createElement("li");
    const done = r.status === "done";
    li.innerHTML = `
      <div class="request-head">
        <span class="${done ? "status-done" : "status-open"}">${done ? "対応済み" : "未対応"}</span>
        <strong>${escapeHtml(r.name)}</strong>
        <span class="hint" style="margin:0">${escapeHtml(formatUpdated(r.created_at))}</span>
      </div>
      <div class="request-body">${escapeHtml(r.message)}</div>
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = done ? "未対応に戻す" : "対応済みにする";
    button.style.marginTop = "8px";
    button.addEventListener("click", () => setRequestStatus(r.id, done ? "open" : "done"));
    li.append(button);
    els.requestsList.append(li);
  }
}

async function setRequestStatus(id, status) {
  try {
    await api("/api/admin/change-request/status", {
      method: "POST",
      body: { id, status },
      key: adminKey,
    });
    await load();
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------
// スタッフの登録・削除
// ---------------------------------------------------------
function renderStaffList(staff) {
  els.staffList.innerHTML = "";
  for (const person of staff) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = person.name;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "外す";
    button.addEventListener("click", () => onRemoveStaff(person));
    li.append(name, button);
    els.staffList.append(li);
  }
}

async function onAddStaff() {
  const name = els.staffName.value.trim();
  if (!name) return;
  els.staffAdd.disabled = true;
  try {
    await api("/api/admin/staff", { method: "POST", body: { name }, key: adminKey });
    els.staffName.value = "";
    setStaffMessage(`${name} さんを追加しました`, "success");
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
  } finally {
    els.staffAdd.disabled = false;
  }
}

async function onRemoveStaff(person) {
  if (!confirm(`${person.name} さんを一覧から外しますか？（これまでの提出データは残ります）`)) return;
  try {
    await api("/api/admin/staff/deactivate", {
      method: "POST",
      body: { id: person.id },
      key: adminKey,
    });
    setStaffMessage(`${person.name} さんを外しました`, "success");
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

function setStaffMessage(text, type = "") {
  els.staffMessage.textContent = text;
  els.staffMessage.className = "message" + (type ? ` ${type}` : "");
}
