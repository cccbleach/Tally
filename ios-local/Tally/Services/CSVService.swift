//
//  CSVService.swift
//  Tally
//
//  CSV export/import for transactions.
//
//  Column layout (UTF-8, first row = header). The version is identified strictly
//  from the header, never guessed from data row length:
//
//    V1 (10 columns):
//      type,date,amount,currency,account,counterAccount,category,payee,note,id
//      - For non-refund rows `id` is the transaction's own stable id.
//      - For refund rows `id` holds the id of the original expense; the refund
//        itself has no stable id and a new id is generated on import.
//      - Duplicate detection of a V1 refund therefore relies on the full
//        semantic key, which includes the original expense id.
//
//    V2 (11 columns):
//      type,date,amount,currency,account,counterAccount,category,payee,note,id,refundOfID
//      - `id` is ALWAYS the current transaction's own stable id.
//      - `refundOfID` is the optional id of the original expense.
//      - A V2 refund's own id is never mistaken for the original transaction id.
//      - Unlinked refunds are allowed to leave `refundOfID` empty.
//
//  Import is atomic w.r.t. parsing: a malformed file produces an error before
//  anything is written to the store, so a failed import never corrupts data.
//

import Foundation

public enum CSVService {

    public struct Row: Equatable, Sendable {
        public let type: String
        public let date: String
        public let amount: String
        public let currency: String
        public let account: String
        public let counterAccount: String
        public let category: String
        public let payee: String
        public let note: String
        public let id: String
        public let refundOfID: String

        public init(type: String, date: String, amount: String, currency: String,
                    account: String = "", counterAccount: String = "", category: String = "",
                    payee: String = "", note: String = "", id: String = "", refundOfID: String = "") {
            self.type = type
            self.date = date
            self.amount = amount
            self.currency = currency
            self.account = account
            self.counterAccount = counterAccount
            self.category = category
            self.payee = payee
            self.note = note
            self.id = id
            self.refundOfID = refundOfID
        }
    }

    // MARK: - Export

    public static let header = ["type", "date", "amount", "currency", "account", "counterAccount", "category", "payee", "note", "id", "refundOfID"]

