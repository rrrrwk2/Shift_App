// =========================================================
// 作成担当用の一覧画面の動き
// =========================================================

const $ = (id) => document.getElementById(id);
const els = {
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
  ruleCapacity: $("rule-capacity"),
  ruleVeteran: $("rule-veteran"),
  ruleMale: $("rule-male"),
  ruleFemale: $("rule-female"),
  ruleClosed: $("rule-closed"),
  rulesSave: $("rules-save"),
  rulesMessage: $("rules-message"),
  issuesCard: $("issues-card"),
  issuesTitle: $("issues-title"),
  issuesList: $("issues-list"),
  adminList: $("admin-list"),
  adminInvite: $("admin-invite"),
  adminMessage: $("admin-message"),
  codeDialog: $("code-dialog"),
  codeTitle: $("code-title"),
  codeValue: $("code-value"),
  codeMessage: $("code-message"),
  codeCopy: $("code-copy"),
  codeCopyResult: $("code-copy-result"),
  codeClose: $("code-close"),
};

init();

async function init() {
  els.periodSelect.addEventListener("change", load);
  els.reloadButton.addEventListener("click", load);
  els.staffAdd.addEventListener("click", onAddStaff);
  els.remindButton.addEventListener("click", onRemindNow);
  els.rulesSave.addEventListener("click", onSaveRules);
  els.adminInvite.addEventListener("click", onInviteAdmin);
  els.codeCopy.addEventListener("click", copyCodeMessage);
  els.codeClose.addEventListener("click", () => els.codeDialog.close());
  els.checkAll.addEventListener("change", () => {
    for (const box of checkableBoxes()) box.checked = els.checkAll.checked;
    updateRemindButton();
  });
  els.staffName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onAddStaff();
  });

  // LINEでログインして、管理者だと確認できたら読み込む（admin-auth.js）
  await adminLogin(async () => {
    fillPeriodSelect(els.periodSelect, await api("/api/periods"));
    await load();
  });
}

