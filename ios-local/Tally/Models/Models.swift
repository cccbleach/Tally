//
//  Models.swift
//  Tally
//
//  SwiftData model definitions.
//
//  Design rules:
//  - Amounts are stored as Int64 "minor units" (e.g. cents), never Double.
//  - Account balances are NOT stored redundantly; they are computed from the
//    initial balance plus the sum of related transactions. This keeps stats
//    correct when a historical transaction is edited or deleted.
//  - Deletion uses nullify / cascade rules so that deleting an account or a
//    category never silently destroys transactions.
//  - Transactions support a soft-delete flag so users can recover from
//    accidental deletion.
//

import Foundation
import SwiftData

// MARK: - Enums

public enum TransactionKind: String, Codable, CaseIterable, Sendable {
    case expense
    case income
    case transfer
    case refund

    public var displayName: String {
        switch self {
        case .expense: return "支出"
        case .income: return "收入"
        case .transfer: return "转账"
        case .refund: return "退款"
        }
    }
}

public enum AccountKind: String, Codable, CaseIterable, Sendable {
    case cash
    case debit      // 银行卡（储蓄卡）
    case credit     // 信用卡
    case ewallet    // 电子钱包
    case savings
    case other

    public var displayName: String {
        switch self {
        case .cash: return "现金"
        case .debit: return "银行卡"
        case .credit: return "信用卡"
        case .ewallet: return "电子钱包"
        case .savings: return "储蓄"
        case .other: return "其他"
        }
    }
}

public enum CategoryKind: String, Codable, CaseIterable, Sendable {
    case expense
    case income

    public var displayName: String {
        switch self {
        case .expense: return "支出"
        case .income: return "收入"
        }
    }
}

// MARK: - Ledger

@Model
public final class Ledger {
    @Attribute(.unique) public var id: UUID
    public var name: String
    public var icon: String
    public var colorHex: String
    public var currencyCode: String
    public var isDefault: Bool
    public var createdAt: Date

    @Relationship(deleteRule: .cascade, inverse: \Account.ledger)
    public var accounts: [Account] = []

    @Relationship(deleteRule: .cascade, inverse: \Category.ledger)
    public var categories: [Category] = []

    @Relationship(deleteRule: .cascade, inverse: \Transaction.ledger)
    public var transactions: [Transaction] = []

    @Relationship(deleteRule: .cascade, inverse: \Budget.ledger)
    public var budgets: [Budget] = []

    public init(
        name: String,
        icon: String = "book",
        colorHex: String = "0A84FF",
        currencyCode: String = "CNY",
        isDefault: Bool = false
    ) {
        self.id = UUID()
        self.name = name
        self.icon = icon
        self.colorHex = colorHex
        self.currencyCode = currencyCode
        self.isDefault = isDefault
        self.createdAt = Date()
    }
}

// MARK: - Account

@Model
public final class Account {
    @Attribute(.unique) public var id: UUID
    public var name: String
    public var kindRaw: String
    public var currencyCode: String
    /// Balance that existed before the first recorded transaction.
    public var initialBalanceMinorUnits: Int64
    public var note: String
    public var isArchived: Bool
    public var sortOrder: Int
    public var createdAt: Date

    public var ledger: Ledger?

    @Relationship(deleteRule: .nullify, inverse: \Transaction.account)
    public var transactions: [Transaction] = []

    @Relationship(deleteRule: .nullify, inverse: \Transaction.fromAccount)
    public var outgoingTransfers: [Transaction] = []

    @Relationship(deleteRule: .nullify, inverse: \Transaction.toAccount)
    public var incomingTransfers: [Transaction] = []

    public init(
        name: String,
        kind: AccountKind,
        currencyCode: String = "CNY",
        initialBalanceMinorUnits: Int64 = 0,
        note: String = "",
        isArchived: Bool = false,
        sortOrder: Int = 0
    ) {
        self.id = UUID()
        self.name = name
        self.kindRaw = kind.rawValue
        self.currencyCode = currencyCode
        self.initialBalanceMinorUnits = initialBalanceMinorUnits
        self.note = note
        self.isArchived = isArchived
        self.sortOrder = sortOrder
        self.createdAt = Date()
    }

    public var kind: AccountKind {
        get { AccountKind(rawValue: kindRaw) ?? .other }
        set { kindRaw = newValue.rawValue }
    }
}

// MARK: - Category

@Model
public final class Category {
    @Attribute(.unique) public var id: UUID
    public var name: String
    public var icon: String
    public var colorHex: String
    public var kindRaw: String
    public var isSystem: Bool
    public var isEnabled: Bool
    public var sortOrder: Int
    public var createdAt: Date

    public var ledger: Ledger?

    @Relationship(deleteRule: .nullify, inverse: \Transaction.category)
    public var transactions: [Transaction] = []

