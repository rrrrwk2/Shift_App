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
  remindHint: $("remind-hint"),
  remindLog: $("remind-log"),
  remindButton: $("remind-button"),
  unsubmittedTitle: $("unsubmitted-title"),
  unsubmittedList: $("unsubmitted-list"),
  checkAllLabel: $("check-all-label"),
  checkAll: $("check-all"),
  remindMessage: $("remind-message"),
  requestsCard: $("requests-card"),
  requestsTitle: $("requests-title"),
  requestsList: $("requests-list"),
  ruleTotal: $("rule-total"),
  ruleVeteran: $("rule-veteran"),
  ruleMale: $("rule-male"),
  ruleFemale: $("rule-female"),
  ruleClosed: $("rule-closed"),
  rulesSave: $("rules-save"),
  rulesMessage: $("rules-message"),
  issuesCard: $("issues-card"),
  issuesTitle: $("issues-title"),
  issuesList: $("issues-list"),
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
  els.remindButton.addEventListener("click", onRemindNow);
  els.rulesSave.addEventListener("click", onSaveRules);
  els.checkAll.addEventListener("change", () => {
    for (const box of checkableBoxes()) box.checked = els.checkAll.checked;
    updateRemindButton();
  });
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
    renderGrid(period, data.staff, data.submissions, data.period_info, data.rules);
    renderRulesForm(data.rules);
    renderRequests(data.change_requests);
    renderReminders(data);
    renderStaffList(data.staff);
  } catch (err) {
    handleError(err);
  }
}

function renderGrid(period, staff, submissions, periodInfo, rules) {
  const total = daysInMonth(period);
  const dates = Array.from({ length: total }, (_, i) => toDate(period, i + 1));

  // staff_id → 提出内容 の対応表を作る
  const byStaff = new Map(submissions.map((s) => [s.staff_id, s]));

  // 日ごとに ○△ の人数を、全体・男性・女性・ベテランに分けて数える
  //   count.ok.all["2026-12-03"]     → その日に○の人の数
  //   count.ok.veteran["2026-12-03"] → そのうちベテランの数
  const zero = () => Object.fromEntries(dates.map((d) => [d, 0]));
  const newCounter = () => ({ all: zero(), male: zero(), female: zero(), veteran: zero() });
  const count = { ok: newCounter(), maybe: newCounter() };

  // ---- 1人1行（先に数えてから見出しを作るので、行は別にためておく） ----
  let body = "<tbody>";
  let submittedCount = 0;
  for (const person of staff) {
    const sub = byStaff.get(person.id);
    if (sub) submittedCount++;
    const dayMap = new Map((sub?.days ?? []).map((d) => [d.date, d]));

    body += `<tr class="${sub ? "" : "unsubmitted"}"><td class="name">${escapeHtml(person.name)}</td>`;
    body += `<td>${GENDER_SHORT[person.gender] ?? "-"}</td>`;
    body += `<td class="${person.level === "veteran" ? "level-veteran" : ""}">${LEVEL_SHORT[person.level] ?? "-"}</td>`;
    body += `<td>${sub ? weeklyText(sub) : "未提出"}</td>`;
    body += `<td>${sub ? escapeHtml(formatRange(sub.default_start, sub.default_end) || "-") : ""}</td>`;
    for (const date of dates) {
      const d = dayMap.get(date);
      if (!d) {
        body += "<td></td>";
        continue;
      }
      const c = count[d.status]; // ○なら count.ok、△なら count.maybe
      c.all[date]++;
      if (person.gender === "male") c.male[date]++;
      if (person.gender === "female") c.female[date]++;
      if (person.level === "veteran") c.veteran[date]++;
      const mark = d.status === "ok" ? "○" : "△";
      const time = formatRange(d.start_time, d.end_time);
      body += `<td class="${d.status}">${mark}${
        time ? `<span class="time">${escapeHtml(time)}</span>` : ""
      }</td>`;
    }
    body += `<td class="note">${escapeHtml(sub?.note ?? "")}</td>`;
    body += `<td>${sub ? escapeHtml(formatUpdated(sub.updated_at)) : ""}</td></tr>`;
  }
  body += "</tbody>";

  // ---- ルールの判定（日ごと） ----
  const judged = Object.fromEntries(dates.map((date) => [date, judgeDay(date, count, rules)]));

  // ---- 見出し（足りない日は色をつける） ----
  let head =
    "<thead><tr><th class='name'>名前</th><th>性別</th><th>レベル</th><th>週の希望</th><th>基本の時間</th>";
  for (const date of dates) {
    const wd = weekdayOf(date);
    const cls = [wd === 0 ? "sun" : wd === 6 ? "sat" : "", judged[date].level].join(" ");
    head += `<th class="${cls}" title="${escapeHtml(judged[date].reasons.join("、"))}">${Number(
      date.slice(-2)
    )}<br>${WEEKDAYS[wd]}</th>`;
  }
  head += "<th>備考</th><th>更新</th></tr></thead>";

  // ---- 合計（日ごとの人数） ----
  const footRow = (label, values, cls = "") => {
    let row = `<tr class="${cls}"><td class='name'>${label}</td><td colspan='4'></td>`;
    for (const date of dates) {
      row += `<td class="${judged[date].level}">${values[date] || ""}</td>`;
    }
    return row + "<td colspan='2'></td></tr>";
  };
  let foot = "<tfoot>";
  foot += footRow("○の人数", count.ok.all);
  foot += footRow("　うち男性", count.ok.male, "sub-count");
  foot += footRow("　うち女性", count.ok.female, "sub-count");
  foot += footRow("　うちベテラン", count.ok.veteran, "sub-count");
  foot += footRow("△の人数", count.maybe.all);
  foot += footRow("　うち男性", count.maybe.male, "sub-count");
  foot += footRow("　うち女性", count.maybe.female, "sub-count");
  foot += footRow("　うちベテラン", count.maybe.veteran, "sub-count");
  foot += "</tfoot>";

  els.grid.innerHTML = head + body + foot;
  renderIssues(dates, judged);

  const deadline = periodInfo.open
    ? `提出期限 ${periodInfo.deadline}まで`
    : `提出期限 ${periodInfo.deadline}（締切済み）`;
  const noGender = staff.filter((p) => !p.gender).length;
  const noLevel = staff.filter((p) => !p.level).length;
  els.summary.textContent =
    `${formatPeriod(period)}：提出済み ${submittedCount} / ${staff.length}人 ・ ${deadline}` +
    (noGender ? ` ・ 性別未設定 ${noGender}人` : "") +
    (noLevel ? ` ・ レベル未設定 ${noLevel}人` : "");
}

