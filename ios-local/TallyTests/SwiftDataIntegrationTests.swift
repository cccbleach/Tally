//
//  SwiftDataIntegrationTests.swift
//  TallyTests
//
//  Exercises the real persistence layer instead of only pure service objects.
//

import Foundation
import SwiftData
import Testing
@testable import Tally

@Suite("SwiftData Reliability", .serialized)
@MainActor
struct SwiftDataIntegrationTests {
    private func makeMemoryContainer() throws -> ModelContainer {
        let configuration = ModelConfiguration(
            "TallyIntegration",
            schema: PersistenceController.schema,
            isStoredInMemoryOnly: true,
            cloudKitDatabase: .none
        )
        return try ModelContainer(
            for: PersistenceController.schema,
            migrationPlan: TallyMigrationPlan.self,
            configurations: [configuration]
        )
    }

    private func makeDiskContainer(url: URL) throws -> ModelContainer {
        let configuration = ModelConfiguration(
            "TallyPersistence",
            schema: PersistenceController.schema,
            url: url,
            cloudKitDatabase: .none
        )
        return try ModelContainer(
            for: PersistenceController.schema,
            migrationPlan: TallyMigrationPlan.self,
            configurations: [configuration]
        )
    }

    private func insertLedgerGraph(
        into context: ModelContext,
        name: String,
        currency: String,
        isDefault: Bool
    ) -> (Ledger, Account, Tally.Category) {
        let ledger = Ledger(name: name, currencyCode: currency, isDefault: isDefault)
        let account = Account(name: "现金", kind: .cash, currencyCode: currency)
        let category = Category(name: "餐饮", kind: .expense)
        account.ledger = ledger
        category.ledger = ledger
        context.insert(ledger)
        context.insert(account)
        context.insert(category)
        return (ledger, account, category)
    }

    @Test("Data survives closing and reopening the SQLite store")
    func persistenceAcrossRestart() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TallyPersistence-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("Tally.store")
        let ledgerID: UUID

        do {
            let container = try makeDiskContainer(url: storeURL)
            let context = container.mainContext
            let graph = insertLedgerGraph(into: context, name: "重启测试", currency: "CNY", isDefault: true)
            ledgerID = graph.0.id
            let transaction = Transaction(
                kind: .expense,
                amountMinorUnits: 1234,
                currencyCode: "CNY",
                date: Date(),
                account: graph.1,
                category: graph.2
            )
            transaction.ledger = graph.0
            context.insert(transaction)
            try context.save()
        }

