-- 预算域下线：删除 budgets 表。
--
-- 产品决策：这 App 只做记账（流水 / 账户 / 分类 / 统计 / 周期账单 / 共享账本）。
-- 预算功能在生产中零使用——部署前只读预检实测 budgets 表 0 行——因此代码、接口、
-- iOS 页面（预算 tab）、OpenAPI 契约与库表一并移除，避免长期维护无人使用的功能。
--
-- ⚠️ DROP TABLE 不可逆：执行前必须先做部署前备份（pre- 备份，见 docs/production-deploy.md）。
-- 回滚方式：还原备份文件 + 代码回滚到上一个 release；只回滚代码不够——旧代码会查询 budgets 表。
--
-- 为什么不需要 -- mode: fk-off：budgets 是**子表**（外键指向 users / ledgers / categories），
-- 且没有任何表反向引用它（无入向外键）。SQLite 删除子表不影响父表约束完整性。
-- 表上的 4 个索引（idx_budgets_user / idx_budgets_ledger / uniq_budget_total / uniq_budget_cat）
-- 随表一并删除，无需单独 DROP INDEX。

DROP TABLE IF EXISTS budgets;
