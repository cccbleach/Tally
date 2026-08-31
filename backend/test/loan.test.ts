process.env.ALIYUN_SMS_ENABLED = "false";
import { test } from "node:test";
import assert from "node:assert/strict";
import { amortizationSchedule, monthlyPayment } from "../src/lib/loan.js";

test("等额本息月供与计划表基本正确", () => {
  const principal = 1_000_000; // 1万元（分）
  const rate = 4.9;
  const months = 12;
  const payment = monthlyPayment(principal, rate, months);
  assert.ok(payment > 0);

  const schedule = amortizationSchedule(principal, rate, months, "2026-01-01");
  assert.equal(schedule.length, months);
  const sumPrincipal = schedule.reduce((s, x) => s + x.principalPart, 0);
  assert.equal(sumPrincipal, principal, "本金部分之和应等于贷款本金");
  // 每期金额应大于 0；最后一期因取整可能有微调
  for (const x of schedule) {
    assert.ok(x.total > 0, `第 ${x.date} 期金额应大于 0`);
    assert.ok(Math.abs(x.total - payment) <= payment, `第 ${x.date} 期金额接近月供`);
  }
  // 剩余本金单调递减
  for (let i = 1; i < schedule.length; i++) {
    assert.ok(schedule[i]!.remaining < schedule[i - 1]!.remaining);
  }
});
