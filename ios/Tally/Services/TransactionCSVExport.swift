import Foundation

/// 流水 CSV 导出（数据主权底线：用户能随时拿走全部数据）。
///
/// 列布局（UTF-8 + BOM、CRLF 换行、首行表头）：
///
///     id,date,type,amount,currency,account,counterAccount,category,note,source
///
/// - `amount` 是**币种原生小数**：按每行 `currency` 的小数位输出（JPY 无小数位），
///   负数带减号，不包含千分位——保证任何工具回读时无需再清洗；
/// - `currency` 列恒为 CNY、`account`/`counterAccount` 列恒为空：多币种与账户域下线后
///   列结构保持不变（列是外部契约，删列会让用户已建好的 Excel/透视流程错位）；
/// - 文本列（category/note）可能来自导入的微信/支付宝账单文件，
///   按 OWASP CSV Injection 指南做公式注入防护：以 `=` `+` `-` `@` 或前导 Tab/CR
///   开头的字段前置单引号 `'`，防止 Excel/Numbers 把其当公式执行（DDE 等风险）；
/// - 金额/日期/ID 列由 App 生成，不加前缀——负金额本身以 `-` 开头，加前缀会破坏回读。
enum TransactionCSVExport {
    static let header = ["id", "date", "type", "amount", "currency", "account", "counterAccount", "category", "note", "source"]

    /// 分页拉全量流水（每页 200，循环到取空或凑满 total）。
    /// `pageFetch` 由调用方注入（生产传 APIService，测试传替身）。
    static func fetchAll(pageFetch: (Int) async throws -> TransactionsResponse) async throws -> [Transaction] {
        var collected: [Transaction] = []
        var page = 1
        while true {
            let response = try await pageFetch(page)
            collected.append(contentsOf: response.items)
            if response.items.isEmpty || collected.count >= response.total { break }
            page += 1
        }
        return collected
    }

    /// 纯函数：交易列表 → CSV 文本。按日期倒序（与明细页一致）。
    static func csv(from transactions: [Transaction]) -> String {
        var lines = [escapeRow(header)]
        let sorted = transactions.sorted {
            if $0.date != $1.date { return $0.date > $1.date }
            return $0.createdAt > $1.createdAt
        }
        for t in sorted {
            let row = [
                t.id,
                t.date,
                t.type,
                Money.currency.decimalString(t.amount),
                Money.currency.code,
                "", // account（账户域已下线；列保留以维持既有 CSV 结构）
                "", // counterAccount（同上）
                sanitizeFormula(t.categoryName ?? ""),
                sanitizeFormula(t.note ?? ""),
                t.sourceType ?? "",
            ]
            lines.append(escapeRow(row))
        }
        return Self.byteOrderMark + lines.joined(separator: "\r\n") + "\r\n"
    }

    /// Excel 打开 UTF-8 CSV 中文不乱码依赖 BOM（Numbers 亦兼容）
    static let byteOrderMark = "\u{FEFF}"

    /// 建议文件名：tally-transactions-20260912.csv
    static func suggestedFileName(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd"
        formatter.timeZone = .current
        return "tally-transactions-\(formatter.string(from: now)).csv"
    }

    /// 写入临时文件供分享面板使用
    static func writeTemporaryFile(_ csv: String, fileName: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("tally-export", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(fileName)
        try Data(csv.utf8).write(to: url, options: .atomic)
        return url
    }

    /// 清掉全部导出临时文件（登出时调用：导出的全量流水属于隐私数据，
    /// 不能留在 tmp 里被后续会话/其他 App 捡走；系统虽会不定期清理 tmp，不可依赖）
    static func clearTemporaryFiles() {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("tally-export", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: - CSV 转义

    /// OWASP CSV Injection：文本列以危险字符开头时前置单引号（见类型注释）
    private static func sanitizeFormula(_ field: String) -> String {
        guard let first = field.unicodeScalars.first else { return field }
        let dangerous: Set<UInt32> = [
            0x3D /* = */, 0x2B /* + */, 0x2D /* - */, 0x40 /* @ */,
            0x09 /* Tab */, 0x0D /* CR */,
        ]
        return dangerous.contains(first.value) ? "'" + field : field
    }

    /// RFC 4180：字段含逗号/引号/换行时用双引号包裹，内部引号翻倍
    private static func escapeRow(_ fields: [String]) -> String {
        fields.map { field in
            let needsQuoting = field.contains(",")
                || field.contains("\"")
                || field.unicodeScalars.contains(where: { $0.value == 10 || $0.value == 13 })
            if needsQuoting {
                return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
            }
            return field
        }.joined(separator: ",")
    }
}
