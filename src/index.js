// =========================================================
// Shift_App サーバー側の処理（Cloudflare Worker）
//
// 画面（public フォルダのHTMLなど）はCloudflareがそのまま配信します。
// このファイルが担当するのは「/api/〜」で始まるURLへのリクエストだけで、
// データベース（D1）への保存や読み込みをします。
//
// 本人確認は2種類：
//   スタッフ   … LINEのIDトークン（LINEの中で開くと自動で手に入る）
//   作成担当   … 管理用の合言葉（ADMIN_KEY）
// =========================================================

// 提出の締切日：対象の月の「前の月」のこの日の23:59（日本時間）まで
// 例）12月分の希望 → 11月15日 23:59 まで
const DEADLINE_DAY = 15;

// LINEのIDトークンを確認するためのLINEの窓口
const LINE_VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
// LINEでメッセージを送るための窓口
const LINE_API_BASE = "https://api.line.me";

// 締切の何日前にリマインドを送るか： 日数 → 記録に使う名前
const REMINDER_DAYS = { 3: "3days", 1: "1day" };

export default {
  // 決まった時刻にCloudflareが自動で呼ぶ関数（wrangler.jsonc の triggers で毎日12:00に設定）
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDailyReminder(env, new Date(controller.scheduledTime)));
  },

  // ブラウザからリクエストが来るたびに、この関数が呼ばれる
  async fetch(request, env) {
    const url = new URL(request.url);

    // /api/ 以外（画面のファイル）は、Cloudflareの静的ファイル配信に任せる
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleApi(request, env, url);
    } catch (err) {
      // 想定外のエラー。詳しい内容はログにだけ出して、画面には簡単なメッセージを返す
      console.error(err);
      return json({ error: "サーバーでエラーが起きました" }, 500);
    }
  },
};

// ---------------------------------------------------------
// URLとメソッド（GET/POST）を見て、どの処理をするか振り分ける
// ---------------------------------------------------------
async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ---- 誰でも見られるもの ----
  // 画面がLINEにつなぐための設定（LIFF ID）。秘密情報ではない
  if (path === "/api/config" && method === "GET") {
    return json({ liff_id: env.LIFF_ID || null });
  }
  // 月ごとの締切情報
  if (path === "/api/periods" && method === "GET") return listPeriods();

  // ---- 作成担当（管理者）向け：管理用の合言葉が必要 ----
  if (path.startsWith("/api/admin/")) {
    if (!env.ADMIN_KEY) {
      return json(
        { error: "サーバーに合言葉（ADMIN_KEY）が設定されていません。Cloudflareの設定を確認してください" },
        503
      );
    }
    if (!isAdminKey(request, env)) return json({ error: "合言葉が違います" }, 401);

    if (path === "/api/admin/check" && method === "GET") return json({ ok: true });
    if (path === "/api/admin/submissions" && method === "GET") return listSubmissions(env, url);
    if (path === "/api/admin/staff" && method === "POST") {
      return addStaff(env, await readJson(request));
    }
    if (path === "/api/admin/staff/deactivate" && method === "POST") {
      return deactivateStaff(env, await readJson(request));
    }
    if (path === "/api/admin/staff/level" && method === "POST") {
      return setStaffLevel(env, await readJson(request));
    }
    if (path === "/api/admin/rules" && method === "POST") {
      return saveRules(env, await readJson(request));
    }
    if (path === "/api/admin/staff/gender" && method === "POST") {
      return setStaffGender(env, await readJson(request));
    }
    if (path === "/api/admin/staff/order" && method === "POST") {
      return saveStaffOrder(env, await readJson(request));
    }
    if (path === "/api/admin/staff/unlink" && method === "POST") {
      return unlinkStaff(env, await readJson(request));
    }
    if (path === "/api/admin/change-request/status" && method === "POST") {
      return setChangeRequestStatus(env, await readJson(request));
    }
    if (path === "/api/admin/remind" && method === "POST") {
      return sendManualReminder(env, await readJson(request));
    }
    return json({ error: "見つかりません" }, 404);
  }

  // ---- スタッフ向け：LINEでの本人確認が必要 ----
  if (!env.LINE_CHANNEL_ID) {
    return json({ error: "LINE連携の設定（LINE_CHANNEL_ID）がまだです" }, 503);
  }
  const lineUser = await verifyLineUser(request, env);
  if (!lineUser) {
    return json(
      { error: "LINEでの本人確認ができませんでした。LINEから開き直してください", code: "line_auth" },
      401
    );
  }

  // 自分の情報（名前と結びついているか）
  if (path === "/api/me" && method === "GET") return getMe(env, lineUser);
  if (path === "/api/me/link" && method === "POST") {
    return linkMe(env, lineUser, await readJson(request));
  }

  // ここから先は、名前と結びついている人だけ
  const me = await staffOfLineUser(env, lineUser.sub);
  if (!me) return json({ error: "まだ名前が登録されていません", code: "not_linked" }, 403);

  if (path === "/api/submission" && method === "GET") return getSubmission(env, url, me);
  if (path === "/api/submission" && method === "POST") {
    return saveSubmission(env, me, await readJson(request));
  }
  if (path === "/api/change-request" && method === "POST") {
    return addChangeRequest(env, me, await readJson(request));
  }

  return json({ error: "見つかりません" }, 404);
}

