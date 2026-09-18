-- 负债域下线：删除贷款/信用卡相关的表与账户列。
--
-- 产品决策：这 App 只做记账（流水 / 账户 / 分类 / 统计 / 预算 / 周期账单 / 共享账本）。
-- 负债管理（贷款等额本息计划、信用卡账单与还款）在生产中零使用
-- （loans / loan_payments / loan_payment_idempotency / credit_card_bills 全部 0 行），
-- 因此代码、接口、iOS 页面与库表一并移除，避免长期维护两套无数据的复杂逻辑。
--
-- ⚠️ DROP TABLE 不可逆：执行前必须先做备份（部署前的 pre-<版本> 备份）。
-- 回滚方式：还原备份文件；代码回滚到上一个 release 即可（旧代码能跑在没有这些表的库上吗？
-- 不能 —— 旧代码会查询这些表，因此回滚必须同时还原备份）。

DROP TABLE IF EXISTS loan_payment_idempotency;
DROP TABLE IF EXISTS loan_payments;
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS credit_card_bills;

-- 账户上的信用卡专用列（额度/账单日/还款日）
ALTER TABLE accounts DROP COLUMN credit_limit;
ALTER TABLE accounts DROP COLUMN billing_day;
ALTER TABLE accounts DROP COLUMN repayment_day;

-- 账户类型枚举收紧为 cash/bank/e-wallet/other：
-- 历史数据里可能存在的 credit/loan 账户（本来是负债账户）统一归到 other，
-- 避免应用层枚举校验与存量数据不一致。生产库实测没有这类账户（唯一账户是 other），
-- 这条 UPDATE 是为其他环境兜底。
UPDATE accounts SET type = 'other' WHERE type IN ('credit', 'loan');
