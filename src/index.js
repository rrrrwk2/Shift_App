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
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil(Promise.all([runDailyReminder(env, now), purgeOldData(env, now)]));
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

  // ---- ここから先は、LINEでの本人確認が必要（スタッフも管理者も） ----
  if (!env.LINE_CHANNEL_ID) {
    return json({ error: "LINE連携の設定（LINE_CHANNEL_ID）がまだです" }, 503);
  }
  const lineUser = await verifyLineUser(request, env);
  if (!lineUser) {
    return json(
      { error: "LINEでの本人確認ができませんでした。開き直してください", code: "line_auth" },
      401
    );
  }

  // ---- 作成担当（管理者）向け：登録された管理者だけ ----
  if (path.startsWith("/api/admin/")) {
    // 管理者でなくても使えるもの：自分の状態の確認、最初の1人の登録、招待コードでの登録
    if (path === "/api/admin/me" && method === "GET") return getAdminMe(env, lineUser);
    if (path === "/api/admin/bootstrap" && method === "POST") {
      return bootstrapAdmin(env, lineUser, await readJson(request));
    }
    if (path === "/api/admin/join" && method === "POST") {
      return joinAdmin(env, lineUser, await readJson(request));
    }

    const admin = await adminOf(env, lineUser.sub);
    if (!admin) {
      return json({ error: "この画面は、登録された管理者だけが使えます", code: "not_admin" }, 403);
    }

    // 管理者の管理
    if (path === "/api/admin/admins" && method === "GET") return listAdmins(env, admin);
    if (path === "/api/admin/admins/invite" && method === "POST") return createAdminInvite(env, admin);
    if (path === "/api/admin/admins/remove" && method === "POST") {
      return removeAdmin(env, await readJson(request));
    }

    if (path === "/api/admin/submissions" && method === "GET") return listSubmissions(env, url);
    if (path === "/api/admin/staff" && method === "POST") {
      return addStaff(env, await readJson(request));
    }
    if (path === "/api/admin/staff/invite" && method === "POST") {
      return createStaffInvite(env, admin, await readJson(request));
    }
    if (path === "/api/admin/staff/deactivate" && method === "POST") {
      return deactivateStaff(env, await readJson(request));
    }
    if (path === "/api/admin/staff/delete" && method === "POST") {
      return deleteStaffCompletely(env, await readJson(request));
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
    if (path === "/api/admin/schedule" && method === "GET") return getScheduleAdmin(env, url);
    if (path === "/api/admin/schedule/generate" && method === "POST") {
      return generateDraft(env, await readJson(request));
    }
    if (path === "/api/admin/schedule/assign" && method === "POST") {
      return assignShift(env, await readJson(request));
    }
    if (path === "/api/admin/schedule/unassign" && method === "POST") {
      return unassignShift(env, await readJson(request));
    }
    if (path === "/api/admin/schedule/publish" && method === "POST") {
      return publishSchedule(env, await readJson(request));
    }
    if (path === "/api/admin/remind" && method === "POST") {
      return sendManualReminder(env, await readJson(request));
    }
    return json({ error: "見つかりません" }, 404);
  }

  // ---- スタッフ向け ----
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
  if (path === "/api/schedule" && method === "GET") return getPublishedSchedule(env, url, me);

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

// 文字列を比べる（かかる時間から合言葉を推測されないようにする比べ方）
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// =========================================================
// 管理者（一覧画面・シフト作成画面に入れる人）
//
// ・管理者はLINEアカウントで登録する（共有の合言葉は使わない）
// ・最初の1人だけは、Cloudflareに設定した合言葉（ADMIN_KEY）で登録する
// ・2人目からは、管理者が発行した「管理者の招待コード」で登録する
// =========================================================

const STAFF_INVITE_DAYS = 7; // スタッフの招待コードの有効期限（日）
const ADMIN_INVITE_HOURS = 24; // 管理者の招待コードの有効期限（時間）

async function adminOf(env, lineUserId) {
  return env.DB.prepare("SELECT line_user_id, name FROM admins WHERE line_user_id = ?")
    .bind(lineUserId)
    .first();
}

// 自分が管理者かどうか（管理者がまだ1人もいないなら、最初の登録ができることも返す）
async function getAdminMe(env, lineUser) {
  const [meRes, countRes] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM admins WHERE line_user_id = ?").bind(lineUser.sub),
    env.DB.prepare("SELECT COUNT(*) AS n FROM admins"),
  ]);
  const hasAdmins = countRes.results[0].n > 0;
  return json({
    admin: meRes.results.length > 0,
    line_name: lineUser.name,
    can_bootstrap: !hasAdmins && Boolean(env.ADMIN_KEY),
  });
}

