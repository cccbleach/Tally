-- mode: fk-off
-- 多币种与汇率下线：全站收敛为人民币（CNY）单币种。
--
-- 产品决策：这 App 只做记账。币种与汇率属于长期无人使用的复杂度，生产库实测：
-- exchange_rates 0 行、外币账户 0 个、非 CNY 流水仅 2 条（HKD），因此代码
-- （src/lib/currency.ts、src/lib/exchangeRateFetcher.ts）、配置（BASE_CURRENCY、
-- EXCHANGE_RATE_FETCH_ENABLED、EXCHANGE_RATE_FETCH_URL）、接口字段、iOS 币种选择器
-- 与库表列一并移除。
--
-- ⚠️ 本迁移**会改写金额**（非 CNY 金额折算成 CNY），且 DROP COLUMN 不可逆：
-- 执行前必须先做部署前备份（pre- 备份，见 docs/production-deploy.md）。
-- 回滚 = 还原备份 + 回滚代码；只回滚代码不够（旧代码会读写 currency 列）。
--
-- 折算规则（只作用于 currency <> 'CNY' 的账户初始余额与流水金额，行数不变）：
--   1) 优先取 exchange_rates 里该用户的 CNY 汇率，其次全局汇率——与旧 getRate 的查找顺序一致；
--   2) 没有汇率记录则用旧代码里的内置兜底表（USD 7.2 / EUR 7.8 / GBP 9.1 / JPY 0.05 /
--      HKD 0.92 / KRW 0.0054 / SGD 5.3 / AUD 4.7 / CAD 5.2，未知币种 1:1）；
--   3) 折算结果不足 1 分时按 1 分下限，避免撞上 transactions 的 CHECK (amount > 0)；
--   4) 原始币种与原始金额追加进备注（如「（原 HKD 5000.00，已按 1 HKD = 0.92 CNY 折算）」），
--      折算过程可追溯；日期、账户归属、分类、转账关系全部不变；
--   5) 被折算流水的 dedup_key 置空：指纹含金额与币种，折算后旧指纹必然失真（硬去重靠
--      external_id，不受影响）。external_id 保持原样——它是来源账单的原始标识，不是本项目生成的语义。
--
-- 生产实测（部署前只读预检，2026-09 部署窗口）：
--   非 CNY 流水 2 条，均为 2026-02-10 的 HKD 5000.00（一收一支：结售汇即时售汇 / 柜台取现），
--   折算后各为 CNY 4600.00；exchange_rates 0 行（因此走内置兜底 0.92）；非 CNY 账户 0 个。
--
-- import_items 是历史导入暂存记录（这批明细早已提交成正式流水），只删列、不改金额：
-- 它记录的是"当时导入的样子"，改数字反而会篡改历史。

-- ---------- 1) 流水的折算计划与执行 ----------
CREATE TEMP TABLE _cny_plan_tx AS
SELECT t.id AS id,
       t.currency AS old_currency,
       t.amount AS old_amount,
       COALESCE(
         (SELECT rate FROM exchange_rates WHERE base_currency = 'CNY' AND currency = t.currency AND user_id = t.user_id),
         (SELECT rate FROM exchange_rates WHERE base_currency = 'CNY' AND currency = t.currency AND user_id IS NULL),
         CASE t.currency
           WHEN 'USD' THEN 7.2 WHEN 'EUR' THEN 7.8 WHEN 'GBP' THEN 9.1 WHEN 'JPY' THEN 0.05
           WHEN 'HKD' THEN 0.92 WHEN 'KRW' THEN 0.0054 WHEN 'SGD' THEN 5.3
           WHEN 'AUD' THEN 4.7 WHEN 'CAD' THEN 5.2 ELSE 1 END
       ) AS rate,
       NULL AS new_amount
  FROM transactions t
 WHERE t.currency <> 'CNY';

UPDATE _cny_plan_tx SET new_amount = MAX(1, CAST(ROUND(old_amount * rate) AS INTEGER));

UPDATE transactions
   SET amount = (SELECT p.new_amount FROM _cny_plan_tx p WHERE p.id = transactions.id),
       dedup_key = NULL,
       note = COALESCE(note || ' ', '')
              || '（原 ' || (SELECT p.old_currency FROM _cny_plan_tx p WHERE p.id = transactions.id)
              || ' ' || printf('%.2f', (SELECT p.old_amount FROM _cny_plan_tx p WHERE p.id = transactions.id) / 100.0)
              || '，已按 1 ' || (SELECT p.old_currency FROM _cny_plan_tx p WHERE p.id = transactions.id)
              || ' = ' || printf('%g', (SELECT p.rate FROM _cny_plan_tx p WHERE p.id = transactions.id))
              || ' CNY 折算）'
 WHERE id IN (SELECT id FROM _cny_plan_tx);

-- ---------- 2) 账户初始余额的折算 ----------
CREATE TEMP TABLE _cny_plan_acct AS
SELECT a.id AS id,
       a.currency AS old_currency,
       a.initial_balance AS old_amount,
       COALESCE(
         (SELECT rate FROM exchange_rates WHERE base_currency = 'CNY' AND currency = a.currency AND user_id = a.user_id),
         (SELECT rate FROM exchange_rates WHERE base_currency = 'CNY' AND currency = a.currency AND user_id IS NULL),
         CASE a.currency
           WHEN 'USD' THEN 7.2 WHEN 'EUR' THEN 7.8 WHEN 'GBP' THEN 9.1 WHEN 'JPY' THEN 0.05
           WHEN 'HKD' THEN 0.92 WHEN 'KRW' THEN 0.0054 WHEN 'SGD' THEN 5.3
           WHEN 'AUD' THEN 4.7 WHEN 'CAD' THEN 5.2 ELSE 1 END
       ) AS rate,
       NULL AS new_amount
  FROM accounts a
 WHERE a.currency <> 'CNY';

UPDATE _cny_plan_acct SET new_amount = CAST(ROUND(old_amount * rate) AS INTEGER);

UPDATE accounts
   SET initial_balance = (SELECT p.new_amount FROM _cny_plan_acct p WHERE p.id = accounts.id)
 WHERE id IN (SELECT id FROM _cny_plan_acct);

DROP TABLE _cny_plan_tx;
DROP TABLE _cny_plan_acct;

-- ---------- 3) 汇率表与币种列下线 ----------
-- 账户/流水/账本/导入暂存的 currency 列都不参与任何索引、触发器、CHECK 或外键，
-- 因此可以直接 DROP COLUMN；父表（ledgers/accounts/transactions）被引用也不影响，
-- 模式仍用 fk-off + 迁移后的 PRAGMA foreign_key_check 做完整性复核（见 runner.ts）。
DROP TABLE IF EXISTS exchange_rates;

ALTER TABLE ledgers DROP COLUMN currency;
ALTER TABLE accounts DROP COLUMN currency;
ALTER TABLE transactions DROP COLUMN currency;
ALTER TABLE import_items DROP COLUMN currency;
