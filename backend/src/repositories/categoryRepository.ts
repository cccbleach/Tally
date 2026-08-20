import { and, asc, eq } from "drizzle-orm";
import type { DB } from "../db/client.js";
import { categories, type CategoryRow } from "../db/schema.js";

// 分类数据访问层：按账本访问（访问控制已在路由层校验）。
export function listCategoriesForUser(db: DB, _userId: string, ledgerId: string): CategoryRow[] {
  return db
    .select()
    .from(categories)
    .where(eq(categories.ledgerId, ledgerId))
    .orderBy(asc(categories.sortOrder), asc(categories.createdAt))
    .all();
}

export function categoryMap(db: DB, userId: string, ledgerId: string): Map<string, CategoryRow> {
  return new Map(listCategoriesForUser(db, userId, ledgerId).map((c) => [c.id, c]));
}

export function categoryNameMap(db: DB, userId: string, ledgerId: string): Map<string, string> {
  return new Map(listCategoriesForUser(db, userId, ledgerId).map((c) => [c.id, c.name]));
}

export function categoryById(db: DB, _userId: string, ledgerId: string, id: string): CategoryRow | undefined {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.ledgerId, ledgerId)))
    .get();
}
