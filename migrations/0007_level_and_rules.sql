/* =========================================================
   スタッフのレベル と 毎日のルール
   どちらも作成担当だけが設定・確認する（スタッフ側の画面には出さない）
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

/* レベル：'new'=新人 / 'regular'=通常 / 'veteran'=ベテラン / NULL=未設定 */
ALTER TABLE staff ADD COLUMN level TEXT CHECK (level IN ('new', 'regular', 'veteran'));

/* アプリ全体の設定（毎日のルールなど）を「名前 → 値」の形で入れておく */
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,     /* 値はJSONの文字列で入れる */
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