// =========================================================
// 本人確認
// =========================================================

// 画面から送られてきたLINEのIDトークンを、LINEに問い合わせて本物か確かめる。
// 本物なら { sub: LINEのユーザーID, name: LINEの表示名 } を返す
async function verifyLineUser(request, env) {
  const auth = request.headers.get("Authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/);
  if (!match) return null;

  const res = await fetch(env.LINE_VERIFY_URL || LINE_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: match[1], client_id: env.LINE_CHANNEL_ID }),
  });
  if (!res.ok) return null; // 偽物・期限切れ・別のアプリ向けのトークンなど

  const data = await res.json();
  // 念のため「このアプリ向けに発行されたトークンか」も確認する
  if (!data.sub || String(data.aud) !== String(env.LINE_CHANNEL_ID)) return null;
  return { sub: data.sub, name: data.name ?? "" };
}

// 管理用の合言葉が合っているか
function isAdminKey(request, env) {
  const given = request.headers.get("X-Access-Key") ?? "";
  return Boolean(given) && safeEqual(given, env.ADMIN_KEY);
}

// 文字列を比べる（かかる時間から合言葉を推測されないようにする比べ方）
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// =========================================================
// LINEアカウントと名前の結びつけ
// =========================================================

async function staffOfLineUser(env, lineUserId) {
  return env.DB.prepare("SELECT id, name FROM staff WHERE line_user_id = ? AND active = 1")
    .bind(lineUserId)
    .first();
}

// 自分がどの名前と結びついているか。まだなら、選べる名前の一覧も返す
async function getMe(env, lineUser) {
  const me = await staffOfLineUser(env, lineUser.sub);
  if (me) return json({ linked: true, staff: me, line_name: lineUser.name });

  const { results } = await env.DB.prepare(
    "SELECT id, name FROM staff WHERE active = 1 AND line_user_id IS NULL ORDER BY sort_order, id"
  ).all();
  return json({ linked: false, candidates: results, line_name: lineUser.name });
}

// 名前を選んで、自分のLINEアカウントと結びつける（最初の1回だけ）
async function linkMe(env, lineUser, body) {
  const staffId = body?.staff_id;
  if (!Number.isInteger(staffId)) return json({ error: "名前を選んでください" }, 400);

  if (await staffOfLineUser(env, lineUser.sub)) {
    return json({ error: "このLINEアカウントは、すでに名前が登録されています" }, 409);
  }

  // まだ誰とも結びついていない名前のときだけ結びつける
  // （「line_user_id IS NULL」の条件で、早い者勝ちの取り合いも防ぐ）
  const result = await env.DB.prepare(
    `UPDATE staff SET line_user_id = ?, line_name = ?
      WHERE id = ? AND active = 1 AND line_user_id IS NULL`
  )
    .bind(lineUser.sub, lineUser.name || null, staffId)
    .run();

  if (result.meta.changes !== 1) {
    return json(
      { error: "その名前はすでに別のLINEアカウントで登録されています。作成担当に連絡してください" },
      409
    );
  }
  return json({ ok: true });
}