// ---------------------------------------------------------
// 毎日のルールの判定
//   level: ""     … 足りている（またはチェックしない日）
//          "warn" … ○の人だけでは足りないが、△の人も入れば足りる
//          "ng"   … △の人を入れても足りない
//   reasons: 足りないものの説明（例：「ベテラン 0/1人」）
// ---------------------------------------------------------
const RULE_ITEMS = [
  { key: "min_total", label: "合計", counter: "all" },
  { key: "min_veteran", label: "ベテラン", counter: "veteran" },
  { key: "min_male", label: "男性", counter: "male" },
  { key: "min_female", label: "女性", counter: "female" },
];

function judgeDay(date, count, rules) {
  if (rules.closed_weekdays.includes(weekdayOf(date))) return { level: "", reasons: [] };

  let level = "";
  const reasons = [];
  for (const item of RULE_ITEMS) {
    const need = rules[item.key];
    if (need === null || need === undefined) continue; // この項目はチェックしない
    const ok = count.ok[item.counter][date];
    const withMaybe = ok + count.maybe[item.counter][date];
    if (ok >= need) continue; // ○だけで足りている
    reasons.push(`${item.label} ${ok}/${need}人${withMaybe >= need ? "（△を入れれば足りる）" : ""}`);
    if (withMaybe < need) level = "ng";
    else if (level !== "ng") level = "warn";
  }
  return { level, reasons };
}

// 足りない日を文章で一覧にする（スマホでも分かるように）
function renderIssues(dates, judged) {
  const bad = dates.filter((d) => judged[d].level);
  els.issuesCard.hidden = bad.length === 0;
  els.issuesTitle.textContent = `人が足りない日（${bad.length}日）`;
  els.issuesList.innerHTML = bad
    .map(
      (d) =>
        `<li class="${judged[d].level}"><span class="issue-date">${formatDate(d)}</span>${escapeHtml(
          judged[d].reasons.join("、")
        )}</li>`
    )
    .join("");
}

// ---------------------------------------------------------
// ルールの設定欄
// ---------------------------------------------------------
let currentRules = null;

function renderRulesForm(rules) {
  currentRules = rules;
  els.ruleTotal.value = rules.min_total ?? "";
  els.ruleVeteran.value = rules.min_veteran ?? "";
  els.ruleMale.value = rules.min_male ?? "";
  els.ruleFemale.value = rules.min_female ?? "";
  els.ruleClosed.innerHTML = WEEKDAYS.map(
    (w, i) =>
      `<label class="check-row"><input type="checkbox" value="${i}" ${
        rules.closed_weekdays.includes(i) ? "checked" : ""
      } />${w}</label>`
  ).join("");
}

