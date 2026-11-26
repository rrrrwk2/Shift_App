/* 提出の控え（LINE）を何回送ったか。1人1か月の上限を数えるため（LINEの「月200通まで」を1人に使い切られないように） */
ALTER TABLE submissions ADD COLUMN receipts_sent INTEGER NOT NULL DEFAULT 0;
