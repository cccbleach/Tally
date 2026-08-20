-- 导入暂存流程（阶段 3）：上传/解析后先进入 import_jobs/items，用户预览确认后再批量提交正式流水
CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,                -- wechat | alipay | bank | items
  filename TEXT,
  file_hash TEXT,
  status TEXT NOT NULL DEFAULT 'staged', -- staged | committed | failed
  total_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_import_jobs_ledger ON import_jobs(ledger_id);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  external_id TEXT,
  occurred_at TEXT NOT NULL,           -- YYYY-MM-DD
  type TEXT NOT NULL,                  -- income | expense
  amount INTEGER NOT NULL,             -- 分
  currency TEXT NOT NULL DEFAULT 'CNY',
  merchant TEXT,
  raw_description TEXT,
  duplicate_status TEXT NOT NULL DEFAULT 'new', -- new | suspected | duplicate
  matched_transaction_id TEXT,
  decision TEXT NOT NULL DEFAULT 'accept',      -- accept | skip
  created_at TEXT NOT NULL
);
CREATE INDEX idx_import_items_job ON import_items(job_id);
