// better-sqlite3 约束冲突判定。
//
// 关键坑（本项目踩过）：SQLite 的唯一约束报错文本只列「表.列」，**不含索引名**：
//   实测 message = "UNIQUE constraint failed: transactions.ledger_id, transactions.client_request_id"
// 因此 `message.includes("uniq_tx_client_request")` 这类按索引名匹配的写法永远不成立，
// 兜底分支会变成死代码（真并发冲突时向上抛 500，而不是返回已入账的结果）。
// 正确做法是看 better-sqlite3 暴露的 err.code，必要时再用列名收窄。
export function isUniqueViolation(e: unknown, columns?: readonly string[]): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as { code?: unknown }).code;
  if (code !== "SQLITE_CONSTRAINT_UNIQUE" && code !== "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return false;
  }
  if (!columns || columns.length === 0) return true;
  return columns.every((c) => e.message.includes(c));
}
