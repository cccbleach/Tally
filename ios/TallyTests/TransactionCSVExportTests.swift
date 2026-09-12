import XCTest
@testable import Tally

// CSV 导出回归（数据主权底线功能）：
//   1) 每行金额按其币种的小数位输出（JPY 无小数、CNY 两位），可被任何工具回读；
//   2) 文本列做 OWASP CSV 公式注入防护（= + - @ 与前导 Tab/CR 前置单引号），
//      金额/日期/ID 等 App 生成的列不加前缀（负金额本身以 - 开头）；
//   3) 分页拉全量在「取空 / 凑满 total」时正确终止。
final class TransactionCSVExportTests: XCTestCase {

    private func makeTransaction(
        id: String = "tx-1",
        date: String = "2026-09-01",
        type: String = "expense",
        amount: Int = 123456,
        currency: String = "CNY",
        accountName: String? = "微信钱包",
        transferToAccountName: String? = nil,
        categoryName: String? = "餐饮",
        note: String? = nil,
        sourceType: String? = nil,
        createdAt: String = "2026-09-01T10:00:00Z"
    ) -> Transaction {
        Transaction(
            id: id,
            accountId: "acc-1",
            categoryId: "cat-1",
            type: type,
            amount: amount,
            currency: currency,
            note: note,
            date: date,
            transferToAccountId: nil,
            createdAt: createdAt,
            updatedAt: createdAt,
            accountName: accountName,
            categoryName: categoryName,
            categoryIcon: nil,
            categoryColor: nil,
            transferToAccountName: transferToAccountName,
            sourceType: sourceType,
            paymentGroupId: nil
        )
    }

    // MARK: - 结构

    func testHeaderRowWithBOMAndCRLF() {
        let csv = TransactionCSVExport.csv(from: [])
        XCTAssertTrue(csv.hasPrefix(TransactionCSVExport.byteOrderMark), "Excel 正确识别 UTF-8 中文依赖 BOM")
        let firstLine = String(csv.dropFirst(TransactionCSVExport.byteOrderMark.count).components(separatedBy: "\r\n")[0])
        XCTAssertEqual(firstLine, "id,date,type,amount,currency,account,counterAccount,category,note,source")
        XCTAssertTrue(csv.hasSuffix("\r\n"))
    }

    func testRowsSortedByDateDescending() {
        let csv = TransactionCSVExport.csv(from: [
            makeTransaction(id: "old", date: "2026-08-01"),
            makeTransaction(id: "new", date: "2026-09-02"),
        ])
        let lines = csv.components(separatedBy: "\r\n")
        XCTAssertTrue(lines[1].contains("new"), "最新流水应排在前面")
        XCTAssertTrue(lines[2].contains("old"))
    }

    // MARK: - 金额与币种

    func testAmountUsesEachRowCurrencyDecimals() {
        let csv = TransactionCSVExport.csv(from: [
            makeTransaction(id: "cny", amount: 123456, currency: "CNY"),
            makeTransaction(id: "jpy", amount: 1500, currency: "JPY"),
            makeTransaction(id: "neg", amount: -1234, currency: "USD"),
        ])
        let lines = csv.components(separatedBy: "\r\n")
        XCTAssertTrue(lines[1].contains(",1234.56,CNY,"), "CNY 两位小数：\(lines[1])")
        XCTAssertTrue(lines[2].contains(",1500,JPY,"), "JPY 无小数位：\(lines[2])")
        XCTAssertTrue(lines[3].contains(",-12.34,USD,"), "负金额保留减号：\(lines[3])")
    }

    // MARK: - 公式注入防护（OWASP CSV Injection）

    func testTextColumnsAreFormulaSanitized() {
        let csv = TransactionCSVExport.csv(from: [
            makeTransaction(
                accountName: "=WEBSERVICE(\"evil\")",
                transferToAccountName: "+SUM(1)",
                categoryName: "-1+1",
                note: "@cmd"
            ),
        ])
        let line = String(csv.components(separatedBy: "\r\n")[1])
        XCTAssertTrue(line.contains("\"'=WEBSERVICE(\"\"evil\"\")\""), "账户名以 = 开头需前置单引号：\(line)")
        XCTAssertTrue(line.contains("'+SUM(1)"), "以 + 开头需防护：\(line)")
        XCTAssertTrue(line.contains("'-1+1"), "以 - 开头需防护：\(line)")
        XCTAssertTrue(line.contains("'@cmd"), "以 @ 开头需防护：\(line)")
    }

