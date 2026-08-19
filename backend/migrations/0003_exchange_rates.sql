-- 汇率表：用户可覆盖（user_id 非空），缺省走全局（user_id 为空）
-- rate 表示 1 unit currency = rate base_currency
CREATE TABLE exchange_rates (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  base_currency TEXT NOT NULL,
  currency TEXT NOT NULL,
  rate REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_rate_user ON exchange_rates(user_id, base_currency, currency);
CREATE UNIQUE INDEX uniq_rate_global ON exchange_rates(base_currency, currency) WHERE user_id IS NULL;
