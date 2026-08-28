//
//  SnapshotBuilder.swift
//  Tally
//
//  Converts SwiftData live objects to/from BackupDocument DTOs.
//

import Foundation
import SwiftData

/// Test-only fault-injection point for restore. Named for exactly when the
/// injected failure fires: *after* the object at the given index has been
/// inserted into the context. Internal — never part of the production API and
/// only reachable from test bundles through `@testable import`.
enum RestoreFailurePoint: Equatable {
    case afterInsertedLedger(Int)
    case afterInsertedAccount(Int)
    case afterInsertedCategory(Int)
    case afterInsertedTransaction(Int)
    case afterInsertedBudget(Int)
    case afterInsertedSettings(Int)
}

public enum SnapshotBuilder {

    public static func makeDocument(
        ledgers: [Ledger],
        accounts: [Account],
        categories: [Category],
        transactions: [Transaction],
        budgets: [Budget],
        settings: [AppSettings]
    ) throws -> BackupDocument {
        var doc = BackupDocument()
        doc.ledgers = ledgers.map { l in
            BackupDocument.LedgerDTO(
                id: l.id, name: l.name, icon: l.icon, colorHex: l.colorHex,
                currencyCode: l.currencyCode, isDefault: l.isDefault, createdAt: l.createdAt
            )
        }
        doc.accounts = try accounts.map { a in
            guard let ledgerID = a.ledger?.id else { throw BackupError.corrupt("账户缺少所属账本") }
            return BackupDocument.AccountDTO(
                id: a.id, ledgerID: ledgerID, name: a.name, kindRaw: a.kindRaw,
                currencyCode: a.currencyCode, initialBalanceMinorUnits: a.initialBalanceMinorUnits,
                note: a.note, isArchived: a.isArchived, sortOrder: a.sortOrder, createdAt: a.createdAt
            )
        }
        doc.categories = try categories.map { c in
            guard let ledgerID = c.ledger?.id else { throw BackupError.corrupt("分类缺少所属账本") }
            return BackupDocument.CategoryDTO(
                id: c.id, ledgerID: ledgerID, name: c.name, icon: c.icon,
                colorHex: c.colorHex, kindRaw: c.kindRaw, isSystem: c.isSystem,
                isEnabled: c.isEnabled, sortOrder: c.sortOrder, createdAt: c.createdAt
            )
        }
        doc.transactions = try transactions.map { t in
            guard let ledgerID = t.ledger?.id else { throw BackupError.corrupt("交易缺少所属账本") }
            return BackupDocument.TransactionDTO(
                id: t.id, ledgerID: ledgerID, kindRaw: t.kindRaw,
                amountMinorUnits: t.amountMinorUnits, currencyCode: t.currencyCode,
                date: t.date, note: t.note, payee: t.payee,
                isDeleted: t.isDeleted, deletedAt: t.deletedAt,
                createdAt: t.createdAt, updatedAt: t.updatedAt,
                accountID: t.account?.id, fromAccountID: t.fromAccount?.id,
                toAccountID: t.toAccount?.id, categoryID: t.category?.id, refundOfID: t.refundOf?.id
            )
        }
        doc.budgets = try budgets.map { b in
            guard let ledgerID = b.ledger?.id else { throw BackupError.corrupt("预算缺少所属账本") }
            return BackupDocument.BudgetDTO(
                id: b.id, ledgerID: ledgerID, amountMinorUnits: b.amountMinorUnits,
                currencyCode: b.currencyCode, categoryID: b.categoryID,
                periodISO: b.periodISO, isEnabled: b.isEnabled, createdAt: b.createdAt
            )
        }
        doc.settings = settings.map { s in
            BackupDocument.SettingsDTO(
                id: s.id, defaultCurrencyCode: s.defaultCurrencyCode, monthStartsOn: s.monthStartsOn,
                appearanceRaw: s.appearanceRaw, biometricLockEnabled: s.biometricLockEnabled,
                hasCompletedOnboarding: s.hasCompletedOnboarding,
                defaultLedgerID: s.defaultLedgerID, updatedAt: s.updatedAt
            )
        }
        try validate(doc)
        return doc
    }

    /// Replace all data in the context with the snapshot content.
    /// This performs a full, one-shot rebuild: all existing managed objects are
    /// deleted first, then the snapshot is re-created. If any DTO fails to
    /// round-trip we abort before touching the store (decode happens earlier).
    public static func restore(_ doc: BackupDocument, context: ModelContext) throws {
        try restore(doc, context: context, failurePoint: nil)
    }

