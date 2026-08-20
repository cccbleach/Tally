import { addMonths } from "./date.js";

export interface LoanScheduleItem {
  date: string; // YYYY-MM-DD
  principalPart: number; // 分
  interestPart: number; // 分
  total: number; // 分
  remaining: number; // 分
}

// 等额本息月供（分）
export function monthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  if (termMonths <= 0) return 0;
  if (annualRate <= 0) return Math.round(principal / termMonths);
  const r = annualRate / 100 / 12;
  const factor = Math.pow(1 + r, termMonths);
  return Math.round((principal * r * factor) / (factor - 1));
}

// 生成等额本息还款计划
export function amortizationSchedule(
  principal: number,
  annualRate: number,
  termMonths: number,
  startDate: string,
): LoanScheduleItem[] {
  const payment = monthlyPayment(principal, annualRate, termMonths);
  const r = annualRate > 0 ? annualRate / 100 / 12 : 0;
  let remaining = principal;
  let cursor = startDate;
  const items: LoanScheduleItem[] = [];
  for (let i = 0; i < termMonths; i++) {
    const interest = Math.round(remaining * r);
    let principalPart = payment - interest;
    if (principalPart > remaining) principalPart = remaining;
    const total = principalPart + interest;
    remaining -= principalPart;
    items.push({
      date: cursor,
      principalPart,
      interestPart: interest,
      total,
      remaining: remaining < 0 ? 0 : remaining,
    });
    cursor = addMonths(cursor, 1);
  }
  return items;
}

// 把某个日期按“每月同日”推进到下一个还款日（简单按月份 +1）
export function nextPaymentDate(startDate: string, monthsElapsed: number): string {
  return addMonths(startDate, monthsElapsed);
}