// 管理者用：結びつけを解除する（間違えて登録したとき用）
async function unlinkStaff(env, body) {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  await env.DB.prepare("UPDATE staff SET line_user_id = NULL, line_name = NULL WHERE id = ?")
    .bind(id)
    .run();
  return json({ ok: true });
}

// =========================================================
// 締切
// =========================================================

// その月の分の締切の瞬間を返す（例: "2026-12" → 2026-11-15 23:59:59 日本時間）
function deadlineOf(period) {
  const [y, m] = period.split("-").map(Number);
  // 日本時間の23:59:59は、世界標準時（UTC）だと14:59:59
  // Date.UTC の月は0始まりなので、「前の月」は m - 2 になる（1月分なら前年の12月になる）
  return new Date(Date.UTC(y, m - 2, DEADLINE_DAY, 14, 59, 59));
}

// 締切を過ぎているか
function isClosed(period) {
  return Date.now() > deadlineOf(period).getTime();
}

// 締切を「11月15日 23:59」の形にする
function deadlineText(period) {
  const jst = new Date(deadlineOf(period).getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 23:59`;
}

// 1か月分の締切情報をまとめる
function periodInfo(period) {
  return { period, deadline: deadlineText(period), open: !isClosed(period) };
}

// 選べる月（今月・来月・再来月）と、最初に選んでおく月を返す
function listPeriods() {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const periods = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    periods.push(periodInfo(period));
  }
  // 最初に選んでおくのは「まだ締切前の一番近い月」
  const initial = (periods.find((p) => p.open) ?? periods[periods.length - 1]).period;
  return json({ periods, initial });
}

// =========================================================
// スタッフ（作成担当が管理する名簿）
// =========================================================

// スタッフを追加する
async function addStaff(env, body) {
  const name = String(body?.name ?? "").trim();
  if (name.length < 1 || name.length > 30) {
    return json({ error: "名前は1〜30文字で入力してください" }, 400);
  }
  // 新しく追加した人は、並び順の一番下にする
  const row = await env.DB.prepare(
    `INSERT INTO staff (name, sort_order)
     VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM staff))
     RETURNING id, name`
  )
    .bind(name)
    .first();
  return json({ staff: row });
}

// 性別を設定する（作成担当だけ。日ごとの男女の人数を数えるため）
async function setStaffGender(env, body) {
  const id = Number(body?.id);
  const gender = body?.gender ?? null;
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  if (gender !== null && gender !== "male" && gender !== "female") {
    return json({ error: "性別の値が正しくありません" }, 400);
  }
  await env.DB.prepare("UPDATE staff SET gender = ? WHERE id = ?").bind(gender, id).run();
  return json({ ok: true });
}

// レベルを設定する（作成担当だけ。ベテランが少ない日を見つけるため）
async function setStaffLevel(env, body) {
  const id = Number(body?.id);
  const level = body?.level ?? null;
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  if (level !== null && !["new", "regular", "veteran"].includes(level)) {
    return json({ error: "レベルの値が正しくありません" }, 400);
  }
  await env.DB.prepare("UPDATE staff SET level = ? WHERE id = ?").bind(level, id).run();
  return json({ ok: true });
}

// 毎日のルール（何人以上必要か）。null の項目はチェックしない
const DEFAULT_RULES = {
  min_total: null, // ○の合計
  min_veteran: null, // そのうちベテラン
  min_male: null, // そのうち男性
  min_female: null, // そのうち女性
  closed_weekdays: [], // チェックしない曜日（0=日曜 〜 6=土曜）。定休日など
};

async function saveRules(env, body) {
  const rules = {};
  for (const key of ["min_total", "min_veteran", "min_male", "min_female"]) {
    const v = body?.[key];
    if (v === null || v === undefined || v === "") {
      rules[key] = null;
    } else if (Number.isInteger(v) && v >= 0 && v <= 99) {
      rules[key] = v;
    } else {
      return json({ error: "人数は0〜99で入力してください" }, 400);
    }
  }
  const closed = body?.closed_weekdays ?? [];
  if (!Array.isArray(closed) || !closed.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return json({ error: "曜日の指定が正しくありません" }, 400);
  }
  rules.closed_weekdays = [...new Set(closed)].sort();

  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('daily_rules', ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  )
    .bind(JSON.stringify(rules))
    .run();
  return json({ ok: true, rules });
}

// 並び順を保存する（ids に上から順番に並べたスタッフのidが入ってくる）
async function saveStaffOrder(env, body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500 || !ids.every(Number.isInteger)) {
    return json({ error: "並び順が正しくありません" }, 400);
  }
  if (new Set(ids).size !== ids.length) return json({ error: "同じ人が重複しています" }, 400);

  // 上から 1, 2, 3, … と番号をふり直す（全部まとめて保存）
  await env.DB.batch(
    ids.map((id, i) => env.DB.prepare("UPDATE staff SET sort_order = ? WHERE id = ?").bind(i + 1, id))
  );
  return json({ ok: true });
}

// スタッフを一覧から外す（提出データは残す。LINEとの結びつけは外す）
async function deactivateStaff(env, body) {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  await env.DB.prepare(
    "UPDATE staff SET active = 0, line_user_id = NULL, line_name = NULL WHERE id = ?"
  )
    .bind(id)
    .run();
  return json({ ok: true });
}

// =========================================================
// シフト希望
// =========================================================

// 自分の1か月分の提出内容と、締切の情報、自分の変更申請を返す
async function getSubmission(env, url, me) {
  const period = url.searchParams.get("period") ?? "";
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const [subRes, reqRes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM submissions WHERE staff_id = ? AND period = ?").bind(
      me.id,
      period
    ),
    env.DB.prepare(
      `SELECT id, message, status, created_at FROM change_requests
        WHERE staff_id = ? AND period = ? ORDER BY id DESC`
    ).bind(me.id, period),
  ]);

  let submission = subRes.results[0] ?? null;
  if (submission) {
    const { results: days } = await env.DB.prepare(
      "SELECT date, status, start_time, end_time FROM availability WHERE submission_id = ? ORDER BY date"
    )
      .bind(submission.id)
      .all();
    submission = { ...submission, days };
  }

  return json({
    submission,
    change_requests: reqRes.results,
    period_info: periodInfo(period),
    can_edit: !isClosed(period),
  });
}

// 自分の提出内容を保存する（同じ月の提出があれば上書き）
async function saveSubmission(env, me, body) {
  // 誰の分かは、送られてきた値ではなくLINEの本人確認の結果で決める（なりすまし防止）
  if (body && typeof body === "object") body.staff_id = me.id;

  // ---- 1. 送られてきた内容をチェックする ----
  const problem = validateSubmission(body);
  if (problem) return json({ error: problem }, 400);

  // 締切を過ぎていたら受け付けない
  if (isClosed(body.period)) {
    return json(
      {
        error: `${formatPeriodJa(body.period)}分の提出期限（${deadlineText(body.period)}）を過ぎています。変更は「変更を申請する」から送ってください`,
      },
      403
    );
  }

  // ---- 2. まとめて保存する ----
  // batch() に渡した処理は「全部成功」か「全部やり直し」のどちらかになる（途中で止まらない）
  const findId = "(SELECT id FROM submissions WHERE staff_id = ? AND period = ?)";
  const statements = [
    // 提出の本体：なければ追加、あれば上書き
    env.DB.prepare(
      `INSERT INTO submissions
         (staff_id, period, min_days_per_week, max_days_per_week, default_start, default_end, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (staff_id, period) DO UPDATE SET
         min_days_per_week = excluded.min_days_per_week,
         max_days_per_week = excluded.max_days_per_week,
         default_start     = excluded.default_start,
         default_end       = excluded.default_end,
         note              = excluded.note,
         updated_at        = datetime('now')`
    ).bind(
      me.id,
      body.period,
      body.min_days_per_week ?? null,
      body.max_days_per_week ?? null,
      body.default_start || null,
      body.default_end || null,
      body.note || null
    ),
    // 前回の日ごとの希望をいったん消す
    env.DB.prepare(`DELETE FROM availability WHERE submission_id = ${findId}`).bind(
      me.id,
      body.period
    ),
    // 今回の日ごとの希望を入れ直す
    ...body.days.map((d) =>
      env.DB.prepare(
        `INSERT INTO availability (submission_id, date, status, start_time, end_time)
         VALUES (${findId}, ?, ?, ?, ?)`
      ).bind(me.id, body.period, d.date, d.status, d.start_time || null, d.end_time || null)
    ),
  ];
  await env.DB.batch(statements);

  return json({ ok: true });
}

// 管理者用：1か月分の全員の提出内容と変更申請を返す
async function listSubmissions(env, url) {
  const period = url.searchParams.get("period") ?? "";
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const [staffRes, subRes, dayRes, reqRes, remindRes, rulesRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, name, gender, level, line_name, line_user_id IS NOT NULL AS linked
         FROM staff WHERE active = 1 ORDER BY sort_order, id`
    ),
    env.DB.prepare("SELECT * FROM submissions WHERE period = ?").bind(period),
    env.DB.prepare(
      `SELECT a.submission_id, a.date, a.status, a.start_time, a.end_time
         FROM availability a
         JOIN submissions s ON s.id = a.submission_id
        WHERE s.period = ?
        ORDER BY a.date`
    ).bind(period),
    env.DB.prepare(
      `SELECT r.id, r.staff_id, st.name, r.message, r.status, r.created_at, r.resolved_at
         FROM change_requests r
         JOIN staff st ON st.id = r.staff_id
        WHERE r.period = ?
        ORDER BY r.status = 'done', r.id DESC`
    ).bind(period),
    env.DB.prepare(
      "SELECT kind, recipients, sent_at FROM reminder_log WHERE period = ? ORDER BY id DESC"
    ).bind(period),
    env.DB.prepare("SELECT value FROM settings WHERE key = 'daily_rules'"),
  ]);

  // 提出ごとに日ごとの希望をまとめる
  const submissions = subRes.results.map((s) => ({
    ...s,
    days: dayRes.results.filter((d) => d.submission_id === s.id),
  }));

  return json({
    staff: staffRes.results,
    submissions,
    change_requests: reqRes.results,
    reminders: remindRes.results,
    rules: rulesRes.results[0] ? JSON.parse(rulesRes.results[0].value) : DEFAULT_RULES,
    reminder_ready: Boolean(env.LINE_MESSAGING_TOKEN), // LINEで送る準備ができているか
    period_info: periodInfo(period),
  });
}

