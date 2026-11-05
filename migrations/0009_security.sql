/* =========================================================
   セキュリティまわり
   ・管理画面に入れる人（管理者）をLINEアカウントで登録する
   ・スタッフ／管理者の招待コード
   ・合言葉や招待コードの総当たりを防ぐための失敗回数
   ・スタッフの同意日時と、一覧から外した日時（自動削除に使う）
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

/* 管理者（この人たちだけが一覧画面・シフト作成画面に入れる） */
CREATE TABLE IF NOT EXISTS admins (
  line_user_id TEXT PRIMARY KEY,                       /* LINEのユーザーID */
  name         TEXT NOT NULL,                          /* 登録したときのLINEの表示名 */
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  added_by     TEXT                                    /* 招待した管理者のLINEユーザーID（最初の1人は空） */
);

/* 招待コード（コードそのものは保存せず、ハッシュ値だけを保存する） */
CREATE TABLE IF NOT EXISTS invites (
  code_hash  TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('staff', 'admin')),  /* スタッフ用か管理者用か */
  staff_id   INTEGER REFERENCES staff(id),                      /* スタッフ用のとき、どの名前に結びつけるか */
  created_by TEXT,                                              /* 発行した管理者 */
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,                                     /* 有効期限 */
  used_at    TEXT                                               /* 使われた日時（1回使ったら終わり） */
);

/* 失敗回数（一定回数まちがえたら、しばらく受け付けない） */
CREATE TABLE IF NOT EXISTS auth_failures (
  key          TEXT PRIMARY KEY,                       /* 例: 'invite:LINEのユーザーID' */
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);

/* 個人情報の扱いに同意した日時 */
ALTER TABLE staff ADD COLUMN consented_at TEXT;

/* 一覧から外した日時（ここから一定期間たったら自動で削除する） */
ALTER TABLE staff ADD COLUMN deactivated_at TEXT;

/* すでに外してある人は、今日外したことにしておく */
UPDATE staff SET deactivated_at = datetime('now') WHERE active = 0 AND deactivated_at IS NULL;
