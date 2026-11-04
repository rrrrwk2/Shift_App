// =========================================================
// Shift_App サーバー側の処理（Cloudflare Worker）
//
// 画面（public フォルダのHTMLなど）はCloudflareがそのまま配信します。
// このファイルが担当するのは「/api/〜」で始まるURLへのリクエストだけで、
// データベース（D1）への保存や読み込みをします。
// =========================================================

// 提出の締切日：対象の月の「前の月」のこの日の23:59（日本時間）まで
// 例）12月分の希望 → 11月15日 23:59 まで
const DEADLINE_DAY = 15;

export default {
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

  // 合言葉がCloudflare側にまだ設定されていない場合は、それが分かるように伝える
  if (!env.ADMIN_KEY) {
    return json(
      { error: "サーバーに合言葉（ADMIN_KEY）が設定されていません。Cloudflareの設定を確認してください" },
      503
    );
  }

  // 合言葉から「誰として来たか」を判定する： "admin" / "staff" / null（合言葉が違う）
  const role = roleOf(request, env);
  const isAdmin = role === "admin";

  // ---- スタッフ向け（スタッフ用か管理用の合言葉が必要） ----
  if (path.startsWith("/api/") && !path.startsWith("/api/admin/")) {
    if (!role) return unauthorized();

    if (path === "/api/periods" && method === "GET") return listPeriods(isAdmin);
    if (path === "/api/staff" && method === "GET") return listStaff(env);
    if (path === "/api/submission" && method === "GET") return getSubmission(env, url, isAdmin);
    if (path === "/api/submission" && method === "POST") {
      return saveSubmission(env, await readJson(request), isAdmin);
    }
    if (path === "/api/change-request" && method === "POST") {
      return addChangeRequest(env, await readJson(request));
    }
  }

  // ---- 作成担当（管理者）向け（管理用の合言葉が必要） ----
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return unauthorized();

    if (path === "/api/admin/check" && method === "GET") return json({ ok: true });
    if (path === "/api/admin/submissions" && method === "GET") return listSubmissions(env, url);
    if (path === "/api/admin/staff" && method === "POST") {
      return addStaff(env, await readJson(request));
    }
    if (path === "/api/admin/staff/deactivate" && method === "POST") {
      return deactivateStaff(env, await readJson(request));
    }
    if (path === "/api/admin/change-request/status" && method === "POST") {
      return setChangeRequestStatus(env, await readJson(request));
    }
  }

  return json({ error: "見つかりません" }, 404);
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

// 提出画面で選べる月（今月・来月・再来月）と、最初に選んでおく月を返す
function listPeriods(isAdmin) {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const periods = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    periods.push(periodInfo(period));
  }
  // 最初に選んでおくのは「まだ締切前の一番近い月」
  const initial = (periods.find((p) => p.open) ?? periods[periods.length - 1]).period;
  return json({ periods, initial, admin: isAdmin });
}

// =========================================================
// スタッフ
// =========================================================

// 在籍中のスタッフ一覧を返す
async function listStaff(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name FROM staff WHERE active = 1 ORDER BY id"
  ).all();
  return json({ staff: results });
}

// スタッフを追加する
async function addStaff(env, body) {
  const name = String(body?.name ?? "").trim();
  if (name.length < 1 || name.length > 30) {
    return json({ error: "名前は1〜30文字で入力してください" }, 400);
  }
  const row = await env.DB.prepare(
    "INSERT INTO staff (name) VALUES (?) RETURNING id, name"
  )
    .bind(name)
    .first();
  return json({ staff: row });
}

// スタッフを一覧から外す（データは残す）
async function deactivateStaff(env, body) {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  await env.DB.prepare("UPDATE staff SET active = 0 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function isActiveStaff(env, staffId) {
  const row = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND active = 1")
    .bind(staffId)
    .first();
  return Boolean(row);
}

// =========================================================
// シフト希望
// =========================================================

// 1人分・1か月分の提出内容と、締切の情報、その人の変更申請を返す
async function getSubmission(env, url, isAdmin) {
  const staffId = Number(url.searchParams.get("staff_id"));
  const period = url.searchParams.get("period") ?? "";
  if (!Number.isInteger(staffId) || !isPeriod(period)) {
    return json({ error: "パラメータが正しくありません" }, 400);
  }

  const [subRes, reqRes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM submissions WHERE staff_id = ? AND period = ?").bind(
      staffId,
      period
    ),
    env.DB.prepare(
      `SELECT id, message, status, created_at FROM change_requests
        WHERE staff_id = ? AND period = ? ORDER BY id DESC`
    ).bind(staffId, period),
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
    // 締切後でも直接修正できるか（管理用の合言葉のときだけ）
    can_edit: !isClosed(period) || isAdmin,
  });
}