function handleError(err) {
  if (err instanceof AuthError || err.status === 403) {
    handleAuthError(err); // 本人確認が切れた・管理者でなくなった（admin-auth.js）
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
    const data = await adminApi(`/api/admin/submissions?period=${period}`);
    renderGrid(period, data.staff, data.submissions, data.period_info, data.rules);
    renderRulesForm(data.rules);
    renderRequests(data.change_requests);
    renderReminders(data);
    renderStaffList(data.staff);
    renderAdmins((await adminApi("/api/admin/admins")).admins);
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

  // ---- 見出し（調整が必要な日は色をつける。祝日は「祝」と表示） ----
  let head =
    "<thead><tr><th class='name'>名前</th><th>性別</th><th>レベル</th><th>週の希望</th><th>基本の時間</th>";
  for (const date of dates) {
    const wd = weekdayOf(date);
    const holiday = isHoliday(date);
    const dayCls = wd === 0 || holiday ? "sun" : wd === 6 ? "sat" : "";
    const title = judged[date].items.map((i) => i.text).join("、");
    head += `<th class="${dayCls} ${judged[date].level}" title="${escapeHtml(title)}">${Number(
      date.slice(-2)
    )}<br>${holiday ? "祝" : WEEKDAYS[wd]}</th>`;
  }
  head += "<th>備考</th><th>更新</th></tr></thead>";

  // ---- 合計（日ごとの人数） ----
  //   ruleKey を渡した行は、その項目（定員・男性・女性・ベテラン）の判定で色をつける
  //   → どの行が色付きかを見れば、何が原因かが分かる
  const footRow = (label, values, cls = "", ruleKey = null) => {
    let row = `<tr class="${cls}"><td class='name'>${label}</td><td colspan='4'></td>`;
    for (const date of dates) {
      const item = ruleKey ? judged[date].items.find((i) => i.key === ruleKey) : null;
      const target = ruleKey ? judged[date].targets[ruleKey] : null;
      const text = values[date] || (target != null ? "0" : "");
      row += `<td class="${item?.level ?? ""}">${text}${
        target != null ? `<span class="target">/${target}</span>` : ""
      }</td>`;
    }
    return row + "<td colspan='2'></td></tr>";
  };
  let foot = "<tfoot>";
  foot += footRow("○の人数（定員）", count.ok.all, "", "capacity");
  foot += footRow("　うち男性", count.ok.male, "sub-count", "male");
  foot += footRow("　うち女性", count.ok.female, "sub-count", "female");
  foot += footRow("　うちベテラン", count.ok.veteran, "sub-count", "veteran");
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

// 調整が必要な日を、原因ごとに色のついたラベルで一覧にする（スマホでも分かるように）
function renderIssues(dates, judged) {
  const bad = dates.filter((d) => judged[d].level);
  els.issuesCard.hidden = bad.length === 0;
  els.issuesTitle.textContent = `調整が必要な日（${bad.length}日）`;
  els.issuesList.innerHTML = bad
    .map(
      (d) =>
        `<li><span class="issue-date">${formatDate(d)}${isHoliday(d) ? "祝" : ""}</span>${judged[d].items
          .map((i) => `<span class="issue-chip ${i.level}">${escapeHtml(i.text)}</span>`)
          .join("")}</li>`
    )
    .join("");
}

// ---------------------------------------------------------
// ルールの設定欄
// ---------------------------------------------------------
let currentRules = null;

// 定員の入力欄：月〜日・祝の順に並べる
const CAPACITY_FIELDS = [
  ["1", "月"], ["2", "火"], ["3", "水"], ["4", "木"], ["5", "金"], ["6", "土"], ["0", "日"], ["holiday", "祝"],
];

function renderRulesForm(rules) {
  currentRules = rules;
  els.ruleCapacity.innerHTML = CAPACITY_FIELDS.map(
    ([key, label]) =>
      `<label class="${key === "0" || key === "holiday" ? "sun" : key === "6" ? "sat" : ""}">${label}<input type="number" min="0" max="99" inputmode="numeric" data-key="${key}" value="${
        rules.capacity?.[key] ?? ""
      }" />人</label>`
  ).join("");
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
  const capacity = Object.fromEntries(
    [...els.ruleCapacity.querySelectorAll("input")].map((input) => [input.dataset.key, num(input)])
  );
  const body = {
    capacity,
    min_veteran: num(els.ruleVeteran),
    min_male: num(els.ruleMale),
    min_female: num(els.ruleFemale),
    closed_weekdays: [...els.ruleClosed.querySelectorAll("input:checked")].map((b) => Number(b.value)),
  };
  els.rulesSave.disabled = true;
  try {
    await adminApi("/api/admin/rules", { method: "POST", body });
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
    const res = await adminApi("/api/admin/remind", {
      method: "POST",
      body: { period, staff_ids: staffIds },
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
    await adminApi("/api/admin/change-request/status", {
      method: "POST",
      body: { id, status },
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
    if (person.linked) {
      line.textContent = `LINE連携済み：${person.line_name || "（表示名なし）"}`;
    } else if (person.invite_expires_at) {
      line.textContent = `招待中（${formatUpdated(person.invite_expires_at)}まで有効）`;
    } else {
      line.textContent = "LINE未連携";
    }
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
    } else {
      // まだLINE連携していない人には、招待コードを発行して本人に渡す
      const invite = document.createElement("button");
      invite.type = "button";
      invite.textContent = person.invite_expires_at ? "招待コードを再発行" : "招待コード";
      invite.addEventListener("click", () => onInviteStaff(person));
      buttons.append(invite);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "外す";
    remove.addEventListener("click", () => onRemoveStaff(person));
    buttons.append(remove);
    const erase = document.createElement("button");
    erase.type = "button";
    erase.className = "danger-outline";
    erase.textContent = "完全に削除";
    erase.addEventListener("click", () => onDeleteStaff(person));
    buttons.append(erase);

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
        await adminApi("/api/admin/staff/order", { method: "POST", body: { ids } });
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
    await adminApi("/api/admin/staff/gender", { method: "POST", body: { id: person.id, gender } });
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

// レベルを保存して、一覧表を数え直す
async function onChangeLevel(person, level) {
  try {
    await adminApi("/api/admin/staff/level", { method: "POST", body: { id: person.id, level } });
    await load();
  } catch (err) {
    if (err instanceof AuthError) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

// ---------------------------------------------------------
// 招待コード（スタッフ用・管理者用）
//   コードはこの画面で1回だけ表示する（サーバーには元に戻せない形でしか保存していない）
// ---------------------------------------------------------
async function onInviteStaff(person) {
  try {
    const res = await adminApi("/api/admin/staff/invite", { method: "POST", body: { id: person.id } });
    showCode(
      `${person.name} さんの招待コード`,
      res.code,
      `シフト提出の招待コードです。\n${res.code}\n公式アカウントのメニューから「シフト提出」を開いて、このコードを入れてください（${res.days}日間有効・1回だけ使えます）。\nこのコードは他の人に見せないでください。`
    );
    await load();
  } catch (err) {
    if (err instanceof AuthError || err.status === 403) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

async function onInviteAdmin() {
  if (!confirm("管理者の招待コードを発行します。このコードを使った人は、全員の希望やシフトを見られる管理者になります。よろしいですか？")) {
    return;
  }
  try {
    const res = await adminApi("/api/admin/admins/invite", { method: "POST" });
    showCode(
      "管理者の招待コード",
      res.code,
      `シフトアプリの管理者の招待コードです。\n${res.code}\n${location.origin}/admin を開いてLINEでログインし、このコードを入れてください（${res.hours}時間有効・1回だけ使えます）。\nこのコードは他の人に見せないでください。`
    );
  } catch (err) {
    if (err instanceof AuthError || err.status === 403) handleError(err);
    else setAdminMessage(err.message, "error");
  }
}

function showCode(title, code, message) {
  els.codeTitle.textContent = title;
  els.codeValue.textContent = code;
  els.codeMessage.value = message;
  els.codeCopyResult.textContent = "";
  els.codeDialog.showModal();
}

async function copyCodeMessage() {
  try {
    await navigator.clipboard.writeText(els.codeMessage.value);
    els.codeCopyResult.textContent = "コピーしました。本人にだけ、個別のトークで送ってください。";
  } catch {
    els.codeMessage.select(); // コピーできない環境では、文字を選んだ状態にする
    els.codeCopyResult.textContent = "コピーできなかったので、選んだ状態にしました。長押しでコピーしてください。";
  }
}

// 1人分のデータを完全に削除する（名前をもう一度入力して確認）
async function onDeleteStaff(person) {
  const typed = prompt(
    `${person.name} さんの名前・希望・シフト・申請をすべて削除します。元に戻せません。\n本当に削除する場合は、名前「${person.name}」を入力してください。`
  );
  if (typed === null) return;
  if (typed.trim() !== person.name) {
    setStaffMessage("名前が一致しなかったので、削除しませんでした", "error");
    return;
  }
  try {
    await adminApi("/api/admin/staff/delete", { method: "POST", body: { id: person.id } });
    setStaffMessage(`${person.name} さんのデータを削除しました`, "success");
    await load();
  } catch (err) {
    if (err instanceof AuthError || err.status === 403) handleError(err);
    else setStaffMessage(err.message, "error");
  }
}

// ---------------------------------------------------------
// 管理者の一覧
// ---------------------------------------------------------
function renderAdmins(admins) {
  els.adminList.innerHTML = "";
  for (const a of admins) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.innerHTML = `<div>${escapeHtml(a.name)}${a.is_me ? "（あなた）" : ""}</div><div class="hint" style="margin:0">${escapeHtml(
      formatUpdated(a.added_at)
    )} に登録</div>`;
    li.append(info);
    if (!a.is_me) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "管理者から外す";
      remove.addEventListener("click", () => onRemoveAdmin(a));
      li.append(remove);
    }
    els.adminList.append(li);
  }
}

async function onRemoveAdmin(a) {
  if (!confirm(`${a.name} さんを管理者から外しますか？（この画面に入れなくなります）`)) return;
  try {
    await adminApi("/api/admin/admins/remove", { method: "POST", body: { line_user_id: a.line_user_id } });
    setAdminMessage(`${a.name} さんを管理者から外しました`, "success");
    await load();
  } catch (err) {
    if (err instanceof AuthError || err.status === 403) handleError(err);
    else setAdminMessage(err.message, "error");
  }
}

function setAdminMessage(text, type = "") {
  els.adminMessage.textContent = text;
  els.adminMessage.className = "message" + (type ? ` ${type}` : "");
}

// 間違ったLINEアカウントと結びついたときに解除する
async function onUnlinkStaff(person) {
  if (
    !confirm(
      `${person.name} さんとLINE「${person.line_name || ""}」の連携を解除しますか？（解除したら、新しい招待コードを発行して本人に渡してください）`
    )
  ) {
    return;
  }
  try {
    await adminApi("/api/admin/staff/unlink", { method: "POST", body: { id: person.id } });
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
    await adminApi("/api/admin/staff", { method: "POST", body: { name } });
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
    await adminApi("/api/admin/staff/deactivate", {
      method: "POST",
      body: { id: person.id },
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
