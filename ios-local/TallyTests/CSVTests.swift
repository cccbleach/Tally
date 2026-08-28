//
//  CSVTests.swift
//  TallyTests
//
//  Tests for CSV export/import parsing.
//

import Testing
import Foundation
@testable import Tally

@Suite("CSV Export & Import")
struct CSVTests {

    @Test("Parse a simple CSV with header")
    func parseSimple() throws {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,
        income,2026-08-02,5000.00,CNY,工资卡,,工资,公司,1月工资,
        transfer,2026-08-03,300.00,CNY,工资卡,现金,,,转到现金,
        """
        let rows = try CSVService.parse(text)
        #expect(rows.count == 3)
        #expect(rows[0].type == "expense")
        #expect(rows[0].amount == "12.50")
        #expect(rows[1].currency == "CNY")
        #expect(rows[2].type == "transfer")
        #expect(rows[2].counterAccount == "现金")
        #expect(try CSVService.parse("\u{FEFF}" + text).count == 3)
    }

    @Test("Handles quoted fields with commas and quotes")
    func parseQuoted() throws {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,"老王,面馆","吃了 ""大碗"" 面",
        """
        let rows = try CSVService.parse(text)
        #expect(rows.count == 1)
        #expect(rows[0].payee == "老王,面馆")
        #expect(rows[0].note == "吃了 \"大碗\" 面")
    }

