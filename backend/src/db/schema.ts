import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  defaultLedgerId: text("default_ledger_id"),
  currentLedgerId: text("current_ledger_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    deviceName: text("device_name"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_auth_sessions_user").on(t.userId),
    uniqueIndex("uniq_auth_sessions_refresh").on(t.refreshTokenHash),
  ],
);

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_password_reset_user").on(t.userId),
    uniqueIndex("uniq_password_reset_token").on(t.tokenHash),
  ],
);

export const ledgers = sqliteTable(
  "ledgers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    familyId: text("family_id"), // NULL=个人账本；非空=家庭共享账本
    name: text("name").notNull(),
    currency: text("currency").notNull().default("CNY"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"), // 家庭删除后原家庭账本软删除：数据保留但任何人不可访问
  },
  (t) => [index("idx_ledgers_user").on(t.userId), index("idx_ledgers_family").on(t.familyId)],
);

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_families_owner").on(t.ownerUserId)],
);

export const familyMembers = sqliteTable(
  "family_members",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"), // owner | admin | member | viewer
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    joinedAt: text("joined_at").notNull(),
  },
  (t) => [uniqueIndex("uniq_family_member").on(t.familyId, t.userId)],
);

export const familyInvitations = sqliteTable(
  "family_invitations",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id").notNull(),
    inviterUserId: text("inviter_user_id").notNull(),
    targetAccountHash: text("target_account_hash").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"), // pending | accepted | declined | revoked
    expiresAt: text("expires_at").notNull(),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_family_invites_family").on(t.familyId),
    index("idx_family_invites_target").on(t.targetAccountHash),
    index("idx_family_invites_token").on(t.tokenHash),
  ],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ledgerId: text("ledger_id"),
    name: text("name").notNull(),
    type: text("type").notNull().default("other"),
    currency: text("currency").notNull().default("CNY"),
    initialBalance: integer("initial_balance").notNull().default(0),
    icon: text("icon"),
    color: text("color"),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    creditLimit: integer("credit_limit"),       // 信用卡额度（分）
    billingDay: integer("billing_day"),         // 账单日 1-28
    repaymentDay: integer("repayment_day"),     // 还款日 1-28
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_accounts_user").on(t.userId), index("idx_accounts_ledger").on(t.ledgerId)],
);

export const loans = sqliteTable(
  "loans",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ledgerId: text("ledger_id"),
    name: text("name").notNull(),
    type: text("type").notNull().default("other"), // car | mortgage | other
    currency: text("currency").notNull().default("CNY"),
    principal: integer("principal").notNull(),      // 分
    annualRate: real("annual_rate").notNull().default(0),
    termMonths: integer("term_months").notNull(),
    startDate: text("start_date").notNull(),
    monthlyPayment: integer("monthly_payment").notNull().default(0),
    remainingPrincipal: integer("remaining_principal").notNull(),
    accountId: text("account_id"),                  // 还款来源账户（银行卡/现金）
    liabilityAccountId: text("liability_account_id"), // 贷款负债账户（type=loan）
    repaymentMethod: text("repayment_method").notNull().default("equal_installment"),
    status: text("status").notNull().default("active"), // active | paid_off | closed
    nextPaymentDate: text("next_payment_date"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_loans_ledger").on(t.ledgerId)],
);

export const loanPayments = sqliteTable(
  "loan_payments",
  {
    id: text("id").primaryKey(),
    loanId: text("loan_id").notNull(),
    installmentNo: integer("installment_no").notNull(),
    dueDate: text("due_date").notNull(),
    principalDue: integer("principal_due").notNull(),
    interestDue: integer("interest_due").notNull(),
    principalPaid: integer("principal_paid").notNull().default(0),
    interestPaid: integer("interest_paid").notNull().default(0),
    total: integer("total").notNull(),
    paid: integer("paid", { mode: "boolean" }).notNull().default(false),
    paidAt: text("paid_at"),
    paymentTransactionId: text("payment_transaction_id"),
    status: text("status").notNull().default("pending"), // pending | paid
  },
  (t) => [
    index("idx_loan_payments_loan").on(t.loanId),
    uniqueIndex("uniq_loan_payment_installment").on(t.loanId, t.installmentNo),
  ],
);

export const creditCardBills = sqliteTable(
  "credit_card_bills",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    period: text("period").notNull(), // YYYY-MM
    statementBalance: integer("statement_balance").notNull(),
    minimumPayment: integer("minimum_payment").notNull().default(0),
    dueDate: text("due_date"),
    paid: integer("paid", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("idx_cc_bills_account").on(t.accountId)],
);

export const loanPaymentIdempotency = sqliteTable(
  "loan_payment_idempotency",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    loanId: text("loan_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull().default("completed"), // completed
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uniq_loan_pay_idem").on(t.actorUserId, t.loanId, t.idempotencyKey),
    index("idx_loan_pay_idem_loan").on(t.loanId),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ledgerId: text("ledger_id"),
    name: text("name").notNull(),
    type: text("type").notNull(), // income | expense
    icon: text("icon"),
    color: text("color"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_categories_user").on(t.userId), index("idx_categories_ledger").on(t.ledgerId)],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ledgerId: text("ledger_id"),
    accountId: text("account_id").notNull(),
    categoryId: text("category_id"),
    type: text("type").notNull(), // income | expense | transfer
    amount: integer("amount").notNull(), // 分，恒为正
    currency: text("currency").notNull().default("CNY"),
    note: text("note"),
    date: text("date").notNull(), // YYYY-MM-DD
    transferToAccountId: text("transfer_to_account_id"),
    recurringId: text("recurring_id"), // 周期账单生成关联，用于幂等
    externalId: text("external_id"), // 账单导入来源唯一号，用于去重
    sourceType: text("source_type"), // manual | wechat | alipay | bank | import
    dedupKey: text("dedup_key"), // 跨来源指纹（日期+金额+币种+规范化商家）
    linkedTransactionId: text("linked_transaction_id"), // 人工关联的目标流水
    paymentGroupId: text("payment_group_id"), // 一次还款拆分出的多条流水的分组关联
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_tx_user_date").on(t.userId, t.date),
    index("idx_tx_user_account").on(t.userId, t.accountId),
    index("idx_tx_ledger").on(t.ledgerId),
    uniqueIndex("uniq_recurring_tx").on(t.recurringId, t.date), // 幂等唯一（NULL 互不冲突）
    uniqueIndex("uniq_tx_external_source").on(t.ledgerId, t.sourceType, t.externalId), // 硬去重：同账本同来源同外部 ID（NULL 互不冲突）
    index("idx_tx_dedup").on(t.ledgerId, t.dedupKey), // 软去重指纹（不唯一，允许同商家同金额正常消费共存）
  ],
);

export const budgets = sqliteTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ledgerId: text("ledger_id"),
    year: integer("year").notNull(),
    month: integer("month").notNull(), // 1-12
    categoryId: text("category_id"), // null = 总预算
    amount: integer("amount").notNull(), // 分
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_budgets_user").on(t.userId, t.year, t.month),
    index("idx_budgets_ledger").on(t.ledgerId),
    // 与迁移 0019 保持一致：预算唯一性作用于账本（ledger_id + year + month + category_id），
    // category_id=NULL 表示总预算（部分唯一索引）。
    uniqueIndex("uniq_budget_total").on(t.ledgerId, t.year, t.month).where(sql`${t.categoryId} IS NULL`),
    uniqueIndex("uniq_budget_cat").on(t.ledgerId, t.year, t.month, t.categoryId).where(sql`${t.categoryId} IS NOT NULL`),
  ],
);

