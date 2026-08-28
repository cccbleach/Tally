//
//  BudgetTests.swift
//  TallyTests
//
//  Tests for budget progress rules.
//

import Testing
import Foundation
@testable import Tally

@Suite("Budget Progress")
struct BudgetTests {

    private func makeDate(_ year: Int, _ month: Int, _ day: Int) -> Date {
        let comps = DateComponents(year: year, month: month, day: day, hour: 12)
        return Calendar(identifier: .gregorian).date(from: comps)!
    }

    @Test("Whole-ledger budget compares against total expense")
    func totalBudget() {
        let ledger = Ledger(name: "测试")
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger

        let e1 = Transaction(kind: .expense, amountMinorUnits: 3000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        e1.ledger = ledger
        let e2 = Transaction(kind: .expense, amountMinorUnits: 5000, currencyCode: "CNY", date: makeDate(2026, 8, 2), account: cash, category: food)
        e2.ledger = ledger

        let budget = Budget(amountMinorUnits: 10000, currencyCode: "CNY")
        budget.ledger = ledger
        let period = MonthPeriod(year: 2026, month: 8)
        let progress = BudgetService.progress(for: budget, period: period, transactions: [e1, e2], categories: [food])
        #expect(progress?.spentMinorUnits == 8000)
        #expect(progress?.remainingMinorUnits == 2000)
        #expect(progress?.isOver == false)
        #expect(progress?.ratio ?? 0 == 0.8)
    }

    @Test("Category budget compares against that category only")
    func categoryBudget() {
        let ledger = Ledger(name: "测试")
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let transport = Category(name: "交通", icon: "bus", colorHex: "0A84FF", kind: .expense)
        transport.ledger = ledger

        let foodTx = Transaction(kind: .expense, amountMinorUnits: 4000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        foodTx.ledger = ledger
        let transportTx = Transaction(kind: .expense, amountMinorUnits: 9000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: transport)
        transportTx.ledger = ledger

        let budget = Budget(amountMinorUnits: 5000, currencyCode: "CNY", categoryID: food.id)
        budget.ledger = ledger
        let period = MonthPeriod(year: 2026, month: 8)
        let progress = BudgetService.progress(for: budget, period: period, transactions: [foodTx, transportTx], categories: [food, transport])
        #expect(progress?.spentMinorUnits == 4000)
        // Transport spending does not count against the food budget.
        #expect(progress?.isOver == false)
    }

    @Test("Over-budget detection")
    func overBudget() {
        let ledger = Ledger(name: "测试")
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let e = Transaction(kind: .expense, amountMinorUnits: 12000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        e.ledger = ledger

        let budget = Budget(amountMinorUnits: 10000, currencyCode: "CNY")
        budget.ledger = ledger
        let period = MonthPeriod(year: 2026, month: 8)
        let progress = BudgetService.progress(for: budget, period: period, transactions: [e], categories: [food])
        #expect(progress?.isOver == true)
        #expect(progress?.remainingMinorUnits == -2000)
    }

    @Test("Disabled budgets do not appear")
    func disabledBudgetIgnored() {
        let ledger = Ledger(name: "测试")
        let budget = Budget(amountMinorUnits: 1000, currencyCode: "CNY", isEnabled: false)
        budget.ledger = ledger
        let period = MonthPeriod(year: 2026, month: 8)
        let progress = BudgetService.progress(for: budget, period: period, transactions: [], categories: [])
        #expect(progress == nil)
    }

    @Test("Period-specific budget only applies to its month")
    func periodSpecificBudget() {
        let ledger = Ledger(name: "测试")
        let budget = Budget(amountMinorUnits: 1000, currencyCode: "CNY", periodISO: "2026-08")
        budget.ledger = ledger
        let august = MonthPeriod(year: 2026, month: 8)
        let september = MonthPeriod(year: 2026, month: 9)
        #expect(BudgetService.progress(for: budget, period: august, transactions: [], categories: []) != nil)
        #expect(BudgetService.progress(for: budget, period: september, transactions: [], categories: []) == nil)
    }

    @Test("Unlinked refund offsets its selected category and foreign currency is ignored")
    func unlinkedRefundAndCurrency() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash)
        cash.ledger = ledger
        let expense = Transaction(kind: .expense, amountMinorUnits: 5000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        let refund = Transaction(kind: .refund, amountMinorUnits: 1200, currencyCode: "CNY", date: makeDate(2026, 8, 2), account: cash, category: food)
        let usd = Transaction(kind: .expense, amountMinorUnits: 9000, currencyCode: "USD", date: makeDate(2026, 8, 3), account: cash, category: food)
        let budget = Budget(amountMinorUnits: 10000, currencyCode: "CNY", categoryID: food.id)
        let progress = BudgetService.progress(for: budget, period: MonthPeriod(year: 2026, month: 8), transactions: [expense, refund, usd], categories: [food])
        #expect(progress?.spentMinorUnits == 3800)
        #expect(progress?.categoryName == "餐饮")
    }
}