// =========================================================
// 提出のお願い（リマインド）をLINEで送る
// =========================================================

// その日にどのリマインドを送るべきかを決める（送らない日は null）
// 例）11月12日 → 12月分の締切（11月15日）の3日前なので { period: "2026-12", daysLeft: 3, kind: "3days" }
export function reminderPlan(now) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const daysLeft = DEADLINE_DAY - jst.getUTCDate();
  const kind = REMINDER_DAYS[daysLeft];
  if (!kind) return null;

  // 今月15日が締切なのは「翌月分」
  const next = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1));
  const period = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  return { period, daysLeft, kind };
}

// 毎日の定期実行で呼ばれる
async function runDailyReminder(env, now) {
  const plan = reminderPlan(now);
  if (!plan) return; // 今日は送る日ではない
  if (!env.LINE_MESSAGING_TOKEN) {
    console.log("LINE_MESSAGING_TOKEN が未設定なので、リマインドを送りませんでした");
    return;
  }

  // 先に記録を入れてみて、もう入っていたら（＝今日すでに送った）何もしない
  const log = await env.DB.prepare(
    `INSERT INTO reminder_log (period, kind) VALUES (?, ?)
     ON CONFLICT DO NOTHING RETURNING id`
  )
    .bind(plan.period, plan.kind)
    .first();
  if (!log) return;

  try {
    const count = await remindUnsubmitted(env, plan.period, plan.daysLeft);
    await env.DB.prepare("UPDATE reminder_log SET recipients = ? WHERE id = ?")
      .bind(count, log.id)
      .run();
  } catch (err) {
    // 送れなかったら記録を消しておく（作成担当が手動で送り直せるように）
    console.error(err);
    await env.DB.prepare("DELETE FROM reminder_log WHERE id = ?").bind(log.id).run();
  }
}

