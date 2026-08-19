import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { categories, type CategoryRow } from "../db/schema.js";

// 分类数据访问层：按 用户 + 账本 隔离。
export function listCategoriesForUser(db: DB, userId: string, ledgerId: string): CategoryRow[] {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.ledgerId, ledgerId)))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
    .all();
}

export function categoryMap(db: DB, userId: string, ledgerId: string): Map<string, CategoryRow> {
  return new Map(listCategoriesForUser(db, userId, ledgerId).map((c) => [c.id, c]));
}

export function categoryNameMap(db: DB, userId: string, ledgerId: string): Map<string, string> {
  return new Map(listCategoriesForUser(db, userId, ledgerId).map((c) => [c.id, c.name]));
}

export function categoryById(db: DB, userId: string, ledgerId: string, id: string): CategoryRow | undefined {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, userId), eq(categories.ledgerId, ledgerId)))
    .get();
}
