/* =========================================================
   シフト（作成担当が組むもの）
   みんなが出した「希望」（submissions / availability）は書き換えず、
   ここに別に持って編集する
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

/* シフトの下書き：誰が・何日に・何時から何時まで入るか（1人1日1件） */
CREATE TABLE IF NOT EXISTS assignments (
  period     TEXT    NOT NULL,                  /* どの月のシフトか（例: '2026-12'） */
  staff_id   INTEGER NOT NULL REFERENCES staff(id),
  date       TEXT    NOT NULL,                  /* 例: '2026-12-03' */
  start_time TEXT,                              /* 例: '17:00' */
  end_time   TEXT,                              /* 空ならラストまで */
  PRIMARY KEY (staff_id, date)
);

CREATE INDEX IF NOT EXISTS idx_assignments_period ON assignments (period);

/* 月ごとの状態と、公開した時点のシフトのコピー
   スタッフが見るのは published_data（公開後に下書きを直しても、もう一度公開するまで変わらない） */
CREATE TABLE IF NOT EXISTS schedules (
  period            TEXT PRIMARY KEY,
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),  /* 下書きを最後に変えた時刻 */
  draft_version     INTEGER NOT NULL DEFAULT 0,  /* 下書きを変えるたびに1ずつ増える番号 */
  published_version INTEGER,                     /* 公開したときの draft_version（違えば公開後に変更あり） */
  published_at      TEXT,                        /* 最後に公開した時刻 */
  published_data    TEXT                         /* 公開した時点のシフト（JSON） */
);