    /// Test-only seam: allows injecting a failure after the existing data has
    /// been deleted and the new objects partially inserted, to prove the whole
    /// operation rolls back (old data is never silently half-replaced).
    /// Internal — only reachable from test bundles via `@testable import`, and
    /// the failure point is an internal enum so a typo can never silently
    /// disable the injection.
    static func restoreWithFailure(_ doc: BackupDocument, context: ModelContext, failurePoint: RestoreFailurePoint) throws {
        try restore(doc, context: context, failurePoint: failurePoint)
    }

    private static func restore(_ doc: BackupDocument, context: ModelContext, failurePoint: RestoreFailurePoint?) throws {
        // Validate the entire object graph before touching the live store.
        try validate(doc)
        // Never silently commit unrelated unsaved changes. Require a clean
        // context before restoring so a failed restore cannot persist changes
        // that have nothing to do with this backup.
        guard !context.hasChanges else {
            throw BackupError.corrupt("无法恢复：当前有未保存的改动，请先保存或取消后再恢复")
        }
        let previousAutosave = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = previousAutosave }

        do {
            try context.transaction {
                let ledgers = try context.fetch(FetchDescriptor<Ledger>())
                let accounts = try context.fetch(FetchDescriptor<Account>())
                let categories = try context.fetch(FetchDescriptor<Category>())
                let transactions = try context.fetch(FetchDescriptor<Transaction>())
                let budgets = try context.fetch(FetchDescriptor<Budget>())
                let settings = try context.fetch(FetchDescriptor<AppSettings>())
                for object in transactions { context.delete(object) }
                for object in budgets { context.delete(object) }
                for object in accounts { context.delete(object) }
                for object in categories { context.delete(object) }
                for object in ledgers { context.delete(object) }
                for object in settings { context.delete(object) }

                var ledgerByID: [UUID: Ledger] = [:]
                for (index, dto) in doc.ledgers.enumerated() {
                    let ledger = Ledger(name: dto.name, icon: dto.icon, colorHex: dto.colorHex, currencyCode: dto.currencyCode, isDefault: dto.isDefault)
                    ledger.id = dto.id
                    ledger.createdAt = dto.createdAt
                    context.insert(ledger)
                    ledgerByID[dto.id] = ledger
                    // Injected failure fires *after* this ledger is inserted, so
                    // the test proves rollback with a new object already present.
                    if failurePoint == .afterInsertedLedger(index) {
                        throw BackupError.corrupt("注入的恢复故障")
                    }
                }

                var accountByID: [UUID: Account] = [:]
                for (index, dto) in doc.accounts.enumerated() {
                    guard let kind = AccountKind(rawValue: dto.kindRaw) else { throw BackupError.corrupt("账户类型无效") }
                    let account = Account(name: dto.name, kind: kind, currencyCode: dto.currencyCode,
                                          initialBalanceMinorUnits: dto.initialBalanceMinorUnits,
                                          note: dto.note, isArchived: dto.isArchived, sortOrder: dto.sortOrder)
                    account.id = dto.id
                    account.createdAt = dto.createdAt
                    account.ledger = ledgerByID[dto.ledgerID]
                    context.insert(account)
                    accountByID[dto.id] = account
                    if failurePoint == .afterInsertedAccount(index) {
                        throw BackupError.corrupt("注入的恢复故障")
                    }
                }

                var categoryByID: [UUID: Category] = [:]
                for (index, dto) in doc.categories.enumerated() {
                    guard let kind = CategoryKind(rawValue: dto.kindRaw) else { throw BackupError.corrupt("分类类型无效") }
                    let category = Category(name: dto.name, icon: dto.icon, colorHex: dto.colorHex,
                                            kind: kind, isSystem: dto.isSystem,
                                            isEnabled: dto.isEnabled, sortOrder: dto.sortOrder)
                    category.id = dto.id
                    category.createdAt = dto.createdAt
                    category.ledger = ledgerByID[dto.ledgerID]
                    context.insert(category)
                    categoryByID[dto.id] = category
                    if failurePoint == .afterInsertedCategory(index) {
                        throw BackupError.corrupt("注入的恢复故障")
                    }
                }

                var transactionByID: [UUID: Transaction] = [:]
                for (index, dto) in doc.transactions.enumerated() {
                    guard let kind = TransactionKind(rawValue: dto.kindRaw) else { throw BackupError.corrupt("交易类型无效") }
                    let transaction = Transaction(
                        kind: kind,
                        amountMinorUnits: dto.amountMinorUnits,
                        currencyCode: dto.currencyCode,
                        date: dto.date,
                        account: dto.accountID.flatMap { accountByID[$0] },
                        fromAccount: dto.fromAccountID.flatMap { accountByID[$0] },
                        toAccount: dto.toAccountID.flatMap { accountByID[$0] },
                        category: dto.categoryID.flatMap { categoryByID[$0] },
                        note: dto.note,
                        payee: dto.payee
                    )
                    transaction.id = dto.id
                    transaction.isDeleted = dto.isDeleted
                    transaction.deletedAt = dto.deletedAt
                    transaction.createdAt = dto.createdAt
                    transaction.updatedAt = dto.updatedAt
                    transaction.ledger = ledgerByID[dto.ledgerID]
                    context.insert(transaction)
                    transactionByID[dto.id] = transaction
                    if failurePoint == .afterInsertedTransaction(index) {
                        throw BackupError.corrupt("注入的恢复故障")
                    }
                }
                for dto in doc.transactions {
                    if let refundID = dto.refundOfID {
                        transactionByID[dto.id]?.refundOf = transactionByID[refundID]
                    }
                }

                for (index, dto) in doc.budgets.enumerated() {
                    let budget = Budget(amountMinorUnits: dto.amountMinorUnits, currencyCode: dto.currencyCode,
                                        categoryID: dto.categoryID, periodISO: dto.periodISO, isEnabled: dto.isEnabled)
                    budget.id = dto.id
                    budget.createdAt = dto.createdAt
                    budget.ledger = ledgerByID[dto.ledgerID]
                    context.insert(budget)
                    if failurePoint == .afterInsertedBudget(index) {
                        throw BackupError.corrupt("注入的恢复故障")
                    }
                }

                for (index, dto) in doc.settings.enumerated() {
                    let settings = AppSettings()
                    settings.id = dto.id
                    settings.defaultCurrencyCode = dto.defaultCurrencyCode
                    settings.monthStartsOn = dto.monthStartsOn
                    settings.appearanceRaw = dto.appearanceRaw
                    settings.biometricLockEnabled = dto.biometricLockEnabled
                    settings.hasCompletedOnboarding = dto.hasCompletedOnboarding
                    settings.defaultLedgerID = dto.defaultLedgerID
                    settings.updatedAt = dto.updatedAt
                    context.insert(settings)
                    if failurePoint == .afterInsertedSettings(index) {
                        throw BackupError.corrupt("注入的恢复故障")
                    }
                }
            }
        } catch {
            context.rollback()
            throw error
        }
    }

    static func validate(_ doc: BackupDocument) throws {
        let ledgerIDs = Set(doc.ledgers.map(\.id))
        let accountIDs = Set(doc.accounts.map(\.id))
        let categoryIDs = Set(doc.categories.map(\.id))
        let transactionIDs = Set(doc.transactions.map(\.id))
        let budgetIDs = Set(doc.budgets.map(\.id))
        let settingsIDs = Set(doc.settings.map(\.id))
        guard doc.ledgers.count == ledgerIDs.count,
              doc.accounts.count == accountIDs.count,
              doc.categories.count == categoryIDs.count,
              doc.transactions.count == transactionIDs.count,
              doc.budgets.count == budgetIDs.count,
              doc.settings.count == settingsIDs.count else {
            throw BackupError.corrupt("备份中包含重复 ID")
        }
        guard !doc.ledgers.isEmpty else { throw BackupError.corrupt("备份中没有账本") }
        guard doc.settings.count == 1 else { throw BackupError.corrupt("备份必须且只能包含一份设置") }

        let ledgerByID = Dictionary(uniqueKeysWithValues: doc.ledgers.map { ($0.id, $0) })
        let accountLedgerByID = Dictionary(uniqueKeysWithValues: doc.accounts.map { ($0.id, $0.ledgerID) })
        let categoryLedgerByID = Dictionary(uniqueKeysWithValues: doc.categories.map { ($0.id, $0.ledgerID) })
        let transactionByID = Dictionary(uniqueKeysWithValues: doc.transactions.map { ($0.id, $0) })
        guard doc.ledgers.filter(\.isDefault).count == 1 else { throw BackupError.corrupt("备份必须且只能包含一个默认账本") }
        for ledger in doc.ledgers where Currencies.supportedInfo(forCode: ledger.currencyCode) == nil {
            throw BackupError.corrupt("账本包含不支持的币种：\(ledger.currencyCode)")
        }
        for a in doc.accounts where !ledgerIDs.contains(a.ledgerID) {
            throw BackupError.corrupt("账户引用了不存在的账本")
        }
        for account in doc.accounts {
            guard AccountKind(rawValue: account.kindRaw) != nil else { throw BackupError.corrupt("账户类型无效") }
            guard account.currencyCode == ledgerByID[account.ledgerID]?.currencyCode else {
                throw BackupError.corrupt("账户币种与账本不一致")
            }
        }
        for c in doc.categories where !ledgerIDs.contains(c.ledgerID) {
            throw BackupError.corrupt("分类引用了不存在的账本")
        }
        for category in doc.categories where CategoryKind(rawValue: category.kindRaw) == nil {
            throw BackupError.corrupt("分类类型无效")
        }
        for t in doc.transactions where !ledgerIDs.contains(t.ledgerID) {
            throw BackupError.corrupt("交易引用了不存在的账本")
        }
        for b in doc.budgets where !ledgerIDs.contains(b.ledgerID) {
            throw BackupError.corrupt("预算引用了不存在的账本")
        }
        for budget in doc.budgets {
            guard budget.amountMinorUnits > 0 else { throw BackupError.corrupt("预算金额必须大于 0") }
            guard budget.currencyCode == ledgerByID[budget.ledgerID]?.currencyCode else {
                throw BackupError.corrupt("预算币种与账本不一致")
            }
            if let categoryID = budget.categoryID, categoryLedgerByID[categoryID] != budget.ledgerID {
                throw BackupError.corrupt("预算分类不属于同一账本")
            }
        }
        for t in doc.transactions {
            guard let kind = TransactionKind(rawValue: t.kindRaw) else { throw BackupError.corrupt("交易类型无效") }
            guard t.amountMinorUnits > 0 else { throw BackupError.corrupt("交易金额必须大于 0") }
            guard t.currencyCode == ledgerByID[t.ledgerID]?.currencyCode else {
                throw BackupError.corrupt("交易币种与账本不一致")
            }
            if let accountID = t.accountID, !accountIDs.contains(accountID) {
                throw BackupError.corrupt("交易引用了不存在的账户")
            }
            if let from = t.fromAccountID, !accountIDs.contains(from) {
                throw BackupError.corrupt("转账引用了不存在的转出账户")
            }
            if let to = t.toAccountID, !accountIDs.contains(to) {
                throw BackupError.corrupt("转账引用了不存在的转入账户")
            }
            if let categoryID = t.categoryID, !categoryIDs.contains(categoryID) {
                throw BackupError.corrupt("交易引用了不存在的分类")
            }
            if let refundID = t.refundOfID, !transactionIDs.contains(refundID) {
                throw BackupError.corrupt("退款引用了不存在的原交易")
            }
            if let accountID = t.accountID, accountLedgerByID[accountID] != t.ledgerID {
                throw BackupError.corrupt("交易账户不属于同一账本")
            }
            if let from = t.fromAccountID, accountLedgerByID[from] != t.ledgerID {
                throw BackupError.corrupt("转出账户不属于同一账本")
            }
            if let to = t.toAccountID, accountLedgerByID[to] != t.ledgerID {
                throw BackupError.corrupt("转入账户不属于同一账本")
            }
            if let categoryID = t.categoryID, categoryLedgerByID[categoryID] != t.ledgerID {
                throw BackupError.corrupt("交易分类不属于同一账本")
            }
            switch kind {
            case .transfer:
                guard t.accountID == nil, t.categoryID == nil,
                      let from = t.fromAccountID, let to = t.toAccountID, from != to else {
                    throw BackupError.corrupt("转账账户结构无效")
                }
            case .expense, .income:
                guard t.accountID != nil, t.categoryID != nil,
                      t.fromAccountID == nil, t.toAccountID == nil, t.refundOfID == nil else {
                    throw BackupError.corrupt("收支交易结构无效")
                }
            case .refund:
                guard t.accountID != nil, t.categoryID != nil,
                      t.fromAccountID == nil, t.toAccountID == nil else {
                    throw BackupError.corrupt("退款交易结构无效")
                }
                if let refundID = t.refundOfID {
                    guard let origin = transactionByID[refundID], origin.kindRaw == TransactionKind.expense.rawValue,
                          origin.ledgerID == t.ledgerID else {
                        throw BackupError.corrupt("退款原交易无效")
                    }
                }
            }
        }

        guard let settings = doc.settings.first,
              (1...31).contains(settings.monthStartsOn),
              AppSettings.Appearance(rawValue: settings.appearanceRaw) != nil,
              Currencies.supportedInfo(forCode: settings.defaultCurrencyCode) != nil,
              settings.defaultLedgerID.map(ledgerIDs.contains) ?? false else {
            throw BackupError.corrupt("应用设置无效")
        }
    }
}