async function onSaveRules() {
  const num = (input) => (input.value === "" ? null : Number(input.value));
  const body = {
    min_total: num(els.ruleTotal),
    min_veteran: num(els.ruleVeteran),
    min_male: num(els.ruleMale),
    min_female: num(els.ruleFemale),
    closed_weekdays: [...els.ruleClosed.querySelectorAll("input:checked")].map((b) => Number(b.value)),
  };
  els.rulesSave.disabled = true;
  try {
    await api("/api/admin/rules", { method: "POST", body, key: adminKey });
    await load();
    setRulesMessage("保存しました", "success");
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setRulesMessage(err.message, "error");
  } finally {
    els.rulesSave.disabled = false;
  }
}

function setRulesMessage(text, type = "") {
  els.rulesMessage.textContent = text;
  els.rulesMessage.className = "message" + (type ? ` ${type}` : "");
}

// 性別・レベルの表示（作成担当だけが見る）
const GENDER_SHORT = { male: "男", female: "女" };
const LEVEL_SHORT = { new: "新人", regular: "通常", veteran: "ベテラン" };

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
// 提出のお願い（LINEでのリマインド）
// ---------------------------------------------------------
const REMIND_LABELS = { "3days": "自動（3日前）", "1day": "自動（前日）", manual: "手動" };

// 送れる状態か（設定済み・締切前）を覚えておく
let remindAvailable = false;

function renderReminders(data) {
  // ---- 送信記録 ----
  els.remindLog.innerHTML = data.reminders.length
    ? data.reminders
        .map(
          (r) =>
            `<li><span>${escapeHtml(formatUpdated(r.sent_at))}</span><span>${
              REMIND_LABELS[r.kind] ?? r.kind
            }</span><span>${r.recipients}人に送信</span></li>`
        )
        .join("")
    : "<li class='hint' style='margin:0'>この月はまだ送っていません</li>";

  // ---- 未提出の人の一覧（チェックを付けて送る） ----
  const submitted = new Set(data.submissions.map((s) => s.staff_id));
  const unsubmitted = data.staff.filter((p) => !submitted.has(p.id));
  remindAvailable = data.period_info.open && data.reminder_ready;

  els.unsubmittedTitle.textContent = `未提出の人（${unsubmitted.length}人）`;
  els.unsubmittedList.innerHTML = "";
  if (unsubmitted.length === 0) {
    els.unsubmittedList.innerHTML = "<li class='hint' style='margin:0'>全員提出済みです</li>";
  }
  for (const person of unsubmitted) {
    const li = document.createElement("li");
    const label = document.createElement("label");
    label.className = "check-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = person.id;
    // LINE連携していない人には送れないので、チェックできないようにする
    box.disabled = !person.linked || !remindAvailable;
    box.addEventListener("change", updateRemindButton);
    const name = document.createElement("span");
    name.textContent = person.name;
    label.append(box, name);
    if (!person.linked) {
      const note = document.createElement("span");
      note.className = "hint";
      note.style.margin = "0";
      note.textContent = "（LINE未連携のため送れません）";
      label.append(note);
    }
    li.append(label);
    els.unsubmittedList.append(li);
  }

  els.checkAll.checked = false;
  els.checkAllLabel.hidden = checkableBoxes().length === 0;
  updateRemindButton();

  if (!data.reminder_ready) {
    setRemindMessage("LINEで送るための設定（LINE_MESSAGING_TOKEN）がまだのため、送信できません", "error");
  } else if (!data.period_info.open) {
    setRemindMessage("この月は締め切り済みです");
  } else {
    setRemindMessage("");
  }
}

// チェックできる（＝送れる）チェックボックス
function checkableBoxes() {
  return [...els.unsubmittedList.querySelectorAll("input[type=checkbox]:not(:disabled)")];
}

// チェックした人数に合わせてボタンの表示を変える
function updateRemindButton() {
  const count = checkableBoxes().filter((b) => b.checked).length;
  els.remindButton.textContent = count ? `選んだ${count}人に送る` : "選んだ人に送る";
  els.remindButton.disabled = !remindAvailable || count === 0;
}

async function onRemindNow() {
  const period = els.periodSelect.value;
  const staffIds = checkableBoxes()
    .filter((b) => b.checked)
    .map((b) => Number(b.value));
  if (staffIds.length === 0) return;
  if (!confirm(`選んだ${staffIds.length}人に、LINEで${formatPeriod(period)}分の提出のお願いを送ります。よろしいですか？`)) {
    return;
  }
  els.remindButton.disabled = true;
  try {
    const res = await api("/api/admin/remind", {
      method: "POST",
      body: { period, staff_ids: staffIds },
      key: adminKey,
    });
    await load();
    setRemindMessage(`${res.recipients}人に送りました`, "success");
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setRemindMessage(err.message, "error");
    updateRemindButton();
  }
}