    @Test("Malformed rows throw an error")
    func parseMalformed() {
        let text = "type,date\nonlythree,ab," as String
        #expect(throws: CSVService.CSVError.self) {
            _ = try CSVService.parse(text)
        }
    }

    @Test("Export then re-import round-trips the rows")
    func exportRoundTrip() throws {
        let ledger = Ledger(name: "测试")
        let account = Account(name: "现金", kind: .cash)
        account.ledger = ledger
        let category = Category(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense)
        category.ledger = ledger
        let date = CSVService.isoDate.date(from: "2026-08-01") ?? Date()

        let tx = Transaction(kind: .expense, amountMinorUnits: 1250, currencyCode: "CNY", date: date, account: account, category: category, note: "午饭", payee: "食堂")
        tx.ledger = ledger

        let csv = CSVService.exportCSV(transactions: [tx])
        let rows = try CSVService.parse(csv)
        #expect(rows.count == 1)
        #expect(rows[0].type == "expense")
        #expect(rows[0].date == "2026-08-01")
        #expect(rows[0].amount == "12.50")
        #expect(rows[0].account == "现金")
        #expect(rows[0].category == "餐饮")
        #expect(rows[0].note == "午饭")
        #expect(rows[0].id == tx.id.uuidString)
    }

    @Test("Refund export preserves its own ID and original transaction ID")
    func refundIdentityRoundTrip() throws {
        let ledger = Ledger(name: "测试")
        let account = Account(name: "现金", kind: .cash)
        let category = Category(name: "餐饮", kind: .expense)
        let original = Transaction(kind: .expense, amountMinorUnits: 1250, currencyCode: "CNY", date: Date(), account: account, category: category)
        let refund = Transaction(kind: .refund, amountMinorUnits: 500, currencyCode: "CNY", date: Date(), account: account, category: category, refundOf: original)
        original.ledger = ledger
        refund.ledger = ledger
        let rows = try CSVService.parse(CSVService.exportCSV(transactions: [original, refund]))
        let refundRow = try #require(rows.first { $0.type == "refund" })
        #expect(refundRow.id == refund.id.uuidString)
        #expect(refundRow.refundOfID == original.id.uuidString)
    }

    @Test("Export excludes soft-deleted transactions")
    func exportExcludesDeleted() throws {
        let ledger = Ledger(name: "测试")
        let account = Account(name: "现金", kind: .cash)
        account.ledger = ledger
        let tx = Transaction(kind: .expense, amountMinorUnits: 100, currencyCode: "CNY", date: Date(), account: account)
        tx.ledger = ledger
        tx.isDeleted = true

        let csv = CSVService.exportCSV(transactions: [tx])
        let rows = try CSVService.parse(csv)
        #expect(rows.isEmpty)
    }

    @Test("Duplicate import is a client-side concern; parse does not mutate")
    func parseDoesNotMutate() throws {
        let text = CSVService.exportCSV(transactions: [])
        let first = try CSVService.parse(text)
        let second = try CSVService.parse(text)
        #expect(first == second)
    }

    @Test("Legacy 10-column export maps its id column to refundOfID for refund rows")
    func legacyTenColumnMapping() throws {
        // The version-1 format had a single `id` column: for refund rows it held
        // the original transaction's id; for non-refund rows it held the row's
        // own id.
        let legacy = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,11111111-1111-1111-1111-111111111111
        refund,2026-08-02,12.50,CNY,现金,,餐饮,,,11111111-1111-1111-1111-111111111111
        """
        let rows = try CSVService.parse(legacy)
        #expect(rows.count == 2)
        // Expense row keeps its own id.
        #expect(rows[0].id == "11111111-1111-1111-1111-111111111111")
        #expect(rows[0].refundOfID.isEmpty)
        // Refund row's id column is mapped to refundOfID (id itself is blank).
        #expect(rows[1].id.isEmpty)
        #expect(rows[1].refundOfID == "11111111-1111-1111-1111-111111111111")
    }

    @Test("V1 standard expense and refund are identified strictly from the header")
    func standardV1() throws {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
        refund,2026-08-02,5.00,CNY,现金,,餐饮,食堂,退款,11111111-1111-1111-1111-111111111111
        """
        let rows = try CSVService.parse(text)
        #expect(rows.count == 2)
        #expect(rows[0].id == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        #expect(rows[0].refundOfID.isEmpty)
        #expect(rows[1].id.isEmpty)
        #expect(rows[1].refundOfID == "11111111-1111-1111-1111-111111111111")
    }

    @Test("V2 standard expense and refund keep their own ids plus refundOfID")
    func standardV2() throws {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,食堂,午饭,22222222-2222-2222-2222-222222222222,
        refund,2026-08-02,5.00,CNY,现金,,餐饮,食堂,退款,33333333-3333-3333-3333-333333333333,22222222-2222-2222-2222-222222222222
        """
        let rows = try CSVService.parse(text)
        #expect(rows.count == 2)
        #expect(rows[0].id == "22222222-2222-2222-2222-222222222222")
        #expect(rows[0].refundOfID.isEmpty)
        // V2 refund keeps its own id AND stores the original expense id separately.
        #expect(rows[1].id == "33333333-3333-3333-3333-333333333333")
        #expect(rows[1].refundOfID == "22222222-2222-2222-2222-222222222222")
    }

    @Test("V2 unlinked refund is allowed with an empty refundOfID")
    func v2UnlinkedRefund() throws {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        refund,2026-08-02,5.00,CNY,现金,,餐饮,,,44444444-4444-4444-4444-444444444444,
        """
        let rows = try CSVService.parse(text)
        #expect(rows.count == 1)
        #expect(rows[0].type == "refund")
        #expect(rows[0].id == "44444444-4444-4444-4444-444444444444")
        #expect(rows[0].refundOfID.isEmpty)
    }

    @Test("V2 row missing the last column is rejected")
    func v2MissingLastColumnRejected() {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,
        """
        #expect(throws: CSVService.CSVError.self) {
            _ = try CSVService.parse(text)
        }
    }

    @Test("V1 data row field count mismatch is rejected")
    func v1RowCountMismatchRejected() {
        // V1 header (10 columns) but a data row with 11 fields.
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,,,
        """
        #expect(throws: CSVService.CSVError.self) {
            _ = try CSVService.parse(text)
        }
    }

    @Test("BOM-prefixed header is identified correctly")
    func bomHeader() throws {
        let text = "\u{FEFF}type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID\r\n" +
            "expense,2026-08-01,12.50,CNY,现金,,餐饮,,,,\r\n"
        let rows = try CSVService.parse(text)
        #expect(rows.count == 1)
        #expect(rows[0].type == "expense")
    }

    @Test("Illegal header layouts are explicitly rejected")
    func illegalHeadersRejected() {
        let missingColumn = "type,date,amount,currency,account,payee,note,id\n"
        let unknownColumn = "type,date,amount,currency,account,counterAccount,category,payee,note,id,mystery\n"
        let duplicateColumn = "type,type,amount,currency,account,counterAccount,category,payee,note,id,refundOfID\n"
        for text in [missingColumn, unknownColumn, duplicateColumn] {
            #expect(throws: CSVService.CSVError.self) {
                _ = try CSVService.parse(text)
            }
        }
    }

    @Test("Header-less CSV is explicitly rejected, never guessed")
    func noHeaderRejected() {
        let text = "22222222-2222-2222-2222-222222222222,2026-08-01,12.50,CNY,现金,,餐饮,,,\n"
        #expect(throws: CSVService.CSVError.self) {
            _ = try CSVService.parse(text)
        }
    }

    @Test("Quoted fields with commas and embedded newlines parse under V2 header")
    func v2QuotedAndNewlineFields() throws {
        let text = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,"老王,面馆","第一行
        第二行",55555555-5555-5555-5555-555555555555,
        """
        let rows = try CSVService.parse(text)
        #expect(rows.count == 1)
        #expect(rows[0].payee == "老王,面馆")
        #expect(rows[0].note == "第一行\n第二行")
        #expect(rows[0].id == "55555555-5555-5555-5555-555555555555")
    }

    @Test("V1 and V2 are never misidentified")
    func v1v2NeverMisidentified() throws {
        let v1 = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,11111111-1111-1111-1111-111111111111
        """
        let v1Rows = try CSVService.parse(v1)
        #expect(v1Rows[0].id == "11111111-1111-1111-1111-111111111111")

        let v2 = """
        type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
        expense,2026-08-01,12.50,CNY,现金,,餐饮,,,11111111-1111-1111-1111-111111111111,
        """
        let v2Rows = try CSVService.parse(v2)
        #expect(v2Rows[0].id == "11111111-1111-1111-1111-111111111111")
        #expect(v2Rows[0].refundOfID.isEmpty)
    }
}