// 管理者用：一覧でチェックを付けた未提出の人にだけ送る
async function sendManualReminder(env, body) {
  const period = body?.period;
  const staffIds = body?.staff_ids;
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);
  if (isClosed(period)) return json({ error: "この月はもう締め切られています" }, 400);
  if (!Array.isArray(staffIds) || staffIds.length === 0 || !staffIds.every(Number.isInteger)) {
    return json({ error: "送る人を選んでください" }, 400);
  }
  if (staffIds.length > 500) return json({ error: "一度に選べるのは500人までです" }, 400);
  if (!env.LINE_MESSAGING_TOKEN) {
    return json({ error: "LINEで送るための設定（LINE_MESSAGING_TOKEN）がまだです" }, 503);
  }

  // 選ばれた人のうち、本当に「在籍中・LINE連携済み・未提出」の人だけに絞る
  const placeholders = staffIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT line_user_id FROM staff
      WHERE id IN (${placeholders})
        AND active = 1 AND line_user_id IS NOT NULL
        AND id NOT IN (SELECT staff_id FROM submissions WHERE period = ?)`
  )
    .bind(...staffIds, period)
    .all();
  const userIds = results.map((r) => r.line_user_id);
  if (userIds.length === 0) {
    return json({ error: "選んだ人はもう提出済みか、LINE連携していません" }, 400);
  }

  const daysLeft = Math.ceil((deadlineOf(period).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  await sendReminderMessage(env, userIds, period, daysLeft);
  await env.DB.prepare("INSERT INTO reminder_log (period, kind, recipients) VALUES (?, 'manual', ?)")
    .bind(period, userIds.length)
    .run();
  return json({ ok: true, recipients: userIds.length });
}

// まだ提出していない人（LINE連携済みの人だけ）全員にお願いを送り、送った人数を返す（自動送信用）
async function remindUnsubmitted(env, period, daysLeft) {
  const { results } = await env.DB.prepare(
    `SELECT line_user_id FROM staff
      WHERE active = 1 AND line_user_id IS NOT NULL
        AND id NOT IN (SELECT staff_id FROM submissions WHERE period = ?)`
  )
    .bind(period)
    .all();
  const userIds = results.map((r) => r.line_user_id);
  if (userIds.length === 0) return 0;
  await sendReminderMessage(env, userIds, period, daysLeft);
  return userIds.length;
}

// 指定したLINEユーザーに提出のお願いを送る
async function sendReminderMessage(env, userIds, period, daysLeft) {
  const [, month] = period.split("-").map(Number);
  const when = daysLeft <= 1 ? "明日" : `あと${daysLeft}日`;
  const text =
    `【シフト提出のお願い】\n` +
    `${month}月分のシフト希望の提出期限は ${deadlineText(period)} です（${when}）。\n` +
    `まだ提出していない人は、メニューの「シフト提出」か、下のリンクから出してください。\n` +
    (env.LIFF_ID ? `https://miniapp.line.me/${env.LIFF_ID}` : "");

  // LINEのマルチキャストは1回に500人まで
  for (let i = 0; i < userIds.length; i += 500) {
    const res = await fetch(`${env.LINE_API_BASE || LINE_API_BASE}/v2/bot/message/multicast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LINE_MESSAGING_TOKEN}`,
        // 通信が途中で切れて送り直したときに、二重に届かないようにするための番号
        "X-Line-Retry-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        to: userIds.slice(i, i + 500),
        messages: [{ type: "text", text: text.trim() }],
      }),
    });
    if (!res.ok) {
      throw new Error(`LINEへの送信に失敗しました（${res.status}）: ${await res.text()}`);
    }
  }
}

