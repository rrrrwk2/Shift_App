// =========================================================
// A4横のPDFを作る（シフト作成画面・希望の一覧で使う）
//
// しくみ：A4横の表（.print-sheet）を html2canvas で画像にして、jsPDF でPDFに貼る。
//         日本語のフォントをPDFに入れると重いので、画像にしてから貼っている。
// =========================================================

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

// sheet（.print-sheet の要素。中身は作っておく）を、A4横1枚のPDFにしてダウンロードする
async function downloadSheetPdf(sheet, fileName) {
  for (const src of PDF_LIBS) {
    if (!document.querySelector(`script[src="${src}"]`)) await loadScript(src);
  }

  // 表を画像にする（画面には出さず、裏でコピーした画面の中でだけ表を出して撮る）
  const canvas = await window.html2canvas(sheet, {
    scale: 3, // 印刷してもにじまないように、細かめに撮る
    backgroundColor: "#ffffff",
    onclone: (doc) => doc.getElementById(sheet.id).classList.add("capturing"),
  });

  // A4横（297×210mm）。余白8mmの中に、縦横の比を変えずに収める
  const pdf = new window.jspdf.jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const margin = 8;
  const ratio = Math.min((297 - margin * 2) / canvas.width, (210 - margin * 2) / canvas.height);
  // "FAST" … 画像を圧縮して入れる（入れないと16MBくらいの大きいファイルになる）
  pdf.addImage(canvas, "PNG", margin, margin, canvas.width * ratio, canvas.height * ratio, undefined, "FAST");
  pdf.save(fileName);
}

// ボタンを押している間は「作成中…」にして、二度押しできないようにする
//   onError: うまくいかなかったときに、メッセージを出す関数
async function withPdfButton(button, work, onError) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "PDFを作成中…";
  try {
    await work();
  } catch (err) {
    onError(err.message || "PDFを作れませんでした");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------------------------------------------------------
// みんなの希望（○△と時間）の表
//   staff: 名簿、subs: staff_id → 提出された希望、rules: 定休日などの設定
//   性別・レベルは入れない（女性の名前だけ赤にする。シフト表と同じ）
// ---------------------------------------------------------
function renderWishSheet(sheet, { period, staff, subs, rules }) {
  const dates = Array.from({ length: daysInMonth(period) }, (_, i) => toDate(period, i + 1));
  const closed = new Set(dates.filter((d) => isClosedDay(d, rules)));
  const now = new Date();
  const printed = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
  const submittedCount = staff.filter((p) => subs.has(p.id)).length;

  // 見出し：日付と曜日（土曜は青、日曜・祝日は赤、定休日はグレー）
  let head = "<thead><tr><th class='p-name'>名前</th>";
  for (const date of dates) {
    const wd = weekdayOf(date);
    const holiday = isHoliday(date);
    const cls = [closed.has(date) ? "p-closed" : "", wd === 0 || holiday ? "p-sun" : wd === 6 ? "p-sat" : ""].join(" ");
    head += `<th class="${cls}">${Number(date.slice(-2))}<br>${closed.has(date) ? "休" : holiday ? "祝" : WEEKDAYS[wd]}</th>`;
  }
  head += "<th class='p-total'>○</th><th class='p-week'>週</th></tr></thead>";

  // 1人1行：○は時間（終わりの時間がある日は下に小さく）、△は黄色のマスで左上に小さく「△」
  const okPerDay = Object.fromEntries(dates.map((d) => [d, 0]));
  const maybePerDay = Object.fromEntries(dates.map((d) => [d, 0]));
  const notes = [];
  let body = "<tbody>";
  for (const person of staff) {
    const sub = subs.get(person.id);
    const nameCls = person.gender === "female" ? "p-name p-female" : "p-name";
    if (!sub) {
      // まだ出していない人
      body += `<tr><td class="${nameCls}">${escapeHtml(person.name)}</td><td class="p-unsubmitted" colspan="${
        dates.length
      }">未提出</td><td class="p-total"></td><td class="p-week"></td></tr>`;
      continue;
    }
    const byDate = new Map(sub.days.map((d) => [d.date, d]));
    let okDays = 0;
    let cells = "";
    for (const date of dates) {
      const d = byDate.get(date);
      if (closed.has(date) || !d) {
        cells += `<td class="${closed.has(date) ? "p-closed" : ""}"></td>`;
        continue;
      }
      const start = shortTime(d.start_time || sub.default_start);
      const endTime = d.end_time || sub.default_end;
      const end = endTime ? `<span class="p-end">〜${escapeHtml(shortTime(endTime))}</span>` : "";
      if (d.status === "ok") {
        okDays++;
        okPerDay[date]++;
        cells += `<td class="p-on"><span class="p-start">${escapeHtml(start || "○")}</span>${end}</td>`;
      } else {
        maybePerDay[date]++;
        // △は左上に小さく。時間は○と同じように真ん中（時間がなければ「△」だけ）
        cells += start
          ? `<td class="p-maybe"><span class="p-mark">△</span><span class="p-start">${escapeHtml(start)}</span>${end}</td>`
          : `<td class="p-maybe"><span class="p-start">△</span></td>`;
      }
    }
    // 週に入りたい日数（「2〜3」「3〜」「〜2」）
    const min = sub.min_days_per_week;
    const max = sub.max_days_per_week;
    const week = min == null && max == null ? "" : min === max ? `${min}` : `${min ?? ""}〜${max ?? ""}`;
    body += `<tr><td class="${nameCls}">${escapeHtml(person.name)}</td>${cells}<td class="p-total">${okDays}</td><td class="p-week">${escapeHtml(
      week
    )}</td></tr>`;
    if (sub.note) notes.push({ name: person.name, note: sub.note });
  }
  body += "</tbody>";

  // いちばん下：その日に○の人数・△の人数
  const footRow = (label, perDay) =>
    `<tr><td class="p-name">${label}</td>${dates
      .map((d) => `<td class="${closed.has(d) ? "p-closed" : ""}">${closed.has(d) ? "" : perDay[d] || ""}</td>`)
      .join("")}<td class="p-total"></td><td class="p-week"></td></tr>`;
  const foot = `<tfoot>${footRow("○の人数", okPerDay)}${footRow("△の人数", maybePerDay)}</tfoot>`;

  // 備考（1人1行。長い分は省略）
  const noteList = notes.length
    ? `<ul class="p-notes">${notes
        .map((n) => `<li><strong>${escapeHtml(n.name)}</strong>：${escapeHtml(n.note.replace(/\s+/g, " "))}</li>`)
        .join("")}</ul>`
    : "";

  sheet.innerHTML = `
    <div class="p-header">
      <h1>${escapeHtml(formatPeriod(period))} シフト希望</h1>
      <div class="p-meta">提出 ${submittedCount}/${staff.length}人　印刷：${printed}</div>
    </div>
    <table class="p-table p-wish">${head}${body}${foot}</table>
    ${noteList}`;
}
