-- mode: fk-off
-- 负债域残留列清理：删除 transactions.payment_group_id。
--
-- 背景：0015 引入 payment_group_id，用于把一次贷款还款拆成「本金转账 + 利息支出」两条流水后
-- 仍能追溯到同一组。负债域已在 0025 整体下线，该列再没有任何写入方（DTO 里还透传着，
-- 但永远是 NULL），属于死字段。生产实测：payment_group_id 非空行 0 条（迁移前只读预检）。
--
-- ⚠️ DROP COLUMN 不可逆：执行前已有部署前备份（与 0027 同一次部署窗口）。
-- 回滚 = 还原备份 + 回滚代码。
--
-- 该列不参与任何索引、触发器、CHECK 或外键；transactions 是 import_items.matched_transaction_id
-- 的父表，因此仍走 fk-off 模式，由 runner 在迁移后做 PRAGMA foreign_key_check 复核。

ALTER TABLE transactions DROP COLUMN payment_group_id;