// =========================================================
// 変更の申請（締切後に出すもの）
// =========================================================

async function addChangeRequest(env, me, body) {
  const period = body?.period;
  const message = String(body?.message ?? "").trim();

  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);
  if (message.length < 1) return json({ error: "変更したい内容を書いてください" }, 400);
  if (message.length > 500) return json({ error: "申請は500文字以内にしてください" }, 400);

  // いたずらで大量に送られないよう、1人1か月あたりの件数に上限をつける
  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM change_requests WHERE staff_id = ? AND period = ?"
  )
    .bind(me.id, period)
    .first();
  if (count >= 20) {
    return json({ error: "この月の申請が多すぎます。作成担当に直接連絡してください" }, 429);
  }

  await env.DB.prepare("INSERT INTO change_requests (staff_id, period, message) VALUES (?, ?, ?)")
    .bind(me.id, period, message)
    .run();
  return json({ ok: true });
}

// 管理者用：申請を「対応済み」や「未対応」に切り替える
async function setChangeRequestStatus(env, body) {
  const id = Number(body?.id);
  const status = body?.status;
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  if (status !== "open" && status !== "done") return json({ error: "状態が正しくありません" }, 400);

  await env.DB.prepare(
    `UPDATE change_requests
        SET status = ?, resolved_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END
      WHERE id = ?`
  )
    .bind(status, status, id)
    .run();
  return json({ ok: true });
}

