/* =========================================================
   スタッフとLINEアカウントを結びつけるための変更
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

/* LINEのユーザーID（LINEが1人ずつに振る番号。名前が変わっても変わらない） */
ALTER TABLE staff ADD COLUMN line_user_id TEXT;

/* 結びつけたときのLINEの表示名（作成担当が確認するため） */
ALTER TABLE staff ADD COLUMN line_name TEXT;

/* 同じLINEアカウントが2人分の名前に結びつかないようにする */
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_line_user_id
  ON staff (line_user_id) WHERE line_user_id IS NOT NULL;