// 最初の1人を登録する（管理者が0人のときだけ。合言葉が必要）
async function bootstrapAdmin(env, lineUser, body) {
  const limitKey = `bootstrap:${lineUser.sub}`;
  if (await isLocked(env, limitKey)) return tooManyFailures();
  if (!env.ADMIN_KEY) return json({ error: "サーバーに合言葉（ADMIN_KEY）が設定されていません" }, 503);

  const key = String(body?.key ?? "");
  if (!key || !safeEqual(key, env.ADMIN_KEY)) {
    await recordFailure(env, limitKey);
    return json({ error: "合言葉が違います" }, 400);
  }
  // 「まだ1人もいないとき」という条件つきで追加する（2人が同時に登録しようとしても1人だけになる）
  const result = await env.DB.prepare(
    `INSERT INTO admins (line_user_id, name)
     SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM admins)`
  )
    .bind(lineUser.sub, lineUser.name || "（名前なし）")
    .run();
  if (result.meta.changes !== 1) {
    return json({ error: "すでに管理者が登録されています。管理者から招待コードをもらってください" }, 409);
  }
  await clearFailures(env, limitKey);
  return json({ ok: true });
}

// 管理者の招待コードで、管理者として登録する
async function joinAdmin(env, lineUser, body) {
  if (await adminOf(env, lineUser.sub)) return json({ ok: true });
  const limitKey = `admin-invite:${lineUser.sub}`;
  if (await isLocked(env, limitKey)) return tooManyFailures();

  const hash = await hashCode(body?.code);
  if (hash) {
    const valid = `code_hash = ? AND kind = 'admin' AND used_at IS NULL AND expires_at > datetime('now')`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO admins (line_user_id, name, added_by)
         SELECT ?, ?, created_by FROM invites WHERE ${valid}`
      ).bind(lineUser.sub, lineUser.name || "（名前なし）", hash),
      env.DB.prepare(`UPDATE invites SET used_at = datetime('now') WHERE ${valid}`).bind(hash),
    ]);
  }
  if (!(await adminOf(env, lineUser.sub))) {
    await recordFailure(env, limitKey);
    return json({ error: "招待コードが正しくないか、期限が切れています" }, 400);
  }
  await clearFailures(env, limitKey);
  return json({ ok: true });
}

async function listAdmins(env, admin) {
  const { results } = await env.DB.prepare(
    "SELECT line_user_id, name, added_at FROM admins ORDER BY added_at"
  ).all();
  return json({
    admins: results.map((a) => ({ ...a, is_me: a.line_user_id === admin.line_user_id })),
  });
}

async function createAdminInvite(env, admin) {
  const code = newCode();
  await env.DB.prepare(
    `INSERT INTO invites (code_hash, kind, created_by, expires_at)
     VALUES (?, 'admin', ?, datetime('now', '+${ADMIN_INVITE_HOURS} hours'))`
  )
    .bind(await hashCode(code), admin.line_user_id)
    .run();
  return json({ code, hours: ADMIN_INVITE_HOURS });
}

async function removeAdmin(env, body) {
  const id = String(body?.line_user_id ?? "");
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM admins").first();
  if (n <= 1) return json({ error: "最後の1人の管理者は削除できません" }, 400);
  await env.DB.prepare("DELETE FROM admins WHERE line_user_id = ?").bind(id).run();
  return json({ ok: true });
}

// =========================================================
// 招待コードと、まちがえた回数の制限
// =========================================================

// 招待コード：読み間違えやすい文字（0とO、1とIなど）を除いた32種類の文字で8けた（例: K7P2-QX9M）
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8)); // 予測できない乱数
  const chars = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

// コードはそのまま保存せず、ハッシュ値（元に戻せない変換）にして保存・照合する
async function hashCode(code) {
  const normalized = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length !== 8) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`shiftapp:${normalized}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 60分のあいだに5回まちがえたら、しばらく受け付けない（総当たり対策）
const FAIL_LIMIT = 5;
const FAIL_WINDOW = "-60 minutes";

async function isLocked(env, key) {
  const row = await env.DB.prepare(
    "SELECT count FROM auth_failures WHERE key = ? AND window_start > datetime('now', ?)"
  )
    .bind(key, FAIL_WINDOW)
    .first();
  return Boolean(row && row.count >= FAIL_LIMIT);
}

async function recordFailure(env, key) {
  await env.DB.prepare(
    `INSERT INTO auth_failures (key, count, window_start) VALUES (?, 1, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET
       count        = CASE WHEN window_start > datetime('now', ?) THEN count + 1 ELSE 1 END,
       window_start = CASE WHEN window_start > datetime('now', ?) THEN window_start ELSE datetime('now') END`
  )
    .bind(key, FAIL_WINDOW, FAIL_WINDOW)
    .run();
}

async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM auth_failures WHERE key = ?").bind(key).run();
}

function tooManyFailures() {
  return json({ error: "まちがえた回数が多いため、しばらく（1時間ほど）待ってからやり直してください" }, 429);
}

// =========================================================
// LINEアカウントと名前の結びつけ
// =========================================================

async function staffOfLineUser(env, lineUserId) {
  return env.DB.prepare("SELECT id, name FROM staff WHERE line_user_id = ? AND active = 1")
    .bind(lineUserId)
    .first();
}

// 自分がどの名前と結びついているか
// （名簿は外から見えないようにするため、まだの人にも名前の一覧は返さない）
async function getMe(env, lineUser) {
  const me = await staffOfLineUser(env, lineUser.sub);
  return json({ linked: Boolean(me), staff: me ?? null, line_name: lineUser.name });
}

// 招待コードを入れて、自分のLINEアカウントと名前を結びつける（最初の1回だけ）
async function linkMe(env, lineUser, body) {
  if (body?.consent !== true) {
    return json({ error: "個人情報の取り扱いへの同意が必要です" }, 400);
  }
  if (await staffOfLineUser(env, lineUser.sub)) {
    return json({ error: "このLINEアカウントは、すでに名前が登録されています" }, 409);
  }
  const limitKey = `invite:${lineUser.sub}`;
  if (await isLocked(env, limitKey)) return tooManyFailures();

  const hash = await hashCode(body?.code);
  if (hash) {
    // 「使われていない・期限内」の招待コードに対応する、まだ誰とも結びついていない名前だけを結びつける
    // （2つの処理はまとめて実行されるので、同じコードを2人が同時に使っても1人にしか効かない）
    const validInvite = `SELECT staff_id FROM invites
                          WHERE code_hash = ? AND kind = 'staff' AND used_at IS NULL
                            AND expires_at > datetime('now')`;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE staff SET line_user_id = ?, line_name = ?, consented_at = datetime('now')
          WHERE id = (${validInvite}) AND active = 1 AND line_user_id IS NULL`
      ).bind(lineUser.sub, lineUser.name || null, hash),
      env.DB.prepare(
        `UPDATE invites SET used_at = datetime('now')
          WHERE code_hash = ? AND used_at IS NULL
            AND staff_id = (SELECT id FROM staff WHERE line_user_id = ?)`
      ).bind(hash, lineUser.sub),
    ]);
  }

  const me = await staffOfLineUser(env, lineUser.sub);
  if (!me) {
    await recordFailure(env, limitKey);
    return json({ error: "招待コードが正しくないか、期限が切れています。作成担当に確認してください" }, 400);
  }
  await clearFailures(env, limitKey);
  return json({ ok: true, staff: me });
}

// 管理者用：スタッフの招待コードを発行する（前に出した使っていないコードは無効にする）
async function createStaffInvite(env, admin, body) {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  const staff = await env.DB.prepare("SELECT id, line_user_id FROM staff WHERE id = ? AND active = 1")
    .bind(id)
    .first();
  if (!staff) return json({ error: "そのスタッフは登録されていません" }, 400);
  if (staff.line_user_id) return json({ error: "この人はすでにLINE連携済みです" }, 400);

  const code = newCode();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE kind = 'staff' AND staff_id = ? AND used_at IS NULL").bind(id),
    env.DB.prepare(
      `INSERT INTO invites (code_hash, kind, staff_id, created_by, expires_at)
       VALUES (?, 'staff', ?, ?, datetime('now', '+${STAFF_INVITE_DAYS} days'))`
    ).bind(await hashCode(code), id, admin.line_user_id),
  ]);
  return json({ code, days: STAFF_INVITE_DAYS });
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

// 毎日のルール。null の項目はチェックしない
//   capacity : 曜日ごとの定員（○の人がこの人数ちょうどが目標。少なすぎ・多すぎを知らせる）
//              "0"=日曜 〜 "6"=土曜、"holiday"=祝日（祝日は曜日より優先）
//   min_〜   : その日に最低何人必要か（ベテラン・男性・女性）
const CAPACITY_KEYS = ["0", "1", "2", "3", "4", "5", "6", "holiday"];
const DEFAULT_RULES = {
  capacity: Object.fromEntries(CAPACITY_KEYS.map((k) => [k, null])),
  min_veteran: null,
  min_male: null,
  min_female: null,
  closed_weekdays: [], // チェックしない曜日（0=日曜 〜 6=土曜）。定休日など
};

// 0〜99の整数か、空（null）かを確かめる
function toCount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (Number.isInteger(v) && v >= 0 && v <= 99) return v;
  throw new Error("人数は0〜99で入力してください");
}

async function saveRules(env, body) {
  const rules = { capacity: {} };
  try {
    for (const key of CAPACITY_KEYS) rules.capacity[key] = toCount(body?.capacity?.[key]);
    for (const key of ["min_veteran", "min_male", "min_female"]) rules[key] = toCount(body?.[key]);
  } catch (err) {
    return json({ error: err.message }, 400);
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

// 保存されているルールを読み込む（前の形で保存されていても、足りない項目は空で補う）
function loadRules(row) {
  const saved = row ? JSON.parse(row.value) : {};
  return {
    ...DEFAULT_RULES,
    ...saved,
    capacity: { ...DEFAULT_RULES.capacity, ...(saved.capacity ?? {}) },
  };
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
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE staff SET active = 0, line_user_id = NULL, line_name = NULL, deactivated_at = datetime('now')
        WHERE id = ?`
    ).bind(id),
    env.DB.prepare("DELETE FROM invites WHERE staff_id = ? AND used_at IS NULL").bind(id),
  ]);
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
      `SELECT id, name, gender, level, line_name, line_user_id IS NOT NULL AS linked, consented_at,
              (SELECT MAX(expires_at) FROM invites i
                WHERE i.kind = 'staff' AND i.staff_id = staff.id AND i.used_at IS NULL
                  AND i.expires_at > datetime('now')) AS invite_expires_at
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
    rules: loadRules(rulesRes.results[0]),
    reminder_ready: Boolean(env.LINE_MESSAGING_TOKEN), // LINEで送る準備ができているか
    period_info: periodInfo(period),
  });
}

// =========================================================
// シフト（作成担当が組むもの）
//   assignments … 下書き（作成担当が自由に編集する）
//   schedules   … 公開した時点のコピー（スタッフが見るのはこっち）
// =========================================================

// 下書きを変えたら、変更の番号を1つ増やす（公開したときの番号と比べて、公開後に変更があるか分かるように）
function touchSchedule(env, period) {
  return env.DB.prepare(
    `INSERT INTO schedules (period, updated_at, draft_version) VALUES (?, datetime('now'), 1)
     ON CONFLICT (period) DO UPDATE SET updated_at = datetime('now'), draft_version = draft_version + 1`
  ).bind(period);
}

// 管理者用：下書きと公開の状態を返す
async function getScheduleAdmin(env, url) {
  const period = url.searchParams.get("period") ?? "";
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const [aRes, sRes] = await env.DB.batch([
    env.DB.prepare(
      "SELECT staff_id, date, start_time, end_time FROM assignments WHERE period = ? ORDER BY date"
    ).bind(period),
    env.DB.prepare(
      "SELECT updated_at, published_at, draft_version, published_version FROM schedules WHERE period = ?"
    ).bind(period),
  ]);
  const sch = sRes.results[0] ?? null;
  return json({
    assignments: aRes.results,
    schedule: {
      exists: Boolean(sch),
      updated_at: sch?.updated_at ?? null,
      published_at: sch?.published_at ?? null,
      // 公開したあとに下書きを直したか（もう一度公開が必要か）
      changed_since_publish: Boolean(sch?.published_at && sch.draft_version !== sch.published_version),
    },
  });
}

// 管理者用：希望の○から下書きを作る（すでに下書きがあるときは overwrite: true のときだけ作り直す）
async function generateDraft(env, body) {
  const period = body?.period;
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const existing = await env.DB.prepare("SELECT COUNT(*) AS n FROM assignments WHERE period = ?")
    .bind(period)
    .first();
  if (existing.n > 0 && body?.overwrite !== true) {
    return json({ error: "すでに下書きがあります", code: "draft_exists", count: existing.n }, 409);
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM assignments WHERE period = ?").bind(period),
    // ○の日を、その日の時間（なければその人の基本の時間）で入れる
    env.DB.prepare(
      `INSERT INTO assignments (period, staff_id, date, start_time, end_time)
       SELECT s.period, s.staff_id, a.date,
              COALESCE(a.start_time, s.default_start),
              COALESCE(a.end_time, s.default_end)
         FROM availability a
         JOIN submissions s ON s.id = a.submission_id
         JOIN staff st ON st.id = s.staff_id
        WHERE s.period = ? AND a.status = 'ok' AND st.active = 1`
    ).bind(period),
    touchSchedule(env, period),
  ]);
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM assignments WHERE period = ?")
    .bind(period)
    .first();
  return json({ ok: true, count: n });
}

// 管理者用：1人・1日分を入れる（すでに入っていたら時間を上書き）
async function assignShift(env, body) {
  const { period, staff_id: staffId, date, start_time: start, end_time: end } = body ?? {};
  if (!isPeriod(period) || !isDate(date) || !date.startsWith(period + "-")) {
    return json({ error: "日付が正しくありません" }, 400);
  }
  if (!Number.isInteger(staffId)) return json({ error: "スタッフが正しくありません" }, 400);
  if ((start && !isTime(start)) || (end && !isTime(end))) {
    return json({ error: "時刻の形式が正しくありません" }, 400);
  }
  const staff = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND active = 1")
    .bind(staffId)
    .first();
  if (!staff) return json({ error: "そのスタッフは登録されていません" }, 400);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO assignments (period, staff_id, date, start_time, end_time) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (staff_id, date) DO UPDATE SET
         period = excluded.period, start_time = excluded.start_time, end_time = excluded.end_time`
    ).bind(period, staffId, date, start || null, end || null),
    touchSchedule(env, period),
  ]);
  return json({ ok: true });
}