// =========================================================
// 入力チェック
// =========================================================

function validateSubmission(b) {
  if (!b || typeof b !== "object") return "送信内容が読み取れません";
  if (!Number.isInteger(b.staff_id)) return "名前が確認できません";
  if (!isPeriod(b.period)) return "月の指定が正しくありません";

  for (const key of ["min_days_per_week", "max_days_per_week"]) {
    const v = b[key];
    if (v != null && !(Number.isInteger(v) && v >= 1 && v <= 7)) {
      return "週の日数は1〜7で指定してください";
    }
  }
  if (
    b.min_days_per_week != null &&
    b.max_days_per_week != null &&
    b.min_days_per_week > b.max_days_per_week
  ) {
    return "週の日数の「以上」が「まで」より大きくなっています";
  }

  for (const key of ["default_start", "default_end"]) {
    if (b[key] && !isTime(b[key])) return "時刻の形式が正しくありません";
  }
  if (b.note != null && String(b.note).length > 500) {
    return "備考は500文字以内にしてください";
  }

  if (!Array.isArray(b.days)) return "日付の一覧が読み取れません";
  if (b.days.length > 31) return "日付が多すぎます";
  const seen = new Set();
  for (const d of b.days) {
    if (!isDate(d?.date) || !d.date.startsWith(b.period + "-")) {
      return "選んだ月以外の日付が含まれています";
    }
    if (seen.has(d.date)) return "同じ日付が重複しています";
    seen.add(d.date);
    if (d.status !== "ok" && d.status !== "maybe") return "○か△を選んでください";
    if (d.start_time && !isTime(d.start_time)) return "時刻の形式が正しくありません";
    if (d.end_time && !isTime(d.end_time)) return "時刻の形式が正しくありません";
  }
  return null; // 問題なし
}

const isPeriod = (s) => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function formatPeriodJa(period) {
  const [y, m] = period.split("-").map(Number);
  return `${y}年${m}月`;
}

// =========================================================
// ちょっとした共通処理
// =========================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