        let reopened = try makeDiskContainer(url: storeURL)
        let ledgers = try reopened.mainContext.fetch(FetchDescriptor<Ledger>())
        let transactions = try reopened.mainContext.fetch(FetchDescriptor<Transaction>())
        #expect(ledgers.first?.id == ledgerID)
        #expect(ledgers.first?.name == "重启测试")
        #expect(transactions.first?.amountMinorUnits == 1234)
        #expect(transactions.first?.account?.ledger?.id == ledgerID)
    }

    @Test("The explicit V1 plan opens a legacy unversioned store")
    func legacyStoreCompatibility() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TallyLegacy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("Legacy.store")
        let ledgerID: UUID

        do {
            let legacySchema = Schema(PersistenceController.modelTypes)
            let legacyConfiguration = ModelConfiguration(
                "TallyLegacy",
                schema: legacySchema,
                url: storeURL,
                cloudKitDatabase: .none
            )
            let legacyContainer = try ModelContainer(for: legacySchema, configurations: [legacyConfiguration])
            let graph = insertLedgerGraph(into: legacyContainer.mainContext, name: "旧版账本", currency: "CNY", isDefault: true)
            ledgerID = graph.0.id
            try legacyContainer.mainContext.save()
        }

        let upgraded = try makeDiskContainer(url: storeURL)
        let ledger = try #require(upgraded.mainContext.fetch(FetchDescriptor<Ledger>()).first)
        #expect(ledger.id == ledgerID)
        #expect(ledger.name == "旧版账本")
        #expect(ledger.accounts.count == 1)
        #expect(ledger.categories.count == 1)
    }

    @Test("Complete snapshot restores every ledger and refund relationship")
    func completeBackupRestore() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let first = insertLedgerGraph(into: context, name: "个人", currency: "CNY", isDefault: true)
        let second = insertLedgerGraph(into: context, name: "旅行", currency: "USD", isDefault: false)
        let settings = AppSettings()
        settings.defaultLedgerID = first.0.id
        context.insert(settings)

        let expense = Transaction(kind: .expense, amountMinorUnits: 5000, currencyCode: "CNY", date: Date(), account: first.1, category: first.2)
        expense.ledger = first.0
        let refund = Transaction(kind: .refund, amountMinorUnits: 1200, currencyCode: "CNY", date: Date(), account: first.1, category: first.2, refundOf: expense)
        refund.ledger = first.0
        let usdExpense = Transaction(kind: .expense, amountMinorUnits: 2500, currencyCode: "USD", date: Date(), account: second.1, category: second.2)
        usdExpense.ledger = second.0
        context.insert(expense)
        context.insert(refund)
        context.insert(usdExpense)
        try context.save()

        let document = try SnapshotBuilder.makeDocument(
            ledgers: try context.fetch(FetchDescriptor<Ledger>()),
            accounts: try context.fetch(FetchDescriptor<Account>()),
            categories: try context.fetch(FetchDescriptor<Tally.Category>()),
            transactions: try context.fetch(FetchDescriptor<Transaction>()),
            budgets: try context.fetch(FetchDescriptor<Budget>()),
            settings: try context.fetch(FetchDescriptor<AppSettings>())
        )
        #expect(document.transactions.count == 3)
        #expect(Set(document.transactions.map { $0.ledgerID }).count == 2)

        try SnapshotBuilder.restore(document, context: context)
        let restoredLedgers = try context.fetch(FetchDescriptor<Ledger>())
        let restoredTransactions = try context.fetch(FetchDescriptor<Transaction>())
        #expect(restoredLedgers.count == 2)
        #expect(restoredTransactions.count == 3)
        let restoredRefund = try #require(restoredTransactions.first { $0.kind == .refund })
        #expect(restoredRefund.refundOf?.id == expense.id)
        #expect(restoredRefund.ledger?.id == first.0.id)
    }

    @Test("Invalid backup leaves existing data untouched")
    func invalidBackupPreservesStore() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let graph = insertLedgerGraph(into: context, name: "必须保留", currency: "CNY", isDefault: true)
        let settings = AppSettings()
        settings.defaultLedgerID = graph.0.id
        let expense = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: Date(), account: graph.1, category: graph.2)
        expense.ledger = graph.0
        context.insert(settings)
        context.insert(expense)
        try context.save()

        var document = try SnapshotBuilder.makeDocument(
            ledgers: [graph.0], accounts: [graph.1], categories: [graph.2],
            transactions: [expense], budgets: [], settings: [settings]
        )
        document.transactions[0].accountID = UUID()
        #expect(throws: BackupError.self) {
            try SnapshotBuilder.restore(document, context: context)
        }
        #expect(try context.fetch(FetchDescriptor<Ledger>()).first?.name == "必须保留")
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 1)
    }

    @Test("CSV refund round-trip is idempotent and ledger isolated")
    func csvRoundTripAndIsolation() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        let targetAccount = Account(name: "现金", kind: .cash, currencyCode: "CNY")
        targetAccount.ledger = target
        context.insert(target)
        context.insert(targetAccount)

        let other = Ledger(name: "其他", currencyCode: "CNY")
        let foreignCategory = Category(name: "餐饮", kind: .expense)
        foreignCategory.ledger = other
        context.insert(other)
        context.insert(foreignCategory)
        try context.save()

        let sourceLedger = Ledger(name: "来源")
        let sourceAccount = Account(name: "现金", kind: .cash)
        let sourceCategory = Category(name: "餐饮", kind: .expense)
        let original = Transaction(kind: .expense, amountMinorUnits: 2500, currencyCode: "CNY", date: .distantPast, account: sourceAccount, category: sourceCategory)
        let refund = Transaction(kind: .refund, amountMinorUnits: 500, currencyCode: "CNY", date: Date(), account: sourceAccount, category: sourceCategory, refundOf: original)
        original.ledger = sourceLedger
        refund.ledger = sourceLedger
        let csv = CSVService.exportCSV(transactions: [original, refund])

        let firstImport = try CSVImportService.importCSV(csv, into: target, context: context)
        #expect(firstImport == CSVImportResult(insertedCount: 2, skippedDuplicateCount: 0))
        let targetTransactions = try context.fetch(FetchDescriptor<Transaction>()).filter { $0.ledger?.id == target.id }
        #expect(targetTransactions.count == 2)
        let importedRefund = try #require(targetTransactions.first { $0.kind == .refund })
        #expect(importedRefund.refundOf?.id == original.id)
        #expect(importedRefund.category?.ledger?.id == target.id)
        #expect(importedRefund.category?.id != foreignCategory.id)

        let secondImport = try CSVImportService.importCSV(csv, into: target, context: context)
        #expect(secondImport == CSVImportResult(insertedCount: 0, skippedDuplicateCount: 2))
        #expect(try context.fetch(FetchDescriptor<Transaction>()).filter { $0.ledger?.id == target.id }.count == 2)
    }

    @Test("Malformed CSV and cross-ledger IDs make no partial writes")
    func csvAtomicFailure() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        let malformed = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,新账户,,新分类,,,,
        expense,2026-08-02,20.00,CNY,新账户,,,,,,
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(malformed, into: target, context: context)
        }
        #expect(try context.fetch(FetchDescriptor<Account>()).isEmpty)
        #expect(try context.fetch(FetchDescriptor<Tally.Category>()).isEmpty)
        #expect(try context.fetch(FetchDescriptor<Transaction>()).isEmpty)

        let other = Ledger(name: "其他", currencyCode: "CNY")
        let otherAccount = Account(name: "现金", kind: .cash, currencyCode: "CNY")
        let otherCategory = Category(name: "餐饮", kind: .expense)
        let existing = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: Date(), account: otherAccount, category: otherCategory)
        otherAccount.ledger = other
        otherCategory.ledger = other
        existing.ledger = other
        context.insert(other)
        context.insert(otherAccount)
        context.insert(otherCategory)
        context.insert(existing)
        try context.save()
        let collision = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,1.00,CNY,现金,,餐饮,,,\(existing.id.uuidString),
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(collision, into: target, context: context)
        }
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 1)
    }

    @Test("CSV rejects unsupported or ledger-mismatched currencies")
    func csvCurrencyInvariant() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let ledger = Ledger(name: "人民币", currencyCode: "CNY", isDefault: true)
        context.insert(ledger)
        try context.save()
        let unsupported = "expense,2026-08-01,1.00,ABC,现金,,餐饮,,,,"
        let mismatched = "expense,2026-08-01,1.00,USD,现金,,餐饮,,,,"
        let invalidDate = "expense,2026-02-30,1.00,CNY,现金,,餐饮,,,,"
        #expect(throws: CSVService.CSVError.self) { try CSVImportService.importCSV(unsupported, into: ledger, context: context) }
        #expect(throws: CSVService.CSVError.self) { try CSVImportService.importCSV(mismatched, into: ledger, context: context) }
        #expect(throws: CSVService.CSVError.self) { try CSVImportService.importCSV(invalidDate, into: ledger, context: context) }
        #expect(try context.fetch(FetchDescriptor<Transaction>()).isEmpty)
    }

    @Test("Clear all data is one transaction and reseeds a valid baseline")
    func clearAndReseed() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let graph = insertLedgerGraph(into: context, name: "待清除", currency: "CNY", isDefault: true)
        let settings = AppSettings()
        settings.defaultLedgerID = graph.0.id
        let expense = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: Date(), account: graph.1, category: graph.2)
        expense.ledger = graph.0
        context.insert(settings)
        context.insert(expense)
        try context.save()

        try PersistenceController.resetAllData(context: context)
        let ledgers = try context.fetch(FetchDescriptor<Ledger>())
        let newSettings = try context.fetch(FetchDescriptor<AppSettings>())
        #expect(ledgers.count == 1)
        #expect(newSettings.count == 1)
        #expect(newSettings.first?.defaultLedgerID == ledgers.first?.id)
        #expect(try context.fetch(FetchDescriptor<Transaction>()).isEmpty)
        #expect(try context.fetch(FetchDescriptor<Account>()).count == 3)
        #expect(try context.fetch(FetchDescriptor<Tally.Category>()).count == 13)
    }

    @Test("Currency change updates an empty ledger atomically and locks after activity")
    func ledgerCurrencyChange() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let graph = insertLedgerGraph(into: context, name: "换币", currency: "CNY", isDefault: true)
        try context.save()

        try LedgerCurrencyPolicy.changeCurrency(of: graph.0, to: "USD")
        try context.save()
        #expect(graph.0.currencyCode == "USD")
        #expect(graph.0.accounts.allSatisfy { $0.currencyCode == "USD" })

        let expense = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "USD", date: Date(), account: graph.1, category: graph.2)
        expense.ledger = graph.0
        context.insert(expense)
        try context.save()
        #expect(throws: LedgerCurrencyPolicy.CurrencyChangeError.self) {
            try LedgerCurrencyPolicy.changeCurrency(of: graph.0, to: "EUR")
        }
        #expect(graph.0.currencyCode == "USD")
        #expect(graph.0.accounts.allSatisfy { $0.currencyCode == "USD" })
    }

    @Test("Short-month custom boundaries are honored with persisted transactions")
    func shortMonthStatsBoundary() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let graph = insertLedgerGraph(into: context, name: "短月统计", currency: "CNY", isDefault: true)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))

        func date(_ year: Int, _ month: Int, _ day: Int) throws -> Date {
            try #require(calendar.date(from: DateComponents(year: year, month: month, day: day)))
        }

        for (day, amount) in [(try date(2026, 2, 27), 100),
                              (try date(2026, 2, 28), 200),
                              (try date(2026, 3, 30), 300),
                              (try date(2026, 3, 31), 400)] {
            let expense = Transaction(
                kind: .expense,
                amountMinorUnits: Int64(amount),
                currencyCode: "CNY",
                date: day,
                account: graph.1,
                category: graph.2
            )
            expense.ledger = graph.0
            context.insert(expense)
        }
        try context.save()

        let persisted = try context.fetch(FetchDescriptor<Transaction>())
        let summary = StatsService.summary(
            in: MonthPeriod(year: 2026, month: 2, dayStartsOn: 31),
            transactions: persisted,
            dayStartsOn: 31,
            currencyCode: "CNY",
            calendar: calendar
        )
        let expectedStart = try date(2026, 2, 28)
        let expectedEnd = try date(2026, 3, 31)
        #expect(persisted.count == 4)
        #expect(summary.expenseMinorUnits == 500)
        #expect(summary.period.startDate(calendar: calendar) == expectedStart)
        #expect(summary.period.endDate(calendar: calendar) == expectedEnd)
    }

    @Test("Legacy 10-column CSV imports into the target ledger with refund linking")
    func legacyCsvImportRoundTrip() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        let originalID = UUID().uuidString
        // Legacy format: single id column. Expense carries its own id; refund's
        // id column holds the id of the expense it refunds.
        let legacy = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,\(originalID)
        refund,2026-08-03,12.50,CNY,现金,,餐饮,食堂,退款,\(originalID)
        """
        let result = try CSVImportService.importCSV(legacy, into: target, context: context)
        #expect(result == CSVImportResult(insertedCount: 2, skippedDuplicateCount: 0))

        let all = try context.fetch(FetchDescriptor<Transaction>())
        #expect(all.count == 2)
        let expense = try #require(all.first { $0.kind == .expense })
        let refund = try #require(all.first { $0.kind == .refund })
        #expect(expense.id.uuidString == originalID)
        #expect(refund.refundOf?.id == expense.id)
        #expect(expense.account?.ledger?.id == target.id)
        #expect(refund.category?.ledger?.id == target.id)
        try context.save()

        // Re-importing the same legacy file is idempotent: the expense is matched
        // by its stable id, and the refund is skipped as a duplicate.
        let second = try CSVImportService.importCSV(legacy, into: target, context: context)
        #expect(second.skippedDuplicateCount >= 1)
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 2)
    }

    @Test("Same transaction ID with conflicting content is an explicit error")
    func csvSameIDConflictThrows() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        let id = UUID().uuidString
        let original = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,\(id),
        """
        let inserted = try CSVImportService.importCSV(original, into: target, context: context)
        #expect(inserted == CSVImportResult(insertedCount: 1, skippedDuplicateCount: 0))

        // Identical re-import is idempotent (no error, no new rows).
        let same = try CSVImportService.importCSV(original, into: target, context: context)
        #expect(same == CSVImportResult(insertedCount: 0, skippedDuplicateCount: 1))
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 1)

        // Same ID but different amount must not silently overwrite.
        let conflictingAmount = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,99.00,CNY,现金,,餐饮,食堂,午饭,\(id),
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(conflictingAmount, into: target, context: context)
        }
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 1)

        // Same ID but different date must also be rejected.
        let conflictingDate = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-02,12.50,CNY,现金,,餐饮,食堂,午饭,\(id),
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(conflictingDate, into: target, context: context)
        }
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 1)

        // The original transaction is unmodified.
        let stored = try #require(context.fetch(FetchDescriptor<Transaction>()).first)
        #expect(stored.amountMinorUnits == 1250)
        #expect(CSVService.isoDate.string(from: stored.date) == "2026-08-01")
    }

    // MARK: - Refund duplicate-key correctness

    @Test("Refunds with identical display fields but different origin are not duplicates")
    func refundDifferentOriginNotDuplicate() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        let account = Account(name: "现金", kind: .cash, currencyCode: "CNY")
        let category = Category(name: "餐饮", kind: .expense)
        account.ledger = target
        category.ledger = target
        context.insert(target)
        context.insert(account)
        context.insert(category)

        // Two original expenses with different ids.
        let aID = UUID()
        let bID = UUID()
        let a = Transaction(kind: .expense, amountMinorUnits: 1250, currencyCode: "CNY", date: CSVService.isoDate.date(from: "2026-08-01") ?? Date(), account: account, category: category)
        a.id = aID
        a.ledger = target
        let b = Transaction(kind: .expense, amountMinorUnits: 2000, currencyCode: "CNY", date: CSVService.isoDate.date(from: "2026-08-02") ?? Date(), account: account, category: category)
        b.id = bID
        b.ledger = target
        context.insert(a)
        context.insert(b)
        try context.save()

        let refund1ID = UUID()
        let refund2ID = UUID()
        // Refund linked to A, all display fields identical to the one linked to B.
        let refundForA = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-03,5.00,CNY,现金,,餐饮,食堂,退款,\(refund1ID.uuidString),\(aID.uuidString)
        """
        let first = try CSVImportService.importCSV(refundForA, into: target, context: context)
        #expect(first == CSVImportResult(insertedCount: 1, skippedDuplicateCount: 0))
        #expect(try context.fetch(FetchDescriptor<Transaction>()).count == 3)

        // Same display fields but linked to B must NOT be treated as a duplicate.
        let refundForB = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-03,5.00,CNY,现金,,餐饮,食堂,退款,\(refund2ID.uuidString),\(bID.uuidString)
        """
        let second = try CSVImportService.importCSV(refundForB, into: target, context: context)
        #expect(second == CSVImportResult(insertedCount: 1, skippedDuplicateCount: 0))
        let all = try context.fetch(FetchDescriptor<Transaction>())
        let refunds = all.filter { $0.kind == .refund }
        #expect(refunds.count == 2)
        #expect(Set(refunds.compactMap { $0.refundOf?.id }) == Set([aID, bID]))
        let refundToA = try #require(refunds.first { $0.refundOf?.id == aID })
        let refundToB = try #require(refunds.first { $0.refundOf?.id == bID })
        #expect(refundToA.id == refund1ID)
        #expect(refundToB.id == refund2ID)
    }

    @Test("Re-importing the same refund is idempotent and never duplicates")
    func refundIdempotentReimport() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        let account = Account(name: "现金", kind: .cash, currencyCode: "CNY")
        let category = Category(name: "餐饮", kind: .expense)
        account.ledger = target
        category.ledger = target
        context.insert(target)
        context.insert(account)
        context.insert(category)
        let originID = UUID()
        let origin = Transaction(kind: .expense, amountMinorUnits: 1250, currencyCode: "CNY", date: CSVService.isoDate.date(from: "2026-08-01") ?? Date(), account: account, category: category)
        origin.id = originID
        origin.ledger = target
        context.insert(origin)
        try context.save()

        let refundID = UUID()
        let csv = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-03,5.00,CNY,现金,,餐饮,食堂,退款,\(refundID.uuidString),\(originID.uuidString)
        """
        let first = try CSVImportService.importCSV(csv, into: target, context: context)
        #expect(first == CSVImportResult(insertedCount: 1, skippedDuplicateCount: 0))
        let second = try CSVImportService.importCSV(csv, into: target, context: context)
        #expect(second == CSVImportResult(insertedCount: 0, skippedDuplicateCount: 1))
        #expect(try context.fetch(FetchDescriptor<Transaction>()).filter { $0.kind == .refund }.count == 1)
    }

    @Test("Same stable refund ID with different content is an explicit error")
    func refundSameIDConflictThrows() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        let account = Account(name: "现金", kind: .cash, currencyCode: "CNY")
        let category = Category(name: "餐饮", kind: .expense)
        account.ledger = target
        category.ledger = target
        context.insert(target)
        context.insert(account)
        context.insert(category)
        let originID = UUID()
        let origin = Transaction(kind: .expense, amountMinorUnits: 1250, currencyCode: "CNY", date: CSVService.isoDate.date(from: "2026-08-01") ?? Date(), account: account, category: category)
        origin.id = originID
        origin.ledger = target
        context.insert(origin)
        try context.save()

        let refundID = UUID()
        let original = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-03,5.00,CNY,现金,,餐饮,食堂,退款,\(refundID.uuidString),\(originID.uuidString)
        """
        let inserted = try CSVImportService.importCSV(original, into: target, context: context)
        #expect(inserted == CSVImportResult(insertedCount: 1, skippedDuplicateCount: 0))

        // Same stable ID but different amount must not silently overwrite.
        let conflictingAmount = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-03,99.00,CNY,现金,,餐饮,食堂,退款,\(refundID.uuidString),\(originID.uuidString)
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(conflictingAmount, into: target, context: context)
        }
        // Same stable ID but different date must also be rejected.
        let conflictingDate = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-04,5.00,CNY,现金,,餐饮,食堂,退款,\(refundID.uuidString),\(originID.uuidString)
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(conflictingDate, into: target, context: context)
        }
        // Database unchanged.
        let refunds = try context.fetch(FetchDescriptor<Transaction>()).filter { $0.kind == .refund }
        #expect(refunds.count == 1)
        #expect(refunds.first?.amountMinorUnits == 500)
        #expect(CSVService.isoDate.string(from: refunds.first?.date ?? Date()) == "2026-08-03")
    }

    // MARK: - V1 / V2 import semantics

    @Test("V1 import links refund to its original expense using the id column")
    func v1ImportLinksRefund() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        let originID = UUID().uuidString
        let v1 = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,\(originID)
        refund,2026-08-03,5.00,CNY,现金,,餐饮,,,\(originID)
        """
        let result = try CSVImportService.importCSV(v1, into: target, context: context)
        #expect(result == CSVImportResult(insertedCount: 2, skippedDuplicateCount: 0))
        let all = try context.fetch(FetchDescriptor<Transaction>())
        let expense = try #require(all.first { $0.kind == .expense })
        let refund = try #require(all.first { $0.kind == .refund })
        #expect(expense.id.uuidString == originID)
        #expect(refund.refundOf?.id == expense.id)
        // V1 refund has no stable id of its own but still persists.
        #expect(refund.id != expense.id)
    }

    @Test("V2 import keeps refund own id separate from the original expense id")
    func v2ImportSeparatesIds() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        let originID = UUID()
        let refundID = UUID()
        let v2 = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,\(originID.uuidString),
        refund,2026-08-03,5.00,CNY,现金,,餐饮,,,\(refundID.uuidString),\(originID.uuidString)
        """
        let result = try CSVImportService.importCSV(v2, into: target, context: context)
        #expect(result == CSVImportResult(insertedCount: 2, skippedDuplicateCount: 0))
        let all = try context.fetch(FetchDescriptor<Transaction>())
        let refund = try #require(all.first { $0.kind == .refund })
        #expect(refund.id == refundID)
        #expect(refund.refundOf?.id == originID)
        #expect(refund.id != originID)
    }

    @Test("V2 unlinked refund imports without requiring an original")
    func v2UnlinkedRefundImports() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        let refundID = UUID()
        let v2 = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-03,5.00,CNY,现金,,餐饮,,,\(refundID.uuidString),
        """
        let result = try CSVImportService.importCSV(v2, into: target, context: context)
        #expect(result == CSVImportResult(insertedCount: 1, skippedDuplicateCount: 0))
        let refund = try #require(context.fetch(FetchDescriptor<Transaction>()).first)
        #expect(refund.kind == .refund)
        #expect(refund.refundOf == nil)
    }

    // MARK: - Transaction-failure rollback proof

    @Test("CSV import that fails mid-transaction leaves zero half-written rows")
    func csvMidTransactionFailureRollsBack() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        try context.save()

        // Import would create a new account, a new category and two transactions.
        let csv = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,新账户,,新分类,,,,
        expense,2026-08-02,20.00,CNY,新账户,,新分类,,,,
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSVWithFailure(csv, into: target, context: context, failurePoint: .afterInsertedRows(1))
        }
        #expect(try context.fetch(FetchDescriptor<Account>()).isEmpty)
        #expect(try context.fetch(FetchDescriptor<Tally.Category>()).isEmpty)
        #expect(try context.fetch(FetchDescriptor<Transaction>()).isEmpty)
    }

    @Test("CSV import that fails mid-transaction on a real disk store rolls back with no half-written rows after reopening")
    func csvDiskMidTransactionFailureRollsBackAcrossReopen() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TallyCSVRollback-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("Tally.store")

        // Seed original data that must survive the failed import.
        let savedLedgerID: UUID
        let savedAccountID: UUID
        do {
            let container = try makeDiskContainer(url: storeURL)
            let context = container.mainContext
            let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
            let existingAccount = Account(name: "现有账户", kind: .cash, currencyCode: "CNY", initialBalanceMinorUnits: 50000)
            existingAccount.ledger = target
            let existingCategory = Category(name: "既有分类", kind: .expense)
            existingCategory.ledger = target
            context.insert(target)
            context.insert(existingAccount)
            context.insert(existingCategory)
            try context.save()
            savedLedgerID = target.id
            savedAccountID = existingAccount.id
        }

        do {
            let container = try makeDiskContainer(url: storeURL)
            let context = container.mainContext
            let target = try #require(context.fetch(FetchDescriptor<Ledger>()).first)

            // Creates a new account, a new category and two transactions. The
            // failure is injected after row 1, meaning the first transaction
            // (plus its new account + new category) was already inserted when
            // the error is thrown.
            let csv = """
            type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
            expense,2026-08-01,12.50,CNY,新账户,,新分类,,,,
            expense,2026-08-02,20.00,CNY,新账户,,新分类,,,,
            """
            #expect(throws: CSVService.CSVError.self) {
                try CSVImportService.importCSVWithFailure(csv, into: target, context: context, failurePoint: .afterInsertedRows(1))
            }

            // Live context: original data intact, no half-written objects.
            let ledgers = try context.fetch(FetchDescriptor<Ledger>())
            #expect(ledgers.count == 1)
            #expect(ledgers.first?.id == savedLedgerID)
            let accounts = try context.fetch(FetchDescriptor<Account>())
            #expect(accounts.count == 1)
            #expect(accounts.first?.id == savedAccountID)
            #expect(accounts.first?.initialBalanceMinorUnits == 50000)
            #expect(try context.fetch(FetchDescriptor<Tally.Category>()).count == 1)
            #expect(try context.fetch(FetchDescriptor<Transaction>()).isEmpty)
            #expect(try context.fetch(FetchDescriptor<Tally.Category>()).contains { $0.name == "新分类" } == false)
            #expect(try context.fetch(FetchDescriptor<Account>()).contains { $0.name == "新账户" } == false)
        }

        // Reopen the same on-disk store: the original data is fully preserved
        // and none of the half-written import objects exist.
        let reopened = try makeDiskContainer(url: storeURL)
        let reopenedLedger = try #require(reopened.mainContext.fetch(FetchDescriptor<Ledger>()).first)
        #expect(reopenedLedger.id == savedLedgerID)
        let reopenedAccount = try #require(reopened.mainContext.fetch(FetchDescriptor<Account>()).first)
        #expect(reopenedAccount.id == savedAccountID)
        #expect(reopenedAccount.initialBalanceMinorUnits == 50000)
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Tally.Category>()).count == 1)
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Transaction>()).isEmpty)
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Account>()).contains { $0.name == "新账户" } == false)
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Tally.Category>()).contains { $0.name == "新分类" } == false)
    }

    @Test("Backup restore that fails after the new ledger is inserted rolls back to old data")
    func backupRestoreMidTransactionRollsBack() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TallyRollback-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appendingPathComponent("Tally.store")

        let container = try makeDiskContainer(url: storeURL)
        let context = container.mainContext
        let graph = insertLedgerGraph(into: context, name: "必须保留", currency: "CNY", isDefault: true)
        let settings = AppSettings()
        settings.defaultLedgerID = graph.0.id
        let expense = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: Date(), account: graph.1, category: graph.2)
        expense.ledger = graph.0
        context.insert(settings)
        context.insert(expense)
        try context.save()
        let savedLedgerID = graph.0.id
        let savedAccountID = graph.1.id
        let savedCategoryID = graph.2.id
        let savedTransactionID = expense.id
        let savedSettingsID = settings.id

        // Build a valid replacement document (references its own new graph) but
        // inject a failure AFTER the replacement ledger has been inserted — so
        // at least one brand-new object already exists when the error is thrown
        // (old data deleted, new ledger inserted, nothing else yet).
        var doc = try SnapshotBuilder.makeDocument(
            ledgers: [graph.0], accounts: [graph.1], categories: [graph.2],
            transactions: [expense], budgets: [], settings: [settings]
        )
        doc.ledgers[0].name = "替换账本"

        #expect(throws: BackupError.self) {
            try SnapshotBuilder.restoreWithFailure(doc, context: context, failurePoint: .afterInsertedLedger(0))
        }

        // Live context: the old objects are all still present, intact and linked…
        let liveLedgers = try context.fetch(FetchDescriptor<Ledger>())
        #expect(liveLedgers.count == 1)
        #expect(liveLedgers.first?.id == savedLedgerID)
        #expect(liveLedgers.first?.name == "必须保留")
        let liveAccounts = try context.fetch(FetchDescriptor<Account>())
        #expect(liveAccounts.count == 1)
        #expect(liveAccounts.first?.id == savedAccountID)
        let liveCategories = try context.fetch(FetchDescriptor<Tally.Category>())
        #expect(liveCategories.count == 1)
        #expect(liveCategories.first?.id == savedCategoryID)
        let liveTransactions = try context.fetch(FetchDescriptor<Transaction>())
        #expect(liveTransactions.count == 1)
        #expect(liveTransactions.first?.id == savedTransactionID)
        #expect(liveTransactions.first?.account?.id == savedAccountID)
        #expect(liveTransactions.first?.category?.id == savedCategoryID)
        #expect(liveTransactions.first?.ledger?.id == savedLedgerID)
        let liveSettings = try context.fetch(FetchDescriptor<AppSettings>())
        #expect(liveSettings.count == 1)
        #expect(liveSettings.first?.id == savedSettingsID)
        // …and the replacement (half-written) ledger is nowhere to be seen.
        #expect(!liveLedgers.contains { $0.name == "替换账本" })

        // Reopen a fresh connection to the same on-disk store and confirm the
        // original IDs, names and relationships survived the aborted restore.
        let reopened = try makeDiskContainer(url: storeURL)
        let reopenedLedger = try #require(reopened.mainContext.fetch(FetchDescriptor<Ledger>()).first)
        #expect(reopenedLedger.id == savedLedgerID)
        #expect(reopenedLedger.name == "必须保留")
        let reopenedAccount = try #require(reopened.mainContext.fetch(FetchDescriptor<Account>()).first)
        #expect(reopenedAccount.id == savedAccountID)
        let reopenedCategory = try #require(reopened.mainContext.fetch(FetchDescriptor<Tally.Category>()).first)
        #expect(reopenedCategory.id == savedCategoryID)
        let reopenedTransaction = try #require(reopened.mainContext.fetch(FetchDescriptor<Transaction>()).first)
        #expect(reopenedTransaction.id == savedTransactionID)
        #expect(reopenedTransaction.account?.id == savedAccountID)
        #expect(reopenedTransaction.category?.id == savedCategoryID)
        #expect(reopenedTransaction.ledger?.id == savedLedgerID)
        let reopenedSettings = try #require(reopened.mainContext.fetch(FetchDescriptor<AppSettings>()).first)
        #expect(reopenedSettings.id == savedSettingsID)

        // No half-written replacement objects survived anywhere.
        let reopenedLedgers = try reopened.mainContext.fetch(FetchDescriptor<Ledger>())
        #expect(reopenedLedgers.count == 1)
        #expect(!reopenedLedgers.contains { $0.name == "替换账本" })
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Account>()).count == 1)
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Tally.Category>()).count == 1)
        #expect(try reopened.mainContext.fetch(FetchDescriptor<Transaction>()).count == 1)
    }

    // MARK: - Unsaved unrelated changes are never silently committed

    @Test("CSV import refuses to silently commit unrelated unsaved changes")
    func csvImportRejectsDirtyContext() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let target = Ledger(name: "目标", currencyCode: "CNY", isDefault: true)
        context.insert(target)
        // An unrelated unsaved object is left in the context, but NOT saved.
        let unsaved = Ledger(name: "未保存的无关账本", currencyCode: "CNY")
        context.insert(unsaved)

        let csv = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,,
        """
        #expect(throws: CSVService.CSVError.self) {
            try CSVImportService.importCSV(csv, into: target, context: context)
        }
        // The unrelated object was never committed — still pending in context.
        #expect(context.hasChanges)
        #expect(try context.fetch(FetchDescriptor<Ledger>()).count == 2)
        // Nothing from the import was written.
        #expect(try context.fetch(FetchDescriptor<Transaction>()).isEmpty)
    }

    @Test("Backup restore refuses to silently commit unrelated unsaved changes")
    func restoreRejectsDirtyContext() throws {
        let container = try makeMemoryContainer()
        let context = container.mainContext
        let graph = insertLedgerGraph(into: context, name: "基线", currency: "CNY", isDefault: true)
        let settings = AppSettings()
        settings.defaultLedgerID = graph.0.id
        context.insert(settings)
        // Leave unsaved changes (do not call save).
        let unsaved = Ledger(name: "未保存的无关账本", currencyCode: "CNY")
        context.insert(unsaved)

        let doc = try SnapshotBuilder.makeDocument(
            ledgers: [graph.0], accounts: [graph.1], categories: [graph.2],
            transactions: [], budgets: [], settings: [settings]
        )
        #expect(throws: BackupError.self) {
            try SnapshotBuilder.restore(doc, context: context)
        }
        // The unrelated unsaved object was not committed to the store.
        #expect(context.hasChanges)
        #expect(try context.fetch(FetchDescriptor<Ledger>()).count == 2)
    }
}