// 管理者用：1人・1日分を外す
async function unassignShift(env, body) {
  const { period, staff_id: staffId, date } = body ?? {};
  if (!isPeriod(period) || !isDate(date) || !Number.isInteger(staffId)) {
    return json({ error: "指定が正しくありません" }, 400);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM assignments WHERE staff_id = ? AND date = ?").bind(staffId, date),
    touchSchedule(env, period),
  ]);
  return json({ ok: true });
}

// 管理者用：今の下書きを公開する（この時点の内容をコピーして保存。notify なら LINE で知らせる）
async function publishSchedule(env, body) {
  const period = body?.period;
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const [staffRes, aRes, sRes] = await env.DB.batch([
    // 名前と並び順だけを残す（性別やレベルはスタッフに見せないので入れない）
    env.DB.prepare(
      `SELECT DISTINCT st.id, st.name, st.sort_order
         FROM staff st
        WHERE st.active = 1 OR st.id IN (SELECT staff_id FROM assignments WHERE period = ?)
        ORDER BY st.sort_order, st.id`
    ).bind(period),
    env.DB.prepare(
      "SELECT staff_id, date, start_time, end_time FROM assignments WHERE period = ? ORDER BY date"
    ).bind(period),
    env.DB.prepare("SELECT published_at FROM schedules WHERE period = ?").bind(period),
  ]);
  if (aRes.results.length === 0) return json({ error: "下書きが空です" }, 400);

  const isUpdate = Boolean(sRes.results[0]?.published_at);
  const data = {
    staff: staffRes.results.map((s) => ({ id: s.id, name: s.name })),
    assignments: aRes.results,
  };
  // 公開した時点の「変更の番号」も覚えておく（このあと下書きを直すと番号がずれて「公開後に変更あり」になる）
  await env.DB.prepare(
    `INSERT INTO schedules (period, published_at, published_version, published_data)
     VALUES (?, datetime('now'), 0, ?)
     ON CONFLICT (period) DO UPDATE SET
       published_at = datetime('now'),
       published_version = draft_version,
       published_data = excluded.published_data`
  )
    .bind(period, JSON.stringify(data))
    .run();

  // LINEでみんなに知らせる
  let notified = 0;
  if (body?.notify === true && env.LINE_MESSAGING_TOKEN) {
    const { results } = await env.DB.prepare(
      "SELECT line_user_id FROM staff WHERE active = 1 AND line_user_id IS NOT NULL"
    ).all();
    const userIds = results.map((r) => r.line_user_id);
    if (userIds.length) {
      const [, month] = period.split("-").map(Number);
      const text =
        `【シフト${isUpdate ? "更新" : "公開"}のお知らせ】\n` +
        `${month}月のシフトが${isUpdate ? "更新されました" : "公開されました"}。\n` +
        `メニューの「シフト提出」→「シフトを見る」から確認してください。` +
        (env.LIFF_ID ? `\nhttps://miniapp.line.me/${env.LIFF_ID}?view=shift&period=${period}` : "");
      await sendLineText(env, userIds, text);
      notified = userIds.length;
    }
  }
  return json({ ok: true, notified, updated: isUpdate });
}

