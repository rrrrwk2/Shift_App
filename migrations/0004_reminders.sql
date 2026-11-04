/* =========================================================
   提出のお願い（リマインド）をLINEで送った記録
   同じ月・同じ種類のリマインドを二重に送らないために使う
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

CREATE TABLE IF NOT EXISTS reminder_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  period     TEXT    NOT NULL,                     /* どの月の分のお願いか（例: '2026-12'） */
  kind       TEXT    NOT NULL,                     /* '3days'=3日前 / '1day'=前日 / 'manual'=手動 */
  recipients INTEGER NOT NULL DEFAULT 0,           /* 送った人数 */
  sent_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

/* 自動のリマインド（3日前・前日）は、同じ月に1回ずつしか記録できないようにする */
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_log_auto
  ON reminder_log (period, kind) WHERE kind != 'manual';