// 提出内容を保存する（同じ人・同じ月の提出があれば上書き）
async function saveSubmission(env, body, isAdmin) {
  // ---- 1. 送られてきた内容をチェックする ----
  const problem = validateSubmission(body);
  if (problem) return json({ error: problem }, 400);

  // 締切を過ぎていたら受け付けない（作成担当は例外）
  if (isClosed(body.period) && !isAdmin) {
    return json(
      {
        error: `${formatPeriodJa(body.period)}分の提出期限（${deadlineText(body.period)}）を過ぎています。変更は「変更を申請する」から送ってください`,
      },
      403
    );
  }

  if (!(await isActiveStaff(env, body.staff_id))) {
    return json({ error: "そのスタッフは登録されていません" }, 400);
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
      body.staff_id,
      body.period,
      body.min_days_per_week ?? null,
      body.max_days_per_week ?? null,
      body.default_start || null,
      body.default_end || null,
      body.note || null
    ),
    // 前回の日ごとの希望をいったん消す
    env.DB.prepare(`DELETE FROM availability WHERE submission_id = ${findId}`).bind(
      body.staff_id,
      body.period
    ),
    // 今回の日ごとの希望を入れ直す
    ...body.days.map((d) =>
      env.DB.prepare(
        `INSERT INTO availability (submission_id, date, status, start_time, end_time)
         VALUES (${findId}, ?, ?, ?, ?)`
      ).bind(body.staff_id, body.period, d.date, d.status, d.start_time || null, d.end_time || null)
    ),
  ];
  await env.DB.batch(statements);

  return json({ ok: true });
}

// 管理者用：1か月分の全員の提出内容と変更申請を返す
async function listSubmissions(env, url) {
  const period = url.searchParams.get("period") ?? "";
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const [staffRes, subRes, dayRes, reqRes] = await env.DB.batch([
    env.DB.prepare("SELECT id, name FROM staff WHERE active = 1 ORDER BY id"),
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
    period_info: periodInfo(period),
  });
}

// =========================================================
// 変更の申請（締切後に出すもの）
// =========================================================

async function addChangeRequest(env, body) {
  const staffId = body?.staff_id;
  const period = body?.period;
  const message = String(body?.message ?? "").trim();

  if (!Number.isInteger(staffId)) return json({ error: "名前を選んでください" }, 400);
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);
  if (message.length < 1) return json({ error: "変更したい内容を書いてください" }, 400);
  if (message.length > 500) return json({ error: "申請は500文字以内にしてください" }, 400);
  if (!(await isActiveStaff(env, staffId))) {
    return json({ error: "そのスタッフは登録されていません" }, 400);
  }

  // いたずらで大量に送られないよう、1人1か月あたりの件数に上限をつける
  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM change_requests WHERE staff_id = ? AND period = ?"
  )
    .bind(staffId, period)
    .first();
  if (count >= 20) return json({ error: "この月の申請が多すぎます。作成担当に直接連絡してください" }, 429);

  await env.DB.prepare(
    "INSERT INTO change_requests (staff_id, period, message) VALUES (?, ?, ?)"
  )
    .bind(staffId, period, message)
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
  if (!Number.isInteger(b.staff_id)) return "名前を選んでください";
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
// 合言葉のチェック
//
// LINEとつなぐまでの間は、合言葉を知っている人だけが使えるようにしておく。
// 合言葉そのものはコードには書かず、Cloudflareの設定（シークレット）に入れる。
//   ACCESS_KEY : スタッフ用の合言葉
//   ADMIN_KEY  : 作成担当用の合言葉（スタッフ用の画面にも使える）
// =========================================================

function roleOf(request, env) {
  const given = request.headers.get("X-Access-Key") ?? "";
  if (!given) return null;
  if (env.ADMIN_KEY && safeEqual(given, env.ADMIN_KEY)) return "admin";
  if (env.ACCESS_KEY && safeEqual(given, env.ACCESS_KEY)) return "staff";
  return null;
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

function unauthorized() {
  return json({ error: "合言葉が違います" }, 401);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
