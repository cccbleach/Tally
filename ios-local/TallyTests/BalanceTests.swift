//
//  BalanceTests.swift
//  TallyTests
//
//  Tests for account balance computation (also covers transfer and edit/delete
//  correctness since balances are always derived from transactions).
//

import Testing
import Foundation
@testable import Tally

@Suite("Account Balance")
struct BalanceTests {

    private func makeDate(_ year: Int, _ month: Int, _ day: Int) -> Date {
        let comps = DateComponents(year: year, month: month, day: day, hour: 12)
        return Calendar(identifier: .gregorian).date(from: comps)!
    }

    @Test("Balance = initial balance + income - expense")
    func basicBalance() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let salary = Category(name: "工资", icon: "creditcard", colorHex: "32D74B", kind: .income)
        salary.ledger = ledger
        let cash = Account(name: "现金", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 10000)
        cash.ledger = ledger

        let income = Transaction(kind: .income, amountMinorUnits: 500000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: salary)
        income.ledger = ledger
        let expense = Transaction(kind: .expense, amountMinorUnits: 3500, currencyCode: "CNY", date: makeDate(2026, 8, 5), account: cash, category: food)
        expense.ledger = ledger

        let balance = BalanceService.balance(for: cash, transactions: [income, expense])
        #expect(balance == 10000 + 500000 - 3500)
    }

    @Test("Transfer moves money between accounts without double counting")
    func transferBalance() {
        let ledger = Ledger(name: "测试")
        let a = Account(name: "现金", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 10000)
        a.ledger = ledger
        let b = Account(name: "银行卡", kind: .debit, currencyCode: "CNY", initialBalanceMinorUnits: 0)
        b.ledger = ledger

        let t = Transaction(kind: .transfer, amountMinorUnits: 6000, currencyCode: "CNY", date: makeDate(2026, 8, 1), fromAccount: a, toAccount: b)
        t.ledger = ledger

        #expect(BalanceService.balance(for: a, transactions: [t]) == 4000)
        #expect(BalanceService.balance(for: b, transactions: [t]) == 6000)
        let totals = BalanceService.netWorth(accounts: [a, b], transactions: [t])
        // Net worth unchanged by an internal transfer.
        #expect(totals["CNY"] == 10000)
    }

    @Test("Deleting a transaction restores the prior balance")
    func deleteRestoresBalance() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 10000)
        cash.ledger = ledger
        let expense = Transaction(kind: .expense, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        expense.ledger = ledger

        #expect(BalanceService.balance(for: cash, transactions: [expense]) == 9000)
        expense.isDeleted = true
        #expect(BalanceService.balance(for: cash, transactions: [expense]) == 10000)
    }

    @Test("Editing a historical transaction keeps derived balance correct")
    func editKeepsBalanceCorrect() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 10000)
        cash.ledger = ledger
        let expense = Transaction(kind: .expense, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        expense.ledger = ledger

        // Simulate user editing the amount.
        expense.amountMinorUnits = 2500
        #expect(BalanceService.balance(for: cash, transactions: [expense]) == 7500)
    }

    @Test("Refund increases the account balance")
    func refundBalance() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 10000)
        cash.ledger = ledger
        let original = Transaction(kind: .expense, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        original.ledger = ledger
        let refund = Transaction(kind: .refund, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 3), account: cash, category: food, refundOf: original)
        refund.ledger = ledger

        #expect(BalanceService.balance(for: cash, transactions: [original, refund]) == 10000)
    }

    @Test("upTo date filters later transactions")
    func balanceUpToDate() {
        let ledger = Ledger(name: "测试")
        let food = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        food.ledger = ledger
        let cash = Account(name: "现金", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 10000)
        cash.ledger = ledger
        let early = Transaction(kind: .expense, amountMinorUnits: 1000, currencyCode: "CNY", date: makeDate(2026, 8, 1), account: cash, category: food)
        early.ledger = ledger
        let late = Transaction(kind: .expense, amountMinorUnits: 2000, currencyCode: "CNY", date: makeDate(2026, 8, 20), account: cash, category: food)
        late.ledger = ledger

        #expect(BalanceService.balance(for: cash, transactions: [early, late]) == 7000)
        #expect(BalanceService.balance(for: cash, transactions: [early, late], upTo: makeDate(2026, 8, 10)) == 9000)
    }

    @Test("Referenced accounts must be archived rather than deleted")
    func accountDeletionPolicy() {
        let account = Account(name: "现金", kind: .cash)
        let unused = Account(name: "备用", kind: .cash)
        let category = Category(name: "餐饮", kind: .expense)
        let transaction = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: Date(), account: account, category: category)
        #expect(!AccountPolicy.canDelete(account, transactions: [transaction]))
        #expect(AccountPolicy.canDelete(unused, transactions: [transaction]))
        account.isArchived = true
        #expect(transaction.account?.id == account.id)
    }

    @Test("Default accounts inherit the ledger currency")
    func defaultAccountCurrency() {
        let accounts = SeedData.makeDefaultAccounts(currencyCode: "USD")
        #expect(accounts.count == 3)
        #expect(accounts.allSatisfy { $0.currencyCode == "USD" })
    }
}