function setRemindMessage(text, type = "") {
  els.remindMessage.textContent = text;
  els.remindMessage.className = "message" + (type ? ` ${type}` : "");
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
    li.dataset.id = person.id;

    // ドラッグするときにつかむところ
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⋮⋮";
    handle.title = "ドラッグして並び替え";
    handle.hidden = typeof Sortable === "undefined"; // 部品が読み込めなかったときは出さない

    // 名前と、どのLINEアカウントと結びついているか
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.textContent = person.name;
    const line = document.createElement("div");
    line.className = "hint";
    line.style.margin = "0";
    line.textContent = person.linked
      ? `LINE連携済み：${person.line_name || "（表示名なし）"}`
      : "LINE未連携";
    info.append(name, line);

    const buttons = document.createElement("div");
    buttons.style.display = "flex";
    buttons.style.gap = "6px";

    // 性別（日ごとの男女の人数に使う。スタッフ側の画面には出ない）
    const gender = document.createElement("select");
    gender.className = "gender-select";
    gender.setAttribute("aria-label", `${person.name} さんの性別`);
    gender.innerHTML =
      '<option value="">性別</option><option value="male">男性</option><option value="female">女性</option>';
    gender.value = person.gender ?? "";
    gender.addEventListener("change", () => onChangeGender(person, gender.value || null));
    buttons.append(gender);

    // レベル（ベテランが少ない日を見つけるため。スタッフ側の画面には出ない）
    const level = document.createElement("select");
    level.className = "gender-select";
    level.setAttribute("aria-label", `${person.name} さんのレベル`);
    level.innerHTML =
      '<option value="">レベル</option><option value="new">新人</option><option value="regular">通常</option><option value="veteran">ベテラン</option>';
    level.value = person.level ?? "";
    level.addEventListener("change", () => onChangeLevel(person, level.value || null));
    buttons.append(level);
    if (person.linked) {
      const unlink = document.createElement("button");
      unlink.type = "button";
      unlink.textContent = "連携を解除";
      unlink.addEventListener("click", () => onUnlinkStaff(person));
      buttons.append(unlink);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "外す";
    remove.addEventListener("click", () => onRemoveStaff(person));
    buttons.append(remove);

    li.append(handle, info, buttons);
    els.staffList.append(li);
  }
  setupSortable();
}

// ---------------------------------------------------------
// ドラッグで並び替える
// ---------------------------------------------------------
let sortable = null;

function setupSortable() {
  if (sortable || typeof Sortable === "undefined") return; // 準備は最初の1回だけ
  sortable = Sortable.create(els.staffList, {
    handle: ".drag-handle", // 「⋮⋮」をつかんだときだけ動かせる（ボタンを押し間違えないように）
    animation: 150,
    forceFallback: true, // パソコンでもスマホでも同じ動き方にする
    onEnd: async (event) => {
      if (event.oldIndex === event.newIndex) return; // 動いていない
      const ids = [...els.staffList.children].map((li) => Number(li.dataset.id));
      try {
        await api("/api/admin/staff/order", { method: "POST", body: { ids }, key: adminKey });
        setStaffMessage("並び順を保存しました", "success");
        await load(); // 一覧表も新しい順番で描き直す
      } catch (err) {
        if (err instanceof AuthError) handleError(err);
        else setStaffMessage(err.message, "error");
        await load(); // 保存できなかったら元の順番に戻す
      }
    },
  });
}

// 性別を保存して、一覧表の人数を数え直す
async function onChangeGender(person, gender) {
  try {
    await api("/api/admin/staff/gender", { method: "POST", body: { id: person.id, gender }, key: adminKey });
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

// レベルを保存して、一覧表を数え直す
async function onChangeLevel(person, level) {
  try {
    await api("/api/admin/staff/level", { method: "POST", body: { id: person.id, level }, key: adminKey });
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

// 間違ったLINEアカウントと結びついたときに解除する
async function onUnlinkStaff(person) {
  if (
    !confirm(
      `${person.name} さんとLINE「${person.line_name || ""}」の連携を解除しますか？（解除すると、もう一度名前を選び直せるようになります）`
    )
  ) {
    return;
  }
  try {
    await api("/api/admin/staff/unlink", { method: "POST", body: { id: person.id }, key: adminKey });
    setStaffMessage(`${person.name} さんの連携を解除しました`, "success");
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
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
