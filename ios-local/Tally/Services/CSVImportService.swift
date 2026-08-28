//
//  CSVImportService.swift
//  Tally
//
//  Validates an entire CSV before writing, then imports it in one SwiftData
//  transaction. No account, category, or transaction is left behind on error.
//

import Foundation
import SwiftData

public struct CSVImportResult: Equatable, Sendable {
    public let insertedCount: Int
    public let skippedDuplicateCount: Int
}

/// Test-only fault-injection point for CSV import. A value of
/// `afterInsertedRows(n)` fires when the `n`-th transaction row (and the
/// account/category it carries) has just been written, before any further rows.
/// Internal — never part of the production API; only reachable from test
/// bundles through `@testable import`.
enum CSVImportFailurePoint: Equatable {
    case afterInsertedRows(Int)
}

@MainActor
public enum CSVImportService {
    private struct PreparedRow {
        let kind: TransactionKind
        let date: Date
        let amountMinorUnits: Int64
        let currencyCode: String
        let accountName: String
        let counterAccountName: String
        let categoryName: String
        let payee: String
        let note: String
        let sourceID: UUID?
        let refundOfID: UUID?

        var duplicateKey: String {
            [
                kind.rawValue,
                CSVService.isoDate.string(from: date),
                String(amountMinorUnits),
                currencyCode,
                accountName.normalizedImportName,
                counterAccountName.normalizedImportName,
                categoryName.normalizedImportName,
                payee,
                note,
                refundOfID?.uuidString ?? "",
            ].joined(separator: "\u{1F}")
        }
    }

    public static func importCSV(
        _ text: String,
        into ledger: Ledger,
        context: ModelContext
    ) throws -> CSVImportResult {
        try importCSV(text, into: ledger, context: context, failurePoint: nil)
    }

    /// Test-only seam: injects a failure after `n` transaction rows have been
    /// written so tests can prove the whole import rolls back. Internal — not
    /// part of the production API, only reachable via `@testable import`.
    static func importCSVWithFailure(
        _ text: String,
        into ledger: Ledger,
        context: ModelContext,
        failurePoint: CSVImportFailurePoint
    ) throws -> CSVImportResult {
        try importCSV(text, into: ledger, context: context, failurePoint: failurePoint)
    }

    private static func importCSV(
        _ text: String,
        into ledger: Ledger,
        context: ModelContext,
        failurePoint: CSVImportFailurePoint?
    ) throws -> CSVImportResult {
        // Never silently commit unrelated unsaved changes. Require a clean
        // context before importing so a failed import cannot persist changes
        // that have nothing to do with this CSV.
        guard !context.hasChanges else {
            throw CSVService.CSVError.malformed("无法导入：当前有未保存的改动，请先保存或取消后再导入")
        }

        let rows = try CSVService.parse(text)
        let prepared = try prepare(rows, ledger: ledger)

        let allTransactions = try context.fetch(FetchDescriptor<Transaction>())
        let ledgerTransactions = allTransactions.filter { $0.ledger?.id == ledger.id }
        let existingByID = Dictionary(uniqueKeysWithValues: allTransactions.map { ($0.id, $0) })
        let existingKeyCounts = Dictionary(grouping: ledgerTransactions, by: duplicateKey(for:)).mapValues(\.count)

        var seenKeyCounts: [String: Int] = [:]
        var rowsToInsert: [PreparedRow] = []
        var skipped = 0
        for row in prepared {
            if let sourceID = row.sourceID, let existing = existingByID[sourceID] {
                guard existing.ledger?.id == ledger.id else {
                    throw CSVService.CSVError.malformed("交易 ID 已存在于其他账本：\(sourceID.uuidString)")
                }
                // Idempotent re-import is only allowed when the content matches;
                // an identical ID with different data must be an explicit error,
                // never a silent overwrite.
                guard contentMatches(row, existing) else {
                    throw CSVService.CSVError.malformed("交易 ID \(sourceID.uuidString) 已存在但内容不一致，不能静默覆盖")
                }
                skipped += 1
                continue
            }
            if row.sourceID == nil {
                seenKeyCounts[row.duplicateKey, default: 0] += 1
                if existingKeyCounts[row.duplicateKey, default: 0] >= seenKeyCounts[row.duplicateKey, default: 0] {
                    skipped += 1
                    continue
                }
            }
            rowsToInsert.append(row)
        }

        // Resolve every refund reference before starting the write transaction.
        // A referenced expense may already exist in this ledger or be another
        // identified row in the same import file.
        let incomingByID = Dictionary(uniqueKeysWithValues: rowsToInsert.compactMap { row in
            row.sourceID.map { ($0, row) }
        })
        for row in rowsToInsert where row.kind == .refund {
            guard let refundOfID = row.refundOfID else { continue }
            if let incoming = incomingByID[refundOfID] {
                guard incoming.kind == .expense else {
                    throw CSVService.CSVError.malformed("退款引用的原交易不是支出：\(refundOfID.uuidString)")
                }
            } else {
                guard let existing = existingByID[refundOfID],
                      existing.ledger?.id == ledger.id,
                      existing.kind == .expense else {
                    throw CSVService.CSVError.malformed("退款引用的原交易无效：\(refundOfID.uuidString)")
                }
            }
        }

        let previousAutosave = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = previousAutosave }

