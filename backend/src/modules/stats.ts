import type { FastifyInstance } from "fastify";
import type { AppDb } from "../db/client.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { getAccessibleLedger } from "../lib/access.js";
import {
  ledgerCumulativeNet,
  dailyTotals,
  expenseByCategory,
  monthlyTotals,
  trend,
} from "../lib/aggregates.js";
import { currentYearMonth } from "../lib/date.js";
import { parseYearMonthQuery } from "../lib/schemas.js";
import type { Jwt } from "../auth/jwt.js";

export function registerStatsRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/stats/summary", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const cur = currentYearMonth();
    const { year, month } = parseYearMonthQuery(q, cur);

    const totals = monthlyTotals(db, ledgerId, year, month);
    const cumulativeNet = ledgerCumulativeNet(db, ledgerId);

    const byCategory = expenseByCategory(db, ledgerId, year, month).map((c) => ({
      ...c,
      percent: totals.expense > 0 ? Math.round((c.amount / totals.expense) * 1000) / 10 : 0,
    }));
    const daily = dailyTotals(db, ledgerId, year, month);

    return {
      year,
      month,
      income: totals.income,
      expense: totals.expense,
      net: totals.income - totals.expense,
      // 累计结余：历史收入 − 支出（账户域下线后替代 balance/totalAssets 的口径）
      cumulativeNet,
      byCategory,
      daily,
    };
  });

  app.get("/api/v1/stats/trend", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const months = Math.max(1, Math.min(60, Number(q.months ?? 6) || 6));
    return { months: trend(db, ledgerId, months) };
  });
}
