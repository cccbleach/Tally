import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    role: text("role").notNull().default("member"), // owner | admin | member
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    joinedAt: text("joined_at").notNull(),
  },
  (t) => [uniqueIndex("uniq_family_member").on(t.familyId, t.userId)],
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
    principal: integer("principal").notNull(),      // 分
    annualRate: real("annual_rate").notNull().default(0),
    termMonths: integer("term_months").notNull(),
    startDate: text("start_date").notNull(),
    monthlyPayment: integer("monthly_payment").notNull().default(0),
    remainingPrincipal: integer("remaining_principal").notNull(),
    accountId: text("account_id"),
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
    scheduledDate: text("scheduled_date").notNull(),
    principalPart: integer("principal_part").notNull(),
    interestPart: integer("interest_part").notNull(),
    total: integer("total").notNull(),
    paid: integer("paid", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("idx_loan_payments_loan").on(t.loanId)],
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
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_tx_user_date").on(t.userId, t.date),
    index("idx_tx_user_account").on(t.userId, t.accountId),
    index("idx_tx_ledger").on(t.ledgerId),
    uniqueIndex("uniq_recurring_tx").on(t.recurringId, t.date), // 幂等唯一（NULL 互不冲突）
    uniqueIndex("uniq_tx_external").on(t.userId, t.externalId), // 账单导入来源内去重（NULL 互不冲突）
    uniqueIndex("uniq_tx_dedup").on(t.ledgerId, t.dedupKey), // 跨来源去重（NULL 互不冲突）
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
  (t) => [index("idx_budgets_user").on(t.userId, t.year, t.month), index("idx_budgets_ledger").on(t.ledgerId)],
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
