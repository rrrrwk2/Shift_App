/* =========================================================
   締切後の「変更の申請」を入れるテーブル
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

CREATE TABLE IF NOT EXISTS change_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  period      TEXT    NOT NULL,                     /* どの月のシフトについての申請か（例: '2026-12'） */
  message     TEXT    NOT NULL,                     /* 申請の内容（自由記述） */
  status      TEXT    NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'done')),   /* open=未対応 / done=対応済み */
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT                                  /* 対応済みにした時刻 */
);