export const recurring = sqliteTable(
  "recurring",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    ledgerId: text("ledger_id"),
    accountId: text("account_id").notNull(),
    categoryId: text("category_id"),
    type: text("type").notNull(), // income | expense
    amount: integer("amount").notNull(), // 分
    note: text("note"),
    frequency: text("frequency").notNull(), // daily | weekly | monthly | yearly
    interval: integer("interval").notNull().default(1),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    nextRunDate: text("next_run_date").notNull(),
    lastGeneratedDate: text("last_generated_date"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_recurring_user").on(t.userId), index("idx_recurring_ledger").on(t.ledgerId)],
);

export const exchangeRates = sqliteTable(
  "exchange_rates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"), // NULL = 全局默认汇率
    baseCurrency: text("base_currency").notNull(),
    currency: text("currency").notNull(),
    rate: real("rate").notNull(), // 1 unit currency = rate base
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uniq_rate_user").on(t.userId, t.baseCurrency, t.currency),
    uniqueIndex("uniq_rate_global").on(t.baseCurrency, t.currency),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id"),
    actorUserId: text("actor_user_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_audit_ledger").on(t.ledgerId),
    index("idx_audit_entity").on(t.entityType, t.entityId),
    index("idx_audit_actor").on(t.actorUserId),
  ],
);

export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    ledgerId: text("ledger_id").notNull(),
    userId: text("user_id").notNull(),
    source: text("source").notNull(),
    filename: text("filename"),
    fileHash: text("file_hash"),
    status: text("status").notNull().default("staged"),
    totalCount: integer("total_count").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_import_jobs_ledger").on(t.ledgerId)],
);

export const importItems = sqliteTable(
  "import_items",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    accountId: text("account_id"),
    categoryId: text("category_id"),
    externalId: text("external_id"),
    occurredAt: text("occurred_at").notNull(),
    type: text("type").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("CNY"),
    merchant: text("merchant"),
    rawDescription: text("raw_description"),
    dedupKey: text("dedup_key"),
    source: text("source"),
    duplicateStatus: text("duplicate_status").notNull().default("new"),
    duplicateScore: integer("duplicate_score").notNull().default(0),
    matchedTransactionId: text("matched_transaction_id"),
    decision: text("decision").notNull().default("accept"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_import_items_job").on(t.jobId)],
);

export type UserRow = typeof users.$inferSelect;
export type LedgerRow = typeof ledgers.$inferSelect;
export type FamilyRow = typeof families.$inferSelect;
export type FamilyMemberRow = typeof familyMembers.$inferSelect;
export type LoanRow = typeof loans.$inferSelect;
export type LoanPaymentRow = typeof loanPayments.$inferSelect;
export type CreditCardBillRow = typeof creditCardBills.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type RecurringRow = typeof recurring.$inferSelect;
