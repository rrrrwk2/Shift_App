/* =========================================================
   Shift_App データベースの初期設定
   Cloudflare D1（中身はSQLite）で使うテーブルを作ります。
   ※ ダッシュボードのコンソールは改行が消えることがあるので、
     コメントは「--」ではなく、スラッシュとアスタリスクで囲む形で書いています。
   ========================================================= */

/* スタッフ（バイトのメンバー） */
CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  /* 自動で振られる番号 */
  name       TEXT    NOT NULL,                   /* 表示名 */
  active     INTEGER NOT NULL DEFAULT 1,         /* 1=在籍中 / 0=やめた人（一覧に出さない） */
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

/* シフト希望の提出（1人・1つの月につき1件。出し直したら上書き） */
CREATE TABLE IF NOT EXISTS submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id          INTEGER NOT NULL REFERENCES staff(id),
  period            TEXT    NOT NULL,   /* 対象の月（例: '2026-12'） */
  min_days_per_week INTEGER,            /* 週◯日以上（指定なしならNULL） */
  max_days_per_week INTEGER,            /* 週◯日まで（指定なしならNULL） */
  default_start     TEXT,               /* 基本の開始時刻（例: '17:00'） */
  default_end       TEXT,               /* 基本の終了時刻（空ならラストまで） */
  note              TEXT,               /* 備考（自由記述） */
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (staff_id, period)             /* 同じ人・同じ月は1件だけ */
);

/* 日ごとの希望（入れる日だけ保存。行がない日＝入れない日） */
CREATE TABLE IF NOT EXISTS availability (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL,   /* 日付（例: '2026-12-03'） */
  status        TEXT    NOT NULL CHECK (status IN ('ok', 'maybe')),  /* ok=○ / maybe=△ */
  start_time    TEXT,               /* その日の開始時刻 */
  end_time      TEXT,               /* その日の終了時刻 */
  PRIMARY KEY (submission_id, date)
);
