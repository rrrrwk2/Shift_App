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
  printButton: $("print-button"),
  pdfButton: $("pdf-button"),
  printSheet: $("print-sheet"),
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
  noteDialog: $("note-dialog"),
  noteTitle: $("note-title"),
  noteBody: $("note-body"),
  noteClose: $("note-close"),
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
let cutInfo = new Map(); // 削った日の説明（staff_id → 文章。renderGrid で作る）

const keyOf = (staffId, date) => `${staffId}|${date}`;

init();

async function init() {
  els.periodSelect.addEventListener("change", load);
  els.reloadButton.addEventListener("click", load);
  els.generateButton.addEventListener("click", onGenerate);
  els.publishButton.addEventListener("click", onPublish);
  els.printButton.addEventListener("click", onPrint);
  els.pdfButton.addEventListener("click", onDownloadPdf);
  // 表のマスをタップしたとき（マス1つ1つではなく、表全体で受け取る）
  els.grid.addEventListener("click", (e) => {
    const noteButton = e.target.closest("[data-note-staff]");
    if (noteButton) {
      showNote(Number(noteButton.dataset.noteStaff));
      return;
    }
    const cut = e.target.closest("[data-cut-staff]");
    if (cut) {
      showCut(Number(cut.dataset.cutStaff));
      return;
    }
    const cell = e.target.closest("td[data-staff]");
    if (cell) openCell(Number(cell.dataset.staff), cell.dataset.date);
  });
  els.cellSave.addEventListener("click", onSaveCell);
  els.noteClose.addEventListener("click", () => els.noteDialog.close());
  els.cellRemove.addEventListener("click", onRemoveCell);
  els.cellCancel.addEventListener("click", () => els.dialog.close());

  // LINEでログインして、管理者だと確認できたら読み込む（admin-auth.js）
  await adminLogin(async () => {
    // 作成担当の画面は「来月」を最初に選んでおく（11月に開いたら12月）
    const periods = await api("/api/periods");
    fillPeriodSelect(els.periodSelect, { ...periods, initial: periods.next ?? periods.initial });
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

function renderGrid() {
  const { period, staff, rules, prefs, shifts } = state;
  const dates = Array.from({ length: daysInMonth(period) }, (_, i) => toDate(period, i + 1));
  const closed = new Set(dates.filter((d) => isClosedDay(d, rules))); // 定休日
  cutInfo = new Map();

  // 日ごとに、入っている人数を数える（全体・男性・女性・ベテラン）
  // ※ 判定のしくみ（rules.js の judgeDay）は「○と△」の形で受け取るので、△の側は0にしておく
  const zero = () => Object.fromEntries(dates.map((d) => [d, 0]));
  const newCounter = () => ({ all: zero(), male: zero(), female: zero(), veteran: zero() });
  const count = { ok: newCounter(), maybe: newCounter() };

  let body = "<tbody>";
  for (const person of staff) {
    let days = 0;
    let cells = "";
    const okDays = []; // ○を出した日（定休日をのぞく）
    const cutDays = []; // ○なのに入れていない日（＝削った日）
    for (const date of dates) {
      const pref = prefs.get(keyOf(person.id, date));
      const shift = shifts.get(keyOf(person.id, date));
      if (pref?.status === "ok" && !closed.has(date)) {
        okDays.push(date);
        if (!shift) cutDays.push(date);
      }
      const cls = ["cell", pref ? `pref-${pref.status}` : "pref-none"];
      if (closed.has(date)) cls.push("closed");
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
        inner += `<span class="shift-time">${escapeHtml(shortRange(shift.start_time, shift.end_time) || "?-L")}</span>`;
      } else if (pref && !closed.has(date)) {
        // 入れていない日（削った日・△の日）は、希望の時間をグレーで出しておく
        const sub = state.subs.get(person.id);
        const time = shortRange(pref.start_time || sub?.default_start, pref.end_time || sub?.default_end);
        if (time) inner += `<span class="wish-time">${escapeHtml(time)}</span>`;
      }
      cells += `<td class="${cls.join(" ")}" data-staff="${person.id}" data-date="${date}">${inner}</td>`;
    }
    // 備考がある人は、名前の横に「備考」を出す（タップで全文）
    const note = state.subs.get(person.id)?.note;
    const noteBadge = note
      ? ` <button type="button" class="note-badge" data-note-staff="${person.id}" title="${escapeHtml(note)}">備考</button>`
      : "";
    // 削った日数（○を出したのに入れていない日の数）。タップすると日付が出る
    // 1日ずつ「12/5(土) 17-L」のように、希望の時間もつけて並べる
    const sub = state.subs.get(person.id);
    const cutLines = cutDays.map((d) => {
      const p = prefs.get(keyOf(person.id, d));
      return `${formatDate(d)}  ${shortRange(p.start_time || sub?.default_start, p.end_time || sub?.default_end)}`.trim();
    });
    const cutText =
      `○を出した ${okDays.length}日のうち、${cutDays.length}日 入れていない` +
      (cutLines.length ? `\n\n${cutLines.join("\n")}` : "");
    cutInfo.set(person.id, cutText);
    const cutCell = state.subs.has(person.id)
      ? `<td class="cut-count${cutDays.length ? " has-cut" : ""}" data-cut-staff="${person.id}" title="${escapeHtml(
          cutText
        )}">${cutDays.length}</td>`
      : "<td class='cut-count'>-</td>";
    body += `<tr><td class="name">${escapeHtml(person.name)}${noteBadge}</td><td>${GENDER_SHORT[person.gender] ?? "-"}</td><td class="${
      person.level === "veteran" ? "level-veteran" : ""
    }">${LEVEL_SHORT[person.level] ?? "-"}</td><td>${days}</td>${cutCell}${cells}</tr>`;
  }
  body += "</tbody>";

  const judged = Object.fromEntries(dates.map((d) => [d, judgeDay(d, count, rules)]));

  // 見出し
  let head =
    "<thead><tr><th class='name'>名前</th><th>性別</th><th>レベル</th><th>日数</th><th title='○を出したのに入れていない日の数'>削った</th>";
  for (const date of dates) head += dayHeaderCell(date, judged[date]);
  head += "</tr></thead>";

  // 下の合計（行ごとに、その項目の判定で色をつける → 何が原因か分かる）
  const footRow = (label, values, cls, ruleKey) => {
    let row = `<tr class="${cls}"><td class='name'>${label}</td><td colspan='4'></td>`;
    for (const date of dates) {
      const level = judged[date].closed ? "closed" : judged[date].checks[ruleKey] ?? "";
      const target = judged[date].targets[ruleKey];
      const text = values[date] || (target != null ? "0" : "");
      row += `<td class="${level}">${text}${target != null ? `<span class="target">/${target}</span>` : ""}</td>`;
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
  pinLeftColumns();
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
    if (!judged[d].items.length) continue;
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

    // 定休日に入っている（あとから定休日にした日など）
    const onClosed = dates.filter((d) => judged[d].closed && shifts.has(keyOf(person.id, d)));
    if (onClosed.length) {
      lines.push(
        `<li><span class="issue-date">${escapeHtml(person.name)}</span><span class="issue-chip ng">定休日に入っている：${onClosed
          .map(formatDate)
          .join("、")}</span></li>`
      );
    }

    // 週の日数（月曜〜日曜で数える）。1日ずれているだけなら黄色、2日以上なら赤
    const sub = subs.get(person.id);
    if (!sub || (sub.min_days_per_week == null && sub.max_days_per_week == null)) continue;
    const chip = (gap) => (gap === 1 ? "warn" : "ng");
    for (const week of weeksOf(dates)) {
      const n = week.days.filter((d) => shifts.has(keyOf(person.id, d))).length;
      const label = `${formatDate(week.days[0])}〜${formatDate(week.days[week.days.length - 1])}`;
      if (sub.max_days_per_week != null && n > sub.max_days_per_week) {
        lines.push(
          `<li><span class="issue-date">${escapeHtml(person.name)}</span><span class="issue-chip ${chip(
            n - sub.max_days_per_week
          )}">${label} ${n}日（希望は週${sub.max_days_per_week}日まで）</span></li>`
        );
      }
      // 月の始まりと終わりの、途中で切れている週は「少なすぎ」は見ない
      if (week.full && sub.min_days_per_week != null && n < sub.min_days_per_week) {
        lines.push(
          `<li><span class="issue-date">${escapeHtml(person.name)}</span><span class="issue-chip ${chip(
            sub.min_days_per_week - n
          )}">${label} ${n}日（希望は週${sub.min_days_per_week}日以上）</span></li>`
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
// 左の列（名前・性別・レベル・日数・削った）を、横にスクロールしても見えるように固定する
//   列の幅は中身（名前の長さなど）で変わるので、表を作ったあとに幅を測って、
//   それぞれの列の「左からの位置（left）」を決める
//   スマホなど幅が狭い画面では、日付が見えなくなるので名前だけ固定する
// ---------------------------------------------------------
const PINNED_COLUMNS = 5;
const wideScreen = window.matchMedia("(min-width: 700px)");

function pinLeftColumns() {
  const table = els.grid;
  if (!table.tHead) return;
  // いったん全部外す（画面の幅が変わったときに付け直すため）
  for (const cell of table.querySelectorAll(".pinned")) {
    cell.classList.remove("pinned", "pinned-last");
    cell.style.left = "";
  }
  const count = wideScreen.matches ? PINNED_COLUMNS : 1;
  // 1列目の左端からの距離
  const heads = [...table.tHead.rows[0].cells].slice(0, count);
  const origin = heads[0].getBoundingClientRect().left;
  const lefts = heads.map((th) => th.getBoundingClientRect().left - origin);
  for (const row of table.rows) {
    let col = 0; // 何列目か（2列分の幅のマスもあるので数えながら進む）
    let last = null;
    for (const cell of row.cells) {
      if (col >= count) break;
      cell.classList.add("pinned");
      cell.style.left = `${lefts[col]}px`;
      last = cell;
      col += cell.colSpan;
    }
    last?.classList.add("pinned-last"); // 固定した列の右端に線を引く
  }
}

wideScreen.addEventListener("change", pinLeftColumns);
window.addEventListener("resize", () => {
  clearTimeout(pinLeftColumns.timer);
  pinLeftColumns.timer = setTimeout(pinLeftColumns, 200);
});

// ---------------------------------------------------------
// 印刷・PDF（A4横の1枚にシフト表をまとめる）
//   印刷    … 印刷用の表を作ってから、ブラウザの印刷を開く
//   PDF     … 同じ表を画像にして、A4横のPDFファイルにしてダウンロードする
//              （日本語のフォントをPDFに入れると重いので、画像にしてから貼る）
// ---------------------------------------------------------
function onPrint() {
  if (!state) return;
  renderPrintSheet();
  window.print();
}

// PDFを作る部品（html2canvas・jsPDF）は大きいので、ボタンを押したときに初めて読み込む
const PDF_LIBS = ["vendor/html2canvas.min.js", "vendor/jspdf.umd.min.js"];

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error("PDFを作る部品を読み込めませんでした。通信を確認して、もう一度押してください"));
    document.head.append(script);
  });
}

async function onDownloadPdf() {
  if (!state) return;
  const label = els.pdfButton.textContent;
  els.pdfButton.disabled = true;
  els.pdfButton.textContent = "PDFを作成中…";
  setMessage("");
  try {
    for (const src of PDF_LIBS) {
      if (!document.querySelector(`script[src="${src}"]`)) await loadScript(src);
    }
    renderPrintSheet();

    // 表を画像にする（画面には出さず、裏でコピーした画面の中でだけ表を出して撮る）
    const canvas = await window.html2canvas(els.printSheet, {
      scale: 3, // 印刷してもにじまないように、細かめに撮る
      backgroundColor: "#ffffff",
      onclone: (doc) => doc.getElementById("print-sheet").classList.add("capturing"),
    });

    // A4横（297×210mm）。余白8mmの中に、縦横の比を変えずに収める
    const pdf = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
    const margin = 8;
    const maxW = 297 - margin * 2;
    const maxH = 210 - margin * 2;
    const ratio = Math.min(maxW / canvas.width, maxH / canvas.height);
    // "FAST" … 画像を圧縮して入れる（入れないと16MBくらいの大きいファイルになる）
    pdf.addImage(canvas, "PNG", margin, margin, canvas.width * ratio, canvas.height * ratio, undefined, "FAST");
    pdf.save(`シフト表_${formatPeriod(state.period)}.pdf`);
  } catch (err) {
    setMessage(err.message || "PDFを作れませんでした", "error");
  } finally {
    els.pdfButton.disabled = false;
    els.pdfButton.textContent = label;
  }
}

function renderPrintSheet() {
  const { period, staff, rules, shifts, schedule } = state;
  const dates = Array.from({ length: daysInMonth(period) }, (_, i) => toDate(period, i + 1));
  const closed = new Set(dates.filter((d) => isClosedDay(d, rules)));

  // 公開した内容と同じかどうか
  let status = "下書き（まだ公開していません）";
  if (schedule.published_at) {
    status = schedule.changed_since_publish
      ? "下書き（公開したあとに変更あり）"
      : `公開済み（${formatUpdated(schedule.published_at)}）`;
  }
  const now = new Date();
  const printed = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;

  // 見出し：日付と曜日（土曜は青、日曜・祝日は赤、定休日はグレー）
  let head = "<thead><tr><th class='p-name'>名前</th>";
  for (const date of dates) {
    const wd = weekdayOf(date);
    const holiday = isHoliday(date);
    const cls = [closed.has(date) ? "p-closed" : "", wd === 0 || holiday ? "p-sun" : wd === 6 ? "p-sat" : ""].join(" ");
    head += `<th class="${cls}">${Number(date.slice(-2))}<br>${closed.has(date) ? "休" : holiday ? "祝" : WEEKDAYS[wd]}</th>`;
  }
  head += "<th class='p-total'>日数</th></tr></thead>";

  // 1人1行：入っている日は「17」「〜L」のように時間を2段で書く
  const perDay = Object.fromEntries(dates.map((d) => [d, 0]));
  let body = "<tbody>";
  for (const person of staff) {
    let days = 0;
    let cells = "";
    for (const date of dates) {
      const shift = shifts.get(keyOf(person.id, date));
      if (!shift) {
        cells += `<td class="${closed.has(date) ? "p-closed" : ""}"></td>`;
        continue;
      }
      days++;
      perDay[date]++;
      const start = shortTime(shift.start_time) || "?";
      const end = shift.end_time ? shortTime(shift.end_time) : "L";
      cells += `<td class="p-on"><span class="p-start">${escapeHtml(start)}</span><span class="p-end">〜${escapeHtml(
        end
      )}</span></td>`;
    }
    body += `<tr><td class="p-name">${escapeHtml(person.name)}</td>${cells}<td class="p-total">${days}</td></tr>`;
  }
  body += "</tbody>";

  // いちばん下：その日に入る人数
  let foot = "<tfoot><tr><td class='p-name'>人数</td>";
  for (const date of dates) foot += `<td class="${closed.has(date) ? "p-closed" : ""}">${perDay[date] || ""}</td>`;
  foot += "<td class='p-total'></td></tr></tfoot>";

  els.printSheet.innerHTML = `
    <div class="p-header">
      <h1>${escapeHtml(formatPeriod(period))} シフト表</h1>
      <div class="p-meta">${escapeHtml(status)}　印刷：${printed}</div>
    </div>
    <table class="p-table">${head}${body}${foot}</table>
    <p class="p-note">時間は「開始〜終わり」。L＝ラストまで。</p>`;
}

// 削った日（○なのに入れていない日）を表示する（備考と同じ小さい画面を使う）
function showCut(staffId) {
  const person = state.staff.find((p) => p.id === staffId);
  els.noteTitle.textContent = `${person.name} さんの削った日`;
  els.noteBody.textContent = cutInfo.get(staffId) ?? "";
  els.noteDialog.showModal();
}

// 備考の全文を表示する
function showNote(staffId) {
  const person = state.staff.find((p) => p.id === staffId);
  els.noteTitle.textContent = `${person.name} さんの備考`;
  els.noteBody.textContent = state.subs.get(staffId)?.note ?? "";
  els.noteDialog.showModal();
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

  // 定休日は入れられない（あとから定休日にした日に残っている分は「外す」だけできる）
  const closedDay = isClosedDay(date, state.rules);
  els.cellSave.hidden = closedDay;
  if (closedDay) els.cellMessage.textContent = "この日は定休日です。";
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