// スタッフ用：公開されているシフトを返す（自分の行がどれか分かるようにする）
async function getPublishedSchedule(env, url, me) {
  const period = url.searchParams.get("period") ?? "";
  if (!isPeriod(period)) return json({ error: "月の指定が正しくありません" }, 400);

  const row = await env.DB.prepare(
    "SELECT published_at, published_data FROM schedules WHERE period = ? AND published_at IS NOT NULL"
  )
    .bind(period)
    .first();
  if (!row) return json({ published: false });

  const data = JSON.parse(row.published_data);
  return json({
    published: true,
    published_at: row.published_at,
    me: me.id,
    staff: data.staff,
    assignments: data.assignments,
  });
}

// =========================================================
// 古いデータの削除（個人情報を必要以上に持ち続けないため）
//
// ・6か月より前の月の、希望・シフト・申請・リマインドの記録
// ・一覧から外してから6か月たったスタッフの情報
// ・使い終わった／期限切れの招待コード、古い失敗回数の記録
// 毎日の定期実行（scheduled）で呼ばれる
// =========================================================
const KEEP_MONTHS = 6;

// これより前の月のデータを消す、という境目の月（例：2026年11月なら "2026-05"）
export function retentionCutoff(now) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - KEEP_MONTHS, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function purgeOldData(env, now) {
  try {
    const cutoff = retentionCutoff(now);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM availability WHERE submission_id IN (SELECT id FROM submissions WHERE period < ?)"
      ).bind(cutoff),
      env.DB.prepare("DELETE FROM submissions WHERE period < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM change_requests WHERE period < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM assignments WHERE period < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM schedules WHERE period < ?").bind(cutoff),
      env.DB.prepare("DELETE FROM reminder_log WHERE period < ?").bind(cutoff),
      env.DB.prepare(
        "DELETE FROM invites WHERE used_at IS NOT NULL OR expires_at < datetime('now', '-7 days')"
      ),
      env.DB.prepare("DELETE FROM auth_failures WHERE window_start < datetime('now', '-1 day')"),
    ]);

    // 外してから6か月たった人は、その人のデータごと削除する
    const { results } = await env.DB.prepare(
      `SELECT id FROM staff WHERE active = 0 AND deactivated_at < datetime('now', '-${KEEP_MONTHS} months')`
    ).all();
    for (const row of results) await deleteStaffData(env, row.id);
  } catch (err) {
    console.error("古いデータの削除に失敗しました", err);
  }
}

