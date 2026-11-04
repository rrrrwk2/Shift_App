// =========================================================
// Shift_App サーバー側の処理（Cloudflare Worker）
//
// 画面（public フォルダのHTMLなど）はCloudflareがそのまま配信します。
// このファイルが担当するのは「/api/〜」で始まるURLへのリクエストだけで、
// データベース（D1）への保存や読み込みをします。
// =========================================================

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

  // ---- スタッフ向け（合言葉が必要） ----
  if (path === "/api/staff" && method === "GET") {
    if (!checkKey(request, env, "staff")) return unauthorized();
    return listStaff(env);
  }
  if (path === "/api/submission" && method === "GET") {
    if (!checkKey(request, env, "staff")) return unauthorized();
    return getSubmission(env, url);
  }
  if (path === "/api/submission" && method === "POST") {
    if (!checkKey(request, env, "staff")) return unauthorized();
    return saveSubmission(env, await readJson(request));
  }

  // ---- 作成担当（管理者）向け（管理用の合言葉が必要） ----
  if (path === "/api/admin/check" && method === "GET") {
    if (!checkKey(request, env, "admin")) return unauthorized();
    return json({ ok: true });
  }
  if (path === "/api/admin/submissions" && method === "GET") {
    if (!checkKey(request, env, "admin")) return unauthorized();
    return listSubmissions(env, url);
  }
  if (path === "/api/admin/staff" && method === "POST") {
    if (!checkKey(request, env, "admin")) return unauthorized();
    return addStaff(env, await readJson(request));
  }
  if (path === "/api/admin/staff/deactivate" && method === "POST") {
    if (!checkKey(request, env, "admin")) return unauthorized();
    return deactivateStaff(env, await readJson(request));
  }

  return json({ error: "見つかりません" }, 404);
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

// =========================================================
// シフト希望
// =========================================================

// 1人分・1か月分の提出内容を返す（出し直すときに前の内容を表示するため）
async function getSubmission(env, url) {
  const staffId = Number(url.searchParams.get("staff_id"));
  const period = url.searchParams.get("period") ?? "";
  if (!Number.isInteger(staffId) || !isPeriod(period)) {
    return json({ error: "パラメータが正しくありません" }, 400);
  }

  const sub = await env.DB.prepare(
    "SELECT * FROM submissions WHERE staff_id = ? AND period = ?"
  )
    .bind(staffId, period)
    .first();
  if (!sub) return json({ submission: null });

  const { results: days } = await env.DB.prepare(
    "SELECT date, status, start_time, end_time FROM availability WHERE submission_id = ? ORDER BY date"
  )
    .bind(sub.id)
    .all();

  return json({ submission: { ...sub, days } });
}

// 提出内容を保存する（同じ人・同じ月の提出があれば上書き）
async function saveSubmission(env, body) {
  // ---- 1. 送られてきた内容をチェックする ----
  const problem = validateSubmission(body);
  if (problem) return json({ error: problem }, 400);

  const staff = await env.DB.prepare(
    "SELECT id FROM staff WHERE id = ? AND active = 1"
  )
    .bind(body.staff_id)
    .first();
  if (!staff) return json({ error: "そのスタッフは登録されていません" }, 400);

  // ---- 2. まとめて保存する ----
  // batch() に渡した処理は「全部成功」か「全部やり直し」のどちらかになる（途中で止まらない）
  const findId =
    "(SELECT id FROM submissions WHERE staff_id = ? AND period = ?)";
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

// 管理者用：1か月分の全員の提出内容を返す
async function listSubmissions(env, url) {
  const period = url.searchParams.get("period") ?? "";
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const [staffRes, subRes, dayRes] = await env.DB.batch([
    env.DB.prepare("SELECT id, name FROM staff WHERE active = 1 ORDER BY id"),
    env.DB.prepare("SELECT * FROM submissions WHERE period = ?").bind(period),
    env.DB.prepare(
      `SELECT a.submission_id, a.date, a.status, a.start_time, a.end_time
         FROM availability a
         JOIN submissions s ON s.id = a.submission_id
        WHERE s.period = ?
        ORDER BY a.date`
    ).bind(period),
  ]);

  // 提出ごとに日ごとの希望をまとめる
  const submissions = subRes.results.map((s) => ({
    ...s,
    days: dayRes.results.filter((d) => d.submission_id === s.id),
  }));

  return json({ staff: staffRes.results, submissions });
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

// =========================================================
// 合言葉のチェック
//
// LINEとつなぐまでの間は、合言葉を知っている人だけが使えるようにしておく。
// 合言葉そのものはコードには書かず、Cloudflareの設定（環境変数）に入れる。
//   ACCESS_KEY : スタッフ用の合言葉
//   ADMIN_KEY  : 作成担当用の合言葉（スタッフ用の画面にも使える）
// =========================================================

function checkKey(request, env, level) {
  const given = request.headers.get("X-Access-Key") ?? "";
  if (!given) return false;
  if (env.ADMIN_KEY && safeEqual(given, env.ADMIN_KEY)) return true;
  if (level === "staff" && env.ACCESS_KEY && safeEqual(given, env.ACCESS_KEY)) return true;
  return false;
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