        do {
            try context.transaction {
                let allAccounts = try context.fetch(FetchDescriptor<Account>())
                let allCategories = try context.fetch(FetchDescriptor<Category>())
                var accountByName: [String: Account] = [:]
                for account in allAccounts where account.ledger?.id == ledger.id {
                    accountByName[account.name.normalizedImportName] = account
                }
                var categoryByKey: [String: Category] = [:]
                for category in allCategories where category.ledger?.id == ledger.id {
                    categoryByKey[categoryKey(name: category.name, kind: category.kind)] = category
                }

                var transactionByID = existingByID
                var inserted: [(PreparedRow, Transaction)] = []
                for (index, row) in rowsToInsert.enumerated() {
                    // Fires when `index` rows have already been inserted (this
                    // row is the (index+1)-th), proving a partial write is
                    // rolled back.
                    if failurePoint == .afterInsertedRows(index) {
                        throw CSVService.CSVError.malformed("注入的事务中途故障")
                    }
                    let fromOrPrimary = resolveAccount(
                        name: row.accountName,
                        defaultKind: .cash,
                        ledger: ledger,
                        map: &accountByName,
                        context: context
                    )
                    let counter = row.kind == .transfer
                        ? resolveAccount(name: row.counterAccountName, defaultKind: .other, ledger: ledger, map: &accountByName, context: context)
                        : nil
                    let categoryKind: CategoryKind = row.kind == .income ? .income : .expense
                    let category = row.kind == .transfer
                        ? nil
                        : resolveCategory(name: row.categoryName, kind: categoryKind, ledger: ledger, map: &categoryByKey, context: context)

                    let transaction = Transaction(
                        kind: row.kind,
                        amountMinorUnits: row.amountMinorUnits,
                        currencyCode: row.currencyCode,
                        date: row.date,
                        account: row.kind == .transfer ? nil : fromOrPrimary,
                        fromAccount: row.kind == .transfer ? fromOrPrimary : nil,
                        toAccount: row.kind == .transfer ? counter : nil,
                        category: category,
                        note: row.note,
                        payee: row.payee
                    )
                    if let sourceID = row.sourceID { transaction.id = sourceID }
                    transaction.ledger = ledger
                    context.insert(transaction)
                    transactionByID[transaction.id] = transaction
                    inserted.append((row, transaction))
                }

                for (row, transaction) in inserted where row.kind == .refund {
                    if let refundOfID = row.refundOfID {
                        guard let original = transactionByID[refundOfID],
                              original.ledger?.id == ledger.id,
                              original.kind == .expense else {
                            throw CSVService.CSVError.malformed("退款引用的原交易无效：\(refundOfID.uuidString)")
                        }
                        transaction.refundOf = original
                    }
                }
            }
        } catch {
            context.rollback()
            throw error
        }