    public static let isoDate: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = .current
        return f
    }()

    public static func exportCSV(transactions: [Transaction]) -> String {
        var lines: [String] = [escapeRow(header)]
        // Most recent first.
        let sorted = transactions
            .filter { !$0.isDeleted }
            .sorted { $0.date > $1.date }
        for t in sorted {
            let account = t.kind == .transfer ? (t.fromAccount?.name ?? "") : (t.account?.name ?? "")
            let counter = t.kind == .transfer ? (t.toAccount?.name ?? "") : ""
            let row = Row(
                type: t.kindRaw,
                date: isoDate.string(from: t.date),
                amount: Currencies.info(forCode: t.currencyCode).string(fromMinorUnits: t.amountMinorUnits),
                currency: t.currencyCode,
                account: account,
                counterAccount: counter,
                category: t.category?.name ?? "",
                payee: t.payee,
                note: t.note,
                id: t.id.uuidString,
                refundOfID: t.refundOf?.id.uuidString ?? ""
            )
            lines.append(escapeRow(encode(row)))
        }
        return lines.joined(separator: "\r\n") + "\r\n"
    }

    private static func encode(_ r: Row) -> [String] {
        // 文本列（账户/对手/分类/商家/备注）可能来自导入的账单文件 → 做公式注入防护；
        // 数值/日期/ID 列由 App 生成，不加前缀（否则负金额会在回导时变成非法值）
        [r.type, r.date, r.amount, r.currency,
         sanitizeFormula(r.account), sanitizeFormula(r.counterAccount), sanitizeFormula(r.category),
         sanitizeFormula(r.payee), sanitizeFormula(r.note), r.id, r.refundOfID]
    }

    /// CSV 公式注入防护（OWASP CSV Injection）：Excel / Numbers 会把以 `=`、`+`、`-`、`@`
    /// （以及前导 Tab/CR）开头的字段当作公式解析，可能触发 DDE/外部程序调用。
    /// `payee`/`note` 等文本可能来自导入的账单文件，因此导出时对**文本列**前置单引号 `'`。
    ///
    /// 只对文本列生效（见 `encode`）：金额/日期/ID 等列由 App 生成，且负金额本身以 `-` 开头，
    /// 若一并加前缀会在回导时把金额变成非法值。
    private static func sanitizeFormula(_ field: String) -> String {
        guard let first = field.unicodeScalars.first else { return field }
        let dangerous: Set<UInt32> = [0x3D /* = */, 0x2B /* + */, 0x2D /* - */, 0x40 /* @ */, 0x09 /* tab */, 0x0D /* CR */]
        return dangerous.contains(first.value) ? "'" + field : field
    }

    /// 与 `sanitizeFormula` 对称：回导时去掉导出时加上的单引号，保证 导出→导入 往返一致。
    private static func unescapeFormula(_ field: String) -> String {
        field.hasPrefix("'") ? String(field.dropFirst()) : field
    }

    private static func escapeRow(_ fields: [String]) -> String {
        fields.map { f -> String in
            let needsQuoting = f.contains(",")
                || f.contains("\"")
                || f.unicodeScalars.contains(where: { $0.value == 10 || $0.value == 13 })
            if needsQuoting {
                return "\"" + f.replacingOccurrences(of: "\"", with: "\"\"") + "\""
            }
            return f
        }.joined(separator: ",")
    }

    // MARK: - Import

    /// Identifies the CSV version strictly from its header row.
    public enum CSVVersion: Equatable, Sendable {
        case v1
        case v2
    }

    public static let v1Header = ["type", "date", "amount", "currency", "account", "counterAccount", "category", "payee", "note", "id"]
    public static let v2Header = ["type", "date", "amount", "currency", "account", "counterAccount", "category", "payee", "note", "id", "refundOfID"]

    /// Parse CSV text into rows. The version is identified from the header;
    /// header-less input is rejected (no guessing).
    public static func parse(_ text: String) throws -> [Row] {
        let fields = try parseCells(text)
        guard let first = fields.first else { return [] }
        let version = try identifyVersion(from: first)
        var rows: [Row] = []
        for (offset, line) in fields.dropFirst(1).enumerated() {
            guard !line.isEmpty else { continue }
            let lineNumber = offset + 2
            try validateRowFields(line, expected: version, lineNumber: lineNumber)
            let col = { (i: Int) -> String in i < line.count ? line[i] : "" }
            let type = col(0).trimmingCharacters(in: .whitespaces)
            let isRefund = type.lowercased() == TransactionKind.refund.rawValue
            let idColumn = col(9).trimmingCharacters(in: .whitespaces)
            switch version {
            case .v1:
                // V1: non-refund rows carry their own id in column 9; refund rows
                // carry the original expense's id and no own id (new id generated
                // later at import time).
                rows.append(Row(
                    type: type,
                    date: col(1).trimmingCharacters(in: .whitespaces),
                    amount: col(2).trimmingCharacters(in: .whitespaces),
                    currency: col(3).trimmingCharacters(in: .whitespaces).uppercased(),
                    account: unescapeFormula(col(4)), counterAccount: unescapeFormula(col(5)),
                    category: unescapeFormula(col(6)),
                    payee: unescapeFormula(col(7)), note: unescapeFormula(col(8)),
                    id: isRefund ? "" : idColumn,
                    refundOfID: isRefund ? idColumn : ""
                ))
            case .v2:
                rows.append(Row(
                    type: type,
                    date: col(1).trimmingCharacters(in: .whitespaces),
                    amount: col(2).trimmingCharacters(in: .whitespaces),
                    currency: col(3).trimmingCharacters(in: .whitespaces).uppercased(),
                    account: unescapeFormula(col(4)), counterAccount: unescapeFormula(col(5)),
                    category: unescapeFormula(col(6)),
                    payee: unescapeFormula(col(7)), note: unescapeFormula(col(8)),
                    id: idColumn,
                    refundOfID: col(10).trimmingCharacters(in: .whitespaces)
                ))
            }
        }
        return rows
    }

    /// Strictly validate a header row. The version is derived from the header,
    /// so unknown/missing/repeated/extra columns produce an explicit error.
    private static func identifyVersion(from headerCells: [String]) throws -> CSVVersion {
        let normalized = headerCells.map { cell in
            cell.trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF}")).trimmingCharacters(in: .whitespaces).lowercased()
        }
        guard let first = normalized.first, first == "type" else {
            throw CSVError.malformed("无法识别 CSV 表头；必须提供 V1（10 列）或 V2（11 列）表头，且首列必须为 type")
        }
        let version: CSVVersion
        switch normalized {
        case v1Header.map({ $0.lowercased() }): version = .v1
        case v2Header.map({ $0.lowercased() }): version = .v2
        default:
            throw CSVError.malformed("无法识别的 CSV 表头（应为 V1 10 列或 V2 11 列且顺序固定）：\(headerCells.joined(separator: ","))")
        }
        return version
    }

    private static func validateRowFields(_ line: [String], expected version: CSVVersion, lineNumber: Int) throws {
        let expectedCount = version == .v1 ? v1Header.count : v2Header.count
        guard line.count == expectedCount else {
            throw CSVError.malformed("第 \(lineNumber) 行字段数（\(line.count)）与表头（\(expectedCount) 列）不一致")
        }
    }


    public enum CSVError: Error, LocalizedError, Equatable {
        case malformed(String)

        public var errorDescription: String? {
            switch self {
            case .malformed(let message): return message
            }
        }
    }

    /// Parse into a matrix of cells, honoring double-quote quoting.
    private static func parseCells(_ text: String) throws -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        let chars = Array(text)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let scalar = c.unicodeScalars.first?.value
            if inQuotes {
                if scalar == 34 { // double quote
                    if i + 1 < chars.count && chars[i + 1].unicodeScalars.first?.value == 34 {
                        field.append("\"")
                        i += 2
                        continue
                    } else {
                        inQuotes = false
                        i += 1
                        continue
                    }
                } else {
                    field.append(c)
                    i += 1
                }
            } else {
                let scalar = c.unicodeScalars.first?.value
                if scalar == 10 || scalar == 13 { // LF or CR
                    if scalar == 13, i + 1 < chars.count, chars[i + 1].unicodeScalars.first?.value == 10 {
                        i += 1 // skip LF following CR
                    }
                    row.append(field)
                    field = ""
                    rows.append(row)
                    row = []
                    i += 1
                } else if scalar == 44 { // comma
                    row.append(field)
                    field = ""
                    i += 1
                } else if scalar == 34 { // double quote
                    inQuotes = true
                    i += 1
                } else {
                    field.append(c)
                    i += 1
                }
            }
        }
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        if inQuotes {
            throw CSVError.malformed("未闭合的引号")
        }
        // Drop fully-empty trailing rows.
        return rows.filter { !($0.count == 1 && $0[0].trimmingCharacters(in: .whitespaces).isEmpty) }
    }
}
