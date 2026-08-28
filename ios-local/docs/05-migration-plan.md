# Tally SwiftData 迁移计划

## 当前基线

- 当前生产模型标识：`TallySchemaV1`，版本 `1.0.0`。
- `PersistenceController` 使用显式 `Schema(versionedSchema:)` 和 `TallyMigrationPlan` 创建容器。
- V1 没有迁移 stage；它是以后升级的固定起点。
- 数据库初始化失败时 App 只展示错误，不删除、覆盖或自动重建用户 store。

## 哪些改动必须新建 schema 版本

新增/删除/改名持久字段，改变类型、可选性、唯一约束、关系、inverse 或 delete rule，都必须新建 V2。纯 UI、计算属性、Service 和非持久 AppState 变化不需要 schema 版本。

## V2 实施步骤

1. 发布 V1 后冻结其模型声明；不要回改历史 schema。
2. 新建 `TallySchemaV2: VersionedSchema`，版本号设为 `2.0.0`，声明 V2 模型。
3. 只涉及可推导的新增可选字段/默认值等变化时，添加 `.lightweight(fromVersion:toVersion:)`。
4. 需要转换、拆分、合并或回填数据时，添加 `.custom` stage，在 `willMigrate`/`didMigrate` 中做确定性转换；禁止网络依赖。
5. 将 `[TallySchemaV1.self, TallySchemaV2.self]` 和 stage 按顺序加入 `TallyMigrationPlan`。
6. 先复制一份旧数据库做测试；迁移失败必须保留原文件，并向用户显示可操作错误。
7. 若同时升级 `BackupDocument`，增加独立 DTO 版本转换；不能把数据库迁移和备份格式版本混为一谈。

## 必须通过的升级测试

- 用最后一个 V1 build 创建包含两个账本、账户、分类、四种交易、退款关联、预算、归档账户与软删除交易的真实 SQLite store。
- 用 V2 build 原地打开，确认所有 ID、关系、金额、币种、默认账本和设置保持一致。
- 对升级后数据运行余额、统计和预算断言。
- 再次启动验证迁移不会重复执行或生成重复数据。
- 模拟无效/不支持的新版本备份，确认拒绝且原 store 不变。
- 至少覆盖 Debug、Release、模拟器和一台真机；迁移前保存数据库副本与测试日志。

## 回滚与发布规则

- App 不提供“降级数据库”。发现迁移问题时停止发布，用修复后的更高 build 继续向前迁移。
- 绝不以删除 store 作为自动恢复手段。用户可选择从此前导出的 JSON 备份恢复，但必须经过确认。
- 每次改 schema 的 PR 必须同时包含 migration stage、旧库 fixture/生成步骤、升级测试和文档变更，否则不得合并。

参考：[Apple SchemaMigrationPlan](https://developer.apple.com/documentation/swiftdata/schemamigrationplan)。
