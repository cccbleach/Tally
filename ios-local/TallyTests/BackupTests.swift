//
//  BackupTests.swift
//  TallyTests
//
//  Tests for backup encoding/decoding and validation.
//

import Testing
import Foundation
@testable import Tally

@Suite("Backup & Restore")
struct BackupTests {

    @Test("Backup document encodes and decodes")
    func encodeDecodeRoundTrip() throws {
        var doc = BackupDocument()
        let ledgerID = UUID()
        let accountID = UUID()
        let categoryID = UUID()
        let txID = UUID()

        doc.ledgers = [BackupDocument.LedgerDTO(id: ledgerID, name: "个人", icon: "book", colorHex: "0A84FF", currencyCode: "CNY", isDefault: true, createdAt: Date())]
        doc.accounts = [BackupDocument.AccountDTO(id: accountID, ledgerID: ledgerID, name: "现金", kindRaw: "cash", currencyCode: "CNY", initialBalanceMinorUnits: 10000, note: "", isArchived: false, sortOrder: 0, createdAt: Date())]
        doc.categories = [BackupDocument.CategoryDTO(id: categoryID, ledgerID: ledgerID, name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kindRaw: "expense", isSystem: true, isEnabled: true, sortOrder: 0, createdAt: Date())]
        doc.transactions = [BackupDocument.TransactionDTO(id: txID, ledgerID: ledgerID, kindRaw: "expense", amountMinorUnits: 1250, currencyCode: "CNY", date: Date(), note: "", payee: "", isDeleted: false, deletedAt: nil, createdAt: Date(), updatedAt: Date(), accountID: accountID, fromAccountID: nil, toAccountID: nil, categoryID: categoryID, refundOfID: nil)]
        doc.budgets = [BackupDocument.BudgetDTO(id: UUID(), ledgerID: ledgerID, amountMinorUnits: 500000, currencyCode: "CNY", categoryID: nil, periodISO: nil, isEnabled: true, createdAt: Date())]

        let data = try BackupService.encode(doc)
        let decoded = try BackupService.decode(data)
        #expect(decoded.ledgers.count == 1)
        #expect(decoded.accounts.first?.initialBalanceMinorUnits == 10000)
        #expect(decoded.transactions.first?.amountMinorUnits == 1250)
        #expect(decoded.transactions.first?.accountID == accountID)
    }

    @Test("Newer backup versions are rejected")
    func newVersionRejected() throws {
        var future = BackupDocument()
        future.version = 999
        let data = try BackupService.encode(future)
        #expect(throws: BackupError.self) {
            _ = try BackupService.decode(data)
        }
        #expect(!BackupService.supportedVersion(999))
    }

    @Test("Version zero is rejected instead of being treated as V1")
    func versionZeroRejected() throws {
        var doc = BackupDocument()
        doc.version = 0
        let data = try BackupService.encode(doc)
        #expect(throws: BackupError.self) {
            _ = try BackupService.decode(data)
        }
        #expect(!BackupService.supportedVersion(0))
    }

    @Test("Negative versions are rejected")
    func negativeVersionRejected() throws {
        var doc = BackupDocument()
        doc.version = -1
        let data = try BackupService.encode(doc)
        #expect(throws: BackupError.self) {
            _ = try BackupService.decode(data)
        }
        #expect(!BackupService.supportedVersion(-3))
    }

    @Test("Only the explicit supported version range is accepted")
    func supportedVersionRange() {
        #expect(BackupService.supportedVersion(1))
        #expect(!BackupService.supportedVersion(2))
        #expect(!BackupService.supportedVersion(0))
        #expect(!BackupService.supportedVersion(-1))
        #expect(!BackupService.supportedVersion(Int.max))
    }

    @Test("Validation rejects transactions referencing missing accounts")
    func validationCatchesBrokenReferences() throws {
        var doc = BackupDocument()
        let ledgerID = UUID()
        doc.ledgers = [BackupDocument.LedgerDTO(id: ledgerID, name: "个人", icon: "book", colorHex: "0A84FF", currencyCode: "CNY", isDefault: true, createdAt: Date())]
        doc.transactions = [BackupDocument.TransactionDTO(id: UUID(), ledgerID: ledgerID, kindRaw: "expense", amountMinorUnits: 100, currencyCode: "CNY", date: Date(), note: "", payee: "", isDeleted: false, deletedAt: nil, createdAt: Date(), updatedAt: Date(), accountID: UUID(), fromAccountID: nil, toAccountID: nil, categoryID: nil, refundOfID: nil)]

        let data = try BackupService.encode(doc)
        let decoded = try BackupService.decode(data)
        #expect(throws: BackupError.self) {
            try SnapshotBuilder.validateForTesting(decoded)
        }
    }
}

extension SnapshotBuilder {
    /// Expose validation for tests (internal helper is private in the module).
    public static func validateForTesting(_ doc: BackupDocument) throws {
        try validate(doc)
    }
}