    func testAmountColumnIsNeverPrefixed() {
        // 金额列本身可能以 - 开头（退款/负数），加防护前缀会破坏回读
        let csv = TransactionCSVExport.csv(from: [makeTransaction(amount: -500, currency: "CNY")])
        let line = String(csv.components(separatedBy: "\r\n")[1])
        XCTAssertTrue(line.contains(",-5.00,CNY,"), "负金额不得被加单引号前缀：\(line)")
    }

    // MARK: - RFC 4180 转义

    func testFieldsWithCommaQuoteOrNewlineAreEscaped() {
        let comma = TransactionCSVExport.csv(from: [makeTransaction(note: "午餐, 与同事")])
        XCTAssertTrue(comma.contains("\"午餐, 与同事\""), "含逗号字段需引号包裹")

        let quote = TransactionCSVExport.csv(from: [makeTransaction(accountName: "招行\"经典\"")])
        XCTAssertTrue(quote.contains("\"招行\"\"经典\"\"\""), "内部引号需翻倍")

        let newline = TransactionCSVExport.csv(from: [makeTransaction(categoryName: "餐\n饮")])
        XCTAssertTrue(newline.contains("\"餐\n饮\""), "含换行字段需引号包裹（换行不能拆行）")
        // 记录分隔符只有首尾两个 CRLF（结尾 CRLF 产生空尾串）；引号内的裸 LF 不得拆行
        XCTAssertEqual(newline.components(separatedBy: "\r\n").count - 1, 2, "引号内的换行不得把记录拆成两行")
    }

    // MARK: - 分页拉全量

    func testFetchAllStopsWhenTotalReached() async throws {
        let pages: [Int: TransactionsResponse] = [
            1: TransactionsResponse(items: (1...200).map { makeTransaction(id: "t\($0)") }, total: 250, page: 1, limit: 200),
            2: TransactionsResponse(items: (201...250).map { makeTransaction(id: "t\($0)") }, total: 250, page: 2, limit: 200),
            3: TransactionsResponse(items: [], total: 250, page: 3, limit: 200),
        ]
        var requestedPages: [Int] = []
        let result = try await TransactionCSVExport.fetchAll { page in
            requestedPages.append(page)
            return pages[page]!
        }
        XCTAssertEqual(result.count, 250)
        XCTAssertEqual(requestedPages, [1, 2], "凑满 total 后不应再请求第 3 页")
    }

    func testFetchAllStopsOnEmptyPage() async throws {
        let result = try await TransactionCSVExport.fetchAll { page in
            TransactionsResponse(items: [], total: 0, page: page, limit: 200)
        }
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - 文件输出

    func testWriteTemporaryFileRoundTrip() throws {
        let csv = TransactionCSVExport.csv(from: [makeTransaction()])
        let url = try TransactionCSVExport.writeTemporaryFile(csv, fileName: "test-export.csv")
        defer { try? FileManager.default.removeItem(at: url) }
        // 按**字节**对比：String(contentsOf:) 会吞掉 UTF-8 BOM，不能用于验证 BOM 是否写入
        let readBack = try Data(contentsOf: url)
        XCTAssertEqual(readBack, Data(csv.utf8))
    }

    func testSuggestedFileNameFormat() {
        let name = TransactionCSVExport.suggestedFileName(now: Date(timeIntervalSince1970: 0))
        XCTAssertTrue(name.hasPrefix("tally-transactions-"), name)
        XCTAssertTrue(name.hasSuffix(".csv"), name)
    }

    /// 登出必须清掉导出的临时 CSV（全量流水是隐私数据，不能留在 tmp 里）
    func testClearTemporaryFilesRemovesExportedCSV() throws {
        _ = try TransactionCSVExport.writeTemporaryFile(TransactionCSVExport.csv(from: [makeTransaction()]), fileName: "a.csv")
        _ = try TransactionCSVExport.writeTemporaryFile(TransactionCSVExport.csv(from: [makeTransaction()]), fileName: "b.csv")

        TransactionCSVExport.clearTemporaryFiles()

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tally-export")
        let leftovers = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        XCTAssertTrue(leftovers.isEmpty, "清理后不允许残留导出文件：\(leftovers)")

        // 清理是幂等的，且不影响后续再次导出
        TransactionCSVExport.clearTemporaryFiles()
        let again = try TransactionCSVExport.writeTemporaryFile(TransactionCSVExport.csv(from: [makeTransaction()]), fileName: "c.csv")
        XCTAssertTrue(FileManager.default.fileExists(atPath: again.path))
        TransactionCSVExport.clearTemporaryFiles()
    }
}
