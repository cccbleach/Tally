//
//  StatsTests.swift
//  TallyTests
//
//  Tests for monthly summaries, category breakdown and trends.
//

import Testing
import Foundation
@testable import Tally

@Suite("Statistics双口径")
struct StatsTests {

    private func makeDate(_ year: Int, _ month: Int, _ day: Int) -> Date {
        let comps = DateComponents(year: year, month: month, day: day, hour: 12)
        return Calendar(identifier: .gregorian).date(from: comps)!
    }

    @Test("Income, expense and balance are computed correctly")
    func monthlySummary() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let salary = Category(name: "工资", icon: "creditcard", colorHex: "32D74B", kind: .income)
        salary.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger

        let expense = Transaction(kind: .expense, amountMinorUnits: 3500, currencyCode: "CNY", date: makeDate(2026, 8, 5), account: cash, category: food)
        expense.ledger = ledger
        let income = Transaction(kind: .income, amountMinorUnits: 500000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: salary)
        income.ledger = ledger

        let period = MonthPeriod(year: 2026, month: 8)
        let summary = StatsService.summary(in: period, transactions: [expense, income])
        #expect(summary.incomeMinorUnits == 500000)
        #expect(summary.expenseMinorUnits == 3500)
        #expect(summary.netMinorUnits == 496500)
    }

    @Test("Transfers are excluded from income and expense")
    func transfersExcluded() {
        let ledger = Ledger(name: "测试")
        let a = Account(name: "现金", kind: .cash)
        a.ledger = ledger
        let b = Account(name: "银行卡", kind: .debit)
        b.ledger = ledger
        let t = Transaction(kind: .transfer, amountMinorUnits: 10000, currencyCode: "CNY", date: makeDate(2026, 8, 5), fromAccount: a, toAccount: b)
        t.ledger = ledger

        let period = MonthPeriod(year: 2026, month: 8)
        let summary = StatsService.summary(in: period, transactions: [t])
        #expect(summary.incomeMinorUnits == 0)
        #expect(summary.expenseMinorUnits == 0)
    }

    @Test("Refunds offset expense")
    func refundOffsetsExpense() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger

        let original = Transaction(kind: .expense, amountMinorUnits: 3500, currencyCode: "CNY", date: makeDate(2026, 8, 5), account: cash, category: food)
        original.ledger = ledger
        let refund = Transaction(kind: .refund, amountMinorUnits: 3500, currencyCode: "CNY", date: makeDate(2026, 8, 7), account: cash, category: food, refundOf: original)
        refund.ledger = ledger

        let period = MonthPeriod(year: 2026, month: 8)
        let summary = StatsService.summary(in: period, transactions: [original, refund])
        #expect(summary.expenseMinorUnits == 0)
    }

    @Test("Soft-deleted transactions are excluded")
    func deletedExcluded() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger
        let expense = Transaction(kind: .expense, amountMinorUnits: 3500, currencyCode: "CNY", date: makeDate(2026, 8, 5), account: cash, category: food)
        expense.ledger = ledger
        expense.isDeleted = true

        let period = MonthPeriod(year: 2026, month: 8)
        let summary = StatsService.summary(in: period, transactions: [expense])
        #expect(summary.expenseMinorUnits == 0)
    }

    @Test("Category breakdown groups by category")
    func categoryBreakdown() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let transport = Category(name: "交通", icon: "bus", colorHex: "0A84FF", kind: .expense)
        transport.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger

        let e1 = Transaction(kind: .expense, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        e1.ledger = ledger
        let e2 = Transaction(kind: .expense, amountMinorUnits: 2000, currencyCode: "CNY", date: makeDate(2026, 8, 2), account: cash, category: food)
        e2.ledger = ledger
        let e3 = Transaction(kind: .expense, amountMinorUnits: 500, currencyCode: "CNY", date: makeDate(2026, 8, 3), account: cash, category: transport)
        e3.ledger = ledger

        let period = MonthPeriod(year: 2026, month: 8)
        let breakdown = StatsService.expenseBreakdown(in: period, transactions: [e1, e2, e3], categories: [food, transport])
        #expect(breakdown.count == 2)
        #expect(breakdown.first(where: { $0.categoryID == food.id })?.amountMinorUnits == 3000)
        #expect(breakdown.first(where: { $0.categoryID == transport.id })?.amountMinorUnits == 500)
        // Sorted descending.
        #expect(breakdown[0].amountMinorUnits >= breakdown[1].amountMinorUnits)
    }

    @Test("Custom month start applies to statistics")
    func statsWithCustomMonthStart() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger

        // 2026-08-10 is before the 20th → belongs to July's period.
        let before = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: makeDate(2026, 8, 10), account: cash, category: food)
        before.ledger = ledger
        // 2026-08-28 → belongs to August's period.
        let after = Transaction(kind: .expense, amountMinorUnits: 200, currencyCode: "CNY", date: makeDate(2026, 8, 28), account: cash, category: food)
        after.ledger = ledger

        let august = MonthPeriod(year: 2026, month: 8, dayStartsOn: 20)
        let summary = StatsService.summary(in: august, transactions: [before, after], dayStartsOn: 20)
        #expect(summary.expenseMinorUnits == 200)
    }

    @Test("Requested currency excludes mixed-currency rows")
    func mixedCurrencyExcluded() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger
        let cny = Transaction(kind: .expense, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        let usd = Transaction(kind: .expense, amountMinorUnits: 9999, currencyCode: "USD", date: makeDate(2026, 8, 1), account: cash, category: food)
        let summary = StatsService.summary(in: MonthPeriod(year: 2026, month: 8), transactions: [cny, usd], currencyCode: "CNY")
        #expect(summary.expenseMinorUnits == 1000)
    }
}