        return CSVImportResult(insertedCount: rowsToInsert.count, skippedDuplicateCount: skipped)
    }

    private static func prepare(_ rows: [CSVService.Row], ledger: Ledger) throws -> [PreparedRow] {
        var result: [PreparedRow] = []
        var sourceIDs: Set<UUID> = []
        for (index, row) in rows.enumerated() {
            let line = index + 2
            guard let kind = TransactionKind(rawValue: row.type.lowercased()) else {
                throw CSVService.CSVError.malformed("第 \(line) 行交易类型无效：\(row.type)")
            }
            guard let currency = Currencies.supportedInfo(forCode: row.currency) else {
                throw CSVService.CSVError.malformed("第 \(line) 行币种不受支持：\(row.currency)")
            }
            guard currency.code == ledger.currencyCode else {
                throw CSVService.CSVError.malformed("第 \(line) 行币种与当前账本不一致")
            }
            guard let amount = currency.minorUnits(fromString: row.amount), amount > 0 else {
                throw CSVService.CSVError.malformed("第 \(line) 行金额无效：\(row.amount)")
            }
            guard let date = CSVService.isoDate.date(from: row.date),
                  CSVService.isoDate.string(from: date) == row.date else {
                throw CSVService.CSVError.malformed("第 \(line) 行日期无效：\(row.date)")
            }

            let accountName = row.account.trimmedImportName
            let counterName = row.counterAccount.trimmedImportName
            let categoryName = row.category.trimmedImportName
            switch kind {
            case .transfer:
                guard !accountName.isEmpty, !counterName.isEmpty,
                      accountName.normalizedImportName != counterName.normalizedImportName else {
                    throw CSVService.CSVError.malformed("第 \(line) 行转账需要两个不同账户")
                }
            case .expense, .income, .refund:
                guard !accountName.isEmpty, !categoryName.isEmpty else {
                    throw CSVService.CSVError.malformed("第 \(line) 行缺少账户或分类")
                }
            }

            let sourceID = try parseUUID(row.id, field: "交易 ID", line: line)
            if let sourceID, !sourceIDs.insert(sourceID).inserted {
                throw CSVService.CSVError.malformed("第 \(line) 行交易 ID 重复")
            }
            let refundOfID = try parseUUID(row.refundOfID, field: "退款原交易 ID", line: line)
            if kind != .refund, refundOfID != nil {
                throw CSVService.CSVError.malformed("第 \(line) 行非退款交易不能指定退款原交易")
            }

            result.append(PreparedRow(
                kind: kind,
                date: date,
                amountMinorUnits: amount,
                currencyCode: currency.code,
                accountName: accountName,
                counterAccountName: counterName,
                categoryName: categoryName,
                payee: row.payee,
                note: row.note,
                sourceID: sourceID,
                refundOfID: refundOfID
            ))
        }

        let preparedByID = Dictionary(uniqueKeysWithValues: result.compactMap { row in row.sourceID.map { ($0, row) } })
        for row in result where row.kind == .refund {
            if let refundOfID = row.refundOfID, let localOrigin = preparedByID[refundOfID], localOrigin.kind != .expense {
                throw CSVService.CSVError.malformed("退款只能关联支出交易")
            }
        }
        return result
    }

    /// Whether an incoming row is an exact semantic match for an existing
    /// transaction with the same stable ID. Date comparison is at day
    /// precision because the CSV format only preserves yyyy-MM-dd.
    private static func contentMatches(_ row: PreparedRow, _ existing: Transaction) -> Bool {
        let existingAccount = existing.kind == .transfer ? (existing.fromAccount?.name ?? "") : (existing.account?.name ?? "")
        let existingCounter = existing.kind == .transfer ? (existing.toAccount?.name ?? "") : ""
        let existingCategory = existing.kind == .transfer ? "" : (existing.category?.name ?? "")
        return row.kind == existing.kind
            && CSVService.isoDate.string(from: row.date) == CSVService.isoDate.string(from: existing.date)
            && row.amountMinorUnits == existing.amountMinorUnits
            && row.currencyCode == existing.currencyCode
            && row.accountName.normalizedImportName == existingAccount.normalizedImportName
            && row.counterAccountName.normalizedImportName == existingCounter.normalizedImportName
            && row.categoryName.normalizedImportName == existingCategory.normalizedImportName
            && row.payee == existing.payee
            && row.note == existing.note
            && row.refundOfID == existing.refundOf?.id
    }

    private static func parseUUID(_ value: String, field: String, line: Int) throws -> UUID? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let id = UUID(uuidString: trimmed) else {
            throw CSVService.CSVError.malformed("第 \(line) 行\(field)无效")
        }
        return id
    }

    private static func resolveAccount(
        name: String,
        defaultKind: AccountKind,
        ledger: Ledger,
        map: inout [String: Account],
        context: ModelContext
    ) -> Account {
        let key = name.normalizedImportName
        if let existing = map[key] { return existing }
        let account = Account(name: name, kind: defaultKind, currencyCode: ledger.currencyCode)
        account.ledger = ledger
        context.insert(account)
        map[key] = account
        return account
    }

    private static func resolveCategory(
        name: String,
        kind: CategoryKind,
        ledger: Ledger,
        map: inout [String: Category],
        context: ModelContext
    ) -> Category {
        let key = categoryKey(name: name, kind: kind)
        if let existing = map[key] { return existing }
        let category = Category(name: name, icon: "tag", colorHex: "0A84FF", kind: kind)
        category.ledger = ledger
        context.insert(category)
        map[key] = category
        return category
    }

    private static func categoryKey(name: String, kind: CategoryKind) -> String {
        kind.rawValue + ":" + name.normalizedImportName
    }

    private static func duplicateKey(for transaction: Transaction) -> String {
        let row = CSVService.Row(
            type: transaction.kind.rawValue,
            date: CSVService.isoDate.string(from: transaction.date),
            amount: String(transaction.amountMinorUnits),
            currency: transaction.currencyCode,
            account: transaction.kind == .transfer ? transaction.fromAccount?.name ?? "" : transaction.account?.name ?? "",
            counterAccount: transaction.kind == .transfer ? transaction.toAccount?.name ?? "" : "",
            category: transaction.category?.name ?? "",
            payee: transaction.payee,
            note: transaction.note,
            refundOfID: transaction.refundOf?.id.uuidString ?? ""
        )
        return [
            row.type,
            row.date,
            row.amount,
            row.currency,
            row.account.normalizedImportName,
            row.counterAccount.normalizedImportName,
            row.category.normalizedImportName,
            row.payee,
            row.note,
            row.refundOfID,
        ].joined(separator: "\u{1F}")
    }
}

private extension String {
    var trimmedImportName: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var normalizedImportName: String {
        trimmedImportName.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
    }
}
