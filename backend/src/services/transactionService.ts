import type { DB } from "../db/client.js";
import { listCategoriesForUser } from "../repositories/categoryRepository.js";

// 流水 DTO 需要分类的展示信息，统一在这里组装，避免各路由重复实现。
export interface RelationMaps {
  cm: Map<string, { id: string; name: string; icon: string | null; color: string | null }>;
}

export function loadRelationMaps(db: DB, userId: string, ledgerId: string): RelationMaps {
  const categories = listCategoriesForUser(db, userId, ledgerId);
  return {
    cm: new Map(
      categories.map((c) => [c.id, { id: c.id, name: c.name, icon: c.icon, color: c.color }]),
    ),
  };
}
