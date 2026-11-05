/* =========================================================
   下書きの保存
   ・スタッフ：提出する前に、途中まで入れた希望を「下書き」として保存できる
   ・シフト作成：だれがいつ最後に変えたかを残す
   ※ コンソールに貼り付けても動くよう、コメントはスラッシュとアスタリスクで囲む形
   ========================================================= */

/* 提出した日時（空のままなら「下書き」。作成担当には未提出として扱う） */
ALTER TABLE submissions ADD COLUMN submitted_at TEXT;

/* これまでのものは、すべて提出済みとして扱う */
UPDATE submissions SET submitted_at = updated_at WHERE submitted_at IS NULL;

/* シフトの下書きを最後に変えた管理者の名前 */
ALTER TABLE schedules ADD COLUMN updated_by TEXT;
