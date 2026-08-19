import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  defaultLedgerId: text("default_ledger_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const ledgers = sqliteTable(
  "ledgers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    currency: text("currency").notNull().default("CNY"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_ledgers_user").on(t.userId)],
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
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_accounts_user").on(t.userId), index("idx_accounts_ledger").on(t.ledgerId)],
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
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_tx_user_date").on(t.userId, t.date),
    index("idx_tx_user_account").on(t.userId, t.accountId),
    index("idx_tx_ledger").on(t.ledgerId),
    uniqueIndex("uniq_recurring_tx").on(t.recurringId, t.date), // 幂等唯一（NULL 互不冲突）
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
export type AccountRow = typeof accounts.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type RecurringRow = typeof recurring.$inferSelect;