// 管理者用：1人分のデータを完全に削除する（辞めた人から「消してほしい」と言われたときなど）
async function deleteStaffCompletely(env, body) {
  const id = Number(body?.id);
  if (!Number.isInteger(id)) return json({ error: "idが正しくありません" }, 400);
  await deleteStaffData(env, id);
  return json({ ok: true });
}

async function deleteStaffData(env, staffId) {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM availability WHERE submission_id IN (SELECT id FROM submissions WHERE staff_id = ?)"
    ).bind(staffId),
    env.DB.prepare("DELETE FROM submissions WHERE staff_id = ?").bind(staffId),
    env.DB.prepare("DELETE FROM change_requests WHERE staff_id = ?").bind(staffId),
    env.DB.prepare("DELETE FROM assignments WHERE staff_id = ?").bind(staffId),
    env.DB.prepare("DELETE FROM invites WHERE staff_id = ?").bind(staffId),
    env.DB.prepare("DELETE FROM staff WHERE id = ?").bind(staffId),
  ]);

  // 公開済みのシフト（コピー）からも、その人の名前とシフトを消す
  const { results } = await env.DB.prepare(
    "SELECT period, published_data FROM schedules WHERE published_data IS NOT NULL"
  ).all();
  for (const row of results) {
    const data = JSON.parse(row.published_data);
    if (!data.staff.some((p) => p.id === staffId)) continue;
    data.staff = data.staff.filter((p) => p.id !== staffId);
    data.assignments = data.assignments.filter((a) => a.staff_id !== staffId);
    await env.DB.prepare("UPDATE schedules SET published_data = ? WHERE period = ?")
      .bind(JSON.stringify(data), row.period)
      .run();
  }
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
  await sendLineText(env, userIds, text);
}

// 指定したLINEユーザー全員に、同じ文章を送る
async function sendLineText(env, userIds, text) {
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
      "Cache-Control": "no-store", // 個人情報を含む返事を、途中やブラウザに保存させない
      "X-Content-Type-Options": "nosniff",
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