    public init(
        name: String,
        icon: String = "tag",
        colorHex: String = "0A84FF",
        kind: CategoryKind,
        isSystem: Bool = false,
        isEnabled: Bool = true,
        sortOrder: Int = 0
    ) {
        self.id = UUID()
        self.name = name
        self.icon = icon
        self.colorHex = colorHex
        self.kindRaw = kind.rawValue
        self.isSystem = isSystem
        self.isEnabled = isEnabled
        self.sortOrder = sortOrder
        self.createdAt = Date()
    }

    public var kind: CategoryKind {
        get { CategoryKind(rawValue: kindRaw) ?? .expense }
        set { kindRaw = newValue.rawValue }
    }
}

// MARK: - Transaction

@Model
public final class Transaction {
    @Attribute(.unique) public var id: UUID
    public var kindRaw: String
    public var amountMinorUnits: Int64
    public var currencyCode: String
    public var date: Date
    public var note: String
    public var payee: String
    /// True when this transaction has been soft-deleted (recoverable trash).
    public var isDeleted: Bool
    public var deletedAt: Date?
    public var createdAt: Date
    public var updatedAt: Date

    public var ledger: Ledger?

    /// The account money was taken from / deposited to (expense / income / refund).
    public var account: Account?
    /// Transfer source.
    public var fromAccount: Account?
    /// Transfer destination.
    public var toAccount: Account?
    /// Category (expense / income / refund).
    public var category: Category?
    /// When this is a refund, points at the original transaction.
    public var refundOf: Transaction?

    /// Transactions that refund this one (reverse direction).
    @Relationship(deleteRule: .nullify, inverse: \Transaction.refundOf)
    public var refunds: [Transaction] = []

    public init(
        kind: TransactionKind,
        amountMinorUnits: Int64,
        currencyCode: String,
        date: Date,
        account: Account? = nil,
        fromAccount: Account? = nil,
        toAccount: Account? = nil,
        category: Category? = nil,
        refundOf: Transaction? = nil,
        note: String = "",
        payee: String = ""
    ) {
        self.id = UUID()
        self.kindRaw = kind.rawValue
        self.amountMinorUnits = amountMinorUnits
        self.currencyCode = currencyCode
        self.date = date
        self.account = account
        self.fromAccount = fromAccount
        self.toAccount = toAccount
        self.category = category
        self.refundOf = refundOf
        self.note = note
        self.payee = payee
        self.isDeleted = false
        self.deletedAt = nil
        self.createdAt = Date()
        self.updatedAt = Date()
    }

    public var kind: TransactionKind {
        get { TransactionKind(rawValue: kindRaw) ?? .expense }
        set { kindRaw = newValue.rawValue }
    }

    public var isTransfer: Bool { kind == .transfer }

    public var money: Money { Money(minorUnits: amountMinorUnits, currencyCode: currencyCode) }
}

// MARK: - Budget

@Model
public final class Budget {
    @Attribute(.unique) public var id: UUID
    public var amountMinorUnits: Int64
    public var currencyCode: String
    /// nil means a whole-ledger budget; otherwise a category-specific budget.
    public var categoryID: UUID?
    /// Optional: if set, the budget applies only to this month period (e.g. "2026-08").
    public var periodISO: String?
    public var isEnabled: Bool
    public var createdAt: Date

    public var ledger: Ledger?

    public init(
        amountMinorUnits: Int64,
        currencyCode: String,
        categoryID: UUID? = nil,
        periodISO: String? = nil,
        isEnabled: Bool = true
    ) {
        self.id = UUID()
        self.amountMinorUnits = amountMinorUnits
        self.currencyCode = currencyCode
        self.categoryID = categoryID
        self.periodISO = periodISO
        self.isEnabled = isEnabled
        self.createdAt = Date()
    }
}

// MARK: - AppSettings (single-row)

@Model
public final class AppSettings {
    @Attribute(.unique) public var id: UUID
    public var defaultCurrencyCode: String
    /// Day of month (1...31) on which a reporting month starts.
    public var monthStartsOn: Int
    public var appearanceRaw: String
    public var biometricLockEnabled: Bool
    public var hasCompletedOnboarding: Bool
    public var defaultLedgerID: UUID?
    public var updatedAt: Date

    public init() {
        self.id = UUID()
        self.defaultCurrencyCode = "CNY"
        self.monthStartsOn = 1
        self.appearanceRaw = "system"
        self.biometricLockEnabled = false
        self.hasCompletedOnboarding = false
        self.defaultLedgerID = nil
        self.updatedAt = Date()
    }

    public enum Appearance: String, CaseIterable {
        case system = "system"
        case light = "light"
        case dark = "dark"

        public var displayName: String {
            switch self {
            case .system: return "跟随系统"
            case .light: return "浅色"
            case .dark: return "深色"
            }
        }
    }

    public var appearance: Appearance {
        get { Appearance(rawValue: appearanceRaw) ?? .system }
        set { appearanceRaw = newValue.rawValue }
    }
}
