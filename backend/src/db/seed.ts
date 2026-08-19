import { randomUUID } from "node:crypto";
import type { DB } from "./client.js";
import { categories } from "./schema.js";

export interface DefaultCategory {
  name: string;
  type: "income" | "expense";
  icon: string;
  color: string;
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: "餐饮", type: "expense", icon: "fork.knife", color: "#FF6B6B" },
  { name: "交通", type: "expense", icon: "car.fill", color: "#4D96FF" },
  { name: "购物", type: "expense", icon: "cart.fill", color: "#FF9F43" },
  { name: "居住", type: "expense", icon: "house.fill", color: "#6C5CE7" },
  { name: "娱乐", type: "expense", icon: "gamecontroller.fill", color: "#00B894" },
  { name: "医疗", type: "expense", icon: "cross.case.fill", color: "#E17055" },
  { name: "教育", type: "expense", icon: "book.fill", color: "#0984E3" },
  { name: "人情", type: "expense", icon: "gift.fill", color: "#FD79A8" },
  { name: "其他支出", type: "expense", icon: "ellipsis.circle.fill", color: "#636E72" },
  { name: "工资", type: "income", icon: "banknote.fill", color: "#00B894" },
  { name: "理财", type: "income", icon: "chart.line.uptrend.xyaxis", color: "#0984E3" },
  { name: "其他收入", type: "income", icon: "ellipsis.circle.fill", color: "#636E72" },
];

export function seedDefaultCategories(db: DB, userId: string, ledgerId: string): void {
  const now = new Date().toISOString();
  const rows = DEFAULT_CATEGORIES.map((c, i) => ({
    id: randomUUID(),
    userId,
    ledgerId,
    name: c.name,
    type: c.type,
    icon: c.icon,
    color: c.color,
    sortOrder: i,
    createdAt: now,
  }));
  db.insert(categories).values(rows).run();
}
