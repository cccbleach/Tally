//
//  BackupService.swift
//  Tally
//
//  Full backup & restore as a single JSON document. Contains every reachable
//  entity so a restore can rebuild the whole local store.
//
//  Restore is "build new dataset": the caller clears the existing store and
//  re-inserts the snapshot, so a failed decode never leaves a half-written
//  state (decode fully before touching the store).
//

import Foundation

public struct BackupDocument: Codable, Equatable, Sendable {
    public var version: Int
    public let createdAt: Date

    public struct LedgerDTO: Codable, Equatable, Sendable {
        public var id: UUID
        public var name: String
        public var icon: String
        public var colorHex: String
        public var currencyCode: String
        public var isDefault: Bool
        public var createdAt: Date
    }

    public struct AccountDTO: Codable, Equatable, Sendable {
        public var id: UUID
        public var ledgerID: UUID
        public var name: String
        public var kindRaw: String
        public var currencyCode: String
        public var initialBalanceMinorUnits: Int64
        public var note: String
        public var isArchived: Bool
        public var sortOrder: Int
        public var createdAt: Date
    }

    public struct CategoryDTO: Codable, Equatable, Sendable {
        public var id: UUID
        public var ledgerID: UUID
        public var name: String
        public var icon: String
        public var colorHex: String
        public var kindRaw: String
        public var isSystem: Bool
        public var isEnabled: Bool
        public var sortOrder: Int
        public var createdAt: Date
    }

    public struct TransactionDTO: Codable, Equatable, Sendable {
        public var id: UUID
        public var ledgerID: UUID
        public var kindRaw: String
        public var amountMinorUnits: Int64
        public var currencyCode: String
        public var date: Date
        public var note: String
        public var payee: String
        public var isDeleted: Bool
        public var deletedAt: Date?
        public var createdAt: Date
        public var updatedAt: Date
        public var accountID: UUID?
        public var fromAccountID: UUID?
        public var toAccountID: UUID?
        public var categoryID: UUID?
        public var refundOfID: UUID?
    }

    public struct BudgetDTO: Codable, Equatable, Sendable {
        public var id: UUID
        public var ledgerID: UUID
        public var amountMinorUnits: Int64
        public var currencyCode: String
        public var categoryID: UUID?
        public var periodISO: String?
        public var isEnabled: Bool
        public var createdAt: Date
    }

    public struct SettingsDTO: Codable, Equatable, Sendable {
        public var id: UUID
        public var defaultCurrencyCode: String
        public var monthStartsOn: Int
        public var appearanceRaw: String
        public var biometricLockEnabled: Bool
        public var hasCompletedOnboarding: Bool
        public var defaultLedgerID: UUID?
        public var updatedAt: Date
    }

    public var ledgers: [LedgerDTO]
    public var accounts: [AccountDTO]
    public var categories: [CategoryDTO]
    public var transactions: [TransactionDTO]
    public var budgets: [BudgetDTO]
    public var settings: [SettingsDTO]

    public init(
        version: Int = 1,
        createdAt: Date = Date(),
        ledgers: [LedgerDTO] = [],
        accounts: [AccountDTO] = [],
        categories: [CategoryDTO] = [],
        transactions: [TransactionDTO] = [],
        budgets: [BudgetDTO] = [],
        settings: [SettingsDTO] = []
    ) {
        self.version = version
        self.createdAt = createdAt
        self.ledgers = ledgers
        self.accounts = accounts
        self.categories = categories
        self.transactions = transactions
        self.budgets = budgets
        self.settings = settings
    }
}

public enum BackupService {

    public static let currentVersion = 1

    public static func encode(_ document: BackupDocument) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(document)
    }

    public static func decode(_ data: Data) throws -> BackupDocument {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let doc = try decoder.decode(BackupDocument.self, from: data)
        // Only an explicitly supported version range is accepted. Both future
        // versions and illegal old versions (0 or negative) are rejected rather
        // than being silently coerced into V1.
        guard doc.version >= 1, doc.version <= currentVersion else {
            throw BackupError.unsupportedVersion(doc.version)
        }
        return doc
    }

    /// Explicitly identify whether a raw backup version number is supported.
    /// Kept as a tiny pure helper so tests can pin the accepted range.
    public static func supportedVersion(_ version: Int) -> Bool {
        version >= 1 && version <= currentVersion
    }
}

public enum BackupError: Error, LocalizedError {
    case unsupportedVersion(Int)
    case corrupt(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedVersion(let v): return "备份文件版本 \(v) 不受当前版本支持"
        case .corrupt(let message): return "备份文件无效：\(message)"
        }
    }
}
