import { addMonths } from "./date.js";

export interface LoanScheduleItem {
  date: string; // YYYY-MM-DD
  principalPart: number; // 分
  interestPart: number; // 分
  total: number; // 分
  remaining: number; // 分
}

// 等额本息月供（分）
// 下限 1 分：principal=1 分 / 36 期这类极端输入会让 Math.round(principal/termMonths) 得 0，
// 整张计划表变成「每期 0 元」——贷款可以一路「还清」而本金分文未动。
// 调用方仍需拒绝 principal < termMonths 的退化贷款（见 modules/loans.ts 的创建校验）。
export function monthlyPayment(principal: number, annualRate: number, termMonths: number): number {
  if (termMonths <= 0) return 0;
  if (principal <= 0) return 0;
  if (annualRate <= 0) return Math.max(1, Math.round(principal / termMonths));
  const r = annualRate / 100 / 12;
  const factor = Math.pow(1 + r, termMonths);
  return Math.max(1, Math.round((principal * r * factor) / (factor - 1)));
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
    // 最后一期用剩余本金收口：月供是取整后的整数分，前 n-1 期还完后往往还剩几分钱
    // （如 100000 分 / 12 期，每期 8333 分 → 余 4 分），若不收口 remainingPrincipal
    // 永远归不了零、贷款无法结清，本金部分之和也不等于本金。
    let principalPart = i === termMonths - 1 ? remaining : payment - interest;
    if (principalPart > remaining) principalPart = remaining;
    if (principalPart < 0) principalPart = 0;
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
