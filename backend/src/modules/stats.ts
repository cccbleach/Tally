import type { FastifyInstance } from "fastify";
import type { AppDb } from "../db/client.js";
import { getUserId, makeAuth } from "../middleware/auth.js";
import { getLedgerId } from "../lib/ledger.js";
import { getAccessibleLedger } from "../lib/access.js";
import {
  assetDebtSummary,
  dailyTotals,
  expenseByAccount,
  expenseByCategory,
  monthlyTotals,
  trend,
} from "../lib/aggregates.js";
import { currentYearMonth } from "../lib/date.js";
import type { Jwt } from "../auth/jwt.js";

export function registerStatsRoutes(app: FastifyInstance, deps: { db: AppDb["db"]; jwt: Jwt }) {
  const { db } = deps;
  const auth = makeAuth(deps.jwt);

  app.get("/api/v1/stats/summary", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const cur = currentYearMonth();
    const year = Number(q.year ?? cur.year) || cur.year;
    const month = Number(q.month ?? cur.month) || cur.month;

    const totals = monthlyTotals(db, userId, ledgerId, year, month);
    const ad = assetDebtSummary(db, userId, ledgerId);

    const byCategory = expenseByCategory(db, userId, ledgerId, year, month).map((c) => ({
      ...c,
      percent: totals.expense > 0 ? Math.round((c.amount / totals.expense) * 1000) / 10 : 0,
    }));
    const byAccount = expenseByAccount(db, userId, ledgerId, year, month);
    const daily = dailyTotals(db, userId, ledgerId, year, month);

    return {
      year,
      month,
      income: totals.income,
      expense: totals.expense,
      net: totals.income - totals.expense,
      balance: ad.net,
      totalAssets: ad.assets,
      totalDebt: ad.debts,
      byCategory,
      byAccount,
      daily,
    };
  });

  app.get("/api/v1/stats/trend", { preHandler: auth }, async (req) => {
    const userId = getUserId(req);
    const q = req.query as Record<string, string | undefined>;
    const ledgerId = getAccessibleLedger(db, userId, q.ledgerId).id;
    const months = Math.max(1, Math.min(60, Number(q.months ?? 6) || 6));
    return { months: trend(db, userId, ledgerId, months) };
  });
}
