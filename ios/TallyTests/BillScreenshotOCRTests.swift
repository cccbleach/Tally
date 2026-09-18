import XCTest
@testable import Tally

// 截图 OCR → 暂存导入管道回归：
//   1) 微信/支付宝支付成功页常见版式的金额/类型/商家/日期提取；
//   2) 合成文本必须能被服务端微信解析器吃下：表头同含「交易时间/金额」（行解析）
//      与「收/支/交易单号/当前状态」（来源识别），字段引号包裹防逗号；
//   3) 合成单号稳定：同一张截图重复导入命中服务端 (ledger_id, source_type, external_id) 硬去重。
final class BillScreenshotOCRTests: XCTestCase {

    // 微信支付成功页的典型 OCR 行（乱序/带噪声）
    private let wechatLines = [
        "微信支付",
        "¥28.50",
        "支付成功",
        "2026年9月12日 12:30",
        "商家：瑞幸咖啡（科技园店）",
        "转账单号：1000039901202609120300637565",
    ]

    private func date(_ year: Int, _ month: Int, _ day: Int, hour: Int = 12, minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    // MARK: - 提取

    func testExtractWeChatPaymentScreenshot() {
        let bill = BillScreenshotOCR.extractBill(from: wechatLines, now: date(2026, 9, 12))
        XCTAssertEqual(bill.minorUnits, 2850)
        XCTAssertEqual(bill.type, "expense")
        XCTAssertEqual(bill.merchant, "瑞幸咖啡（科技园店）")
        XCTAssertEqual(bill.occurredAt, "2026-09-12")
        XCTAssertTrue(bill.isSuccessful)
    }

    func testExtractUnicodeMinusAndGroupingAmount() {
        // 支付宝/部分机型的 OCR 会输出 Unicode 减号与千分位；
        // 负号只表示方向，金额必须取绝对值（服务端跳过金额 ≤ 0 的行）
        let bill = BillScreenshotOCR.extractBill(from: ["−1,234.50", "付款成功"], now: date(2026, 9, 12))
        XCTAssertEqual(bill.minorUnits, 123450)
        XCTAssertEqual(bill.type, "expense", "无收入关键词默认支出")
    }

    func testExtractIncomeScreenshot() {
        let bill = BillScreenshotOCR.extractBill(from: ["收款码", "已存入零钱", "¥100.00"], now: date(2026, 9, 12))
        XCTAssertEqual(bill.type, "income")
        XCTAssertEqual(bill.minorUnits, 10000)
    }

    func testExtractInlineAmountWithCurrencySymbol() {
        let bill = BillScreenshotOCR.extractBill(from: ["支付金额", "合计 ¥88.80", "今天 19:20"], now: date(2026, 9, 12))
        XCTAssertEqual(bill.minorUnits, 8880, "整行不是纯金额时应回退到 ¥ 前缀提取")
        XCTAssertEqual(bill.occurredAt, "2026-09-12", "「今天」应落到当天日期")
    }

    func testExtractMissingAmountYieldsNil() {
        let bill = BillScreenshotOCR.extractBill(from: ["微信支付", "账单详情"], now: date(2026, 9, 12))
        XCTAssertNil(bill.minorUnits)
    }

    func testMonthDayWithoutYearUsesCurrentYear() {
        let bill = BillScreenshotOCR.extractBill(from: ["09月12日 12:30", "¥5.00"], now: date(2026, 9, 12))
        XCTAssertEqual(bill.occurredAt, "2026-09-12")
    }

    // MARK: - 合成账单文本（必须可被服务端微信解析器识别）

    func testSynthesizedTextMatchesServerWeChatParserContract() {
        let bill = BillScreenshotOCR.extractBill(from: wechatLines, now: date(2026, 9, 12))
        let text = BillScreenshotOCR.synthesizeBillText(bill, now: date(2026, 9, 12))

        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, 2, "表头 + 一行数据")
        let header = lines[0].components(separatedBy: ",")
        XCTAssertEqual(header, ["交易时间", "交易单号", "商品", "收/支", "金额", "当前状态"],
                       "表头须同含 交易时间/金额（行解析）与 收/支/交易单号/当前状态（来源识别）")

        // 逐字段模拟服务端 splitCsvLine（引号包裹 + 逗号分隔）
        let fields = parseQuotedCsv(lines[1])
        XCTAssertEqual(fields.count, 6)
        XCTAssertEqual(fields[0], "2026-09-12")
        XCTAssertTrue(fields[1].hasPrefix("ocr-"), "交易单号应为稳定合成 ID：\(fields[1])")
        XCTAssertEqual(fields[2], "瑞幸咖啡（科技园店）")
        XCTAssertEqual(fields[3], "支出")
        XCTAssertEqual(fields[4], "28.50")
        XCTAssertEqual(fields[5], "支付成功", "状态含「成功」才会被服务端接受")
    }

    func testMerchantWithCommaIsQuoted() {
        let bill = BillScreenshotOCR.RecognizedBill(
            occurredAt: "2026-09-12", minorUnits: 1000, type: "expense",
            merchant: "昆明,大观楼店", isSuccessful: true
        )
        let text = BillScreenshotOCR.synthesizeBillText(bill)
        let fields = parseQuotedCsv(text.split(separator: "\n").map(String.init)[1])
        XCTAssertEqual(fields[2], "昆明,大观楼店", "含逗号的商家必须被引号保护")
    }

    func testUnknownDateFallsBackToToday() {
        let bill = BillScreenshotOCR.RecognizedBill(
            occurredAt: nil, minorUnits: 100, type: "expense",
            merchant: nil, isSuccessful: true
        )
        let text = BillScreenshotOCR.synthesizeBillText(bill, now: date(2026, 9, 12))
        XCTAssertTrue(text.contains("\"2026-09-12\""), "识别不到日期时按当天入账（预览阶段用户可改判）")
    }

    func testUnsuccessfulBillCarriesRealStatusSoServerDropsIt() {
        // 服务端规则：状态非空且不含「成功」→ 丢弃该行。
        // 历史缺陷：非成功页写空状态，而空状态不受该规则约束，于是失败/取消的截图会被当作支出入账。
        let bill = BillScreenshotOCR.RecognizedBill(
            occurredAt: "2026-09-12", minorUnits: 100, type: "expense",
            merchant: nil, isSuccessful: false, statusText: "支付失败"
        )
        let text = BillScreenshotOCR.synthesizeBillText(bill)
        let fields = parseQuotedCsv(text.split(separator: "\n").map(String.init)[1])
        XCTAssertEqual(fields[5], "支付失败", "必须把真实状态写进合成文本")
        XCTAssertFalse(fields[5].isEmpty, "空状态会让服务端放行失败交易")
        XCTAssertFalse(fields[5].contains("成功"), "含「成功」会被服务端当成成功交易")

        // 识别不到状态时也不能留空（否则服务端放行）
        let unknown = BillScreenshotOCR.RecognizedBill(
            occurredAt: "2026-09-12", minorUnits: 100, type: "expense",
            merchant: nil, isSuccessful: false, statusText: nil
        )
        let unknownFields = parseQuotedCsv(BillScreenshotOCR.synthesizeBillText(unknown).split(separator: "\n").map(String.init)[1])
        XCTAssertFalse(unknownFields[5].isEmpty, "未知状态也要写占位文本，绝不能留空")
        XCTAssertFalse(unknownFields[5].contains("成功"))
    }

    func testNegativeMarkersBeatSuccessKeyword() {
        // 「支付未成功」「退款成功」这类页面含「成功」二字，但绝不是要入账的支出
        for negative in ["支付未成功", "退款成功", "已取消", "待付款"] {
            let bill = BillScreenshotOCR.extractBill(from: [negative, "¥28.50", "2026-09-12 08:31:05"])
            XCTAssertFalse(bill.isSuccessful, "「\(negative)」不应判为成功页")
            let fields = parseQuotedCsv(BillScreenshotOCR.synthesizeBillText(bill).split(separator: "\n").map(String.init)[1])
            XCTAssertFalse(fields[5].contains("成功"), "状态文本必须让服务端丢弃这行：\(fields[5])")
        }
    }

    func testSuccessfulPageStatusAlwaysContainsSuccessKeywordForServer() {
        // 支付宝成功页常见状态是「已支付」（不含「成功」），必须归一成服务端认得的文本
        let bill = BillScreenshotOCR.extractBill(from: ["已支付", "¥28.50", "2026-09-12 08:31:05"])
        XCTAssertTrue(bill.isSuccessful)
        let fields = parseQuotedCsv(BillScreenshotOCR.synthesizeBillText(bill).split(separator: "\n").map(String.init)[1])
        XCTAssertTrue(fields[5].contains("成功"), "成功页状态必须含「成功」否则被服务端丢弃：\(fields[5])")
    }

    func testStatusLineIsExtractedFromFailedPaymentPage() {
        let lines = [
            "支付失败",
            "¥28.50",
            "瑞幸咖啡",
            "2026-09-12 08:31:05",
        ]
        let bill = BillScreenshotOCR.extractBill(from: lines)
        XCTAssertFalse(bill.isSuccessful, "页面没有成功关键词，不应判为成功")
        XCTAssertEqual(bill.statusText, "支付失败", "应识别出状态行")
        let fields = parseQuotedCsv(BillScreenshotOCR.synthesizeBillText(bill).split(separator: "\n").map(String.init)[1])
        XCTAssertFalse(fields[5].contains("成功"), "合成文本必须让服务端能丢弃这行：\(fields[5])")
    }

    // MARK: - 稳定去重 ID

    func testSyntheticExternalIdIsStableForSameBill() {
        let bill = BillScreenshotOCR.RecognizedBill(
            occurredAt: "2026-09-12", minorUnits: 2850, type: "expense",
            merchant: "瑞幸咖啡", isSuccessful: true
        )
        let a = BillScreenshotOCR.syntheticExternalId(bill: bill, occurredAt: "2026-09-12", salt: "")
        let b = BillScreenshotOCR.syntheticExternalId(bill: bill, occurredAt: "2026-09-12", salt: "")
        XCTAssertEqual(a, b, "同一张截图重复识别必须得到同一单号（硬去重依赖）")
        XCTAssertTrue(a.hasPrefix("ocr-") && a.count == 20, "ocr- + 16 位十六进制：\(a)")

        var different = bill
        different.minorUnits = 2851
        let c = BillScreenshotOCR.syntheticExternalId(bill: different, occurredAt: "2026-09-12", salt: "")
        XCTAssertNotEqual(a, c, "不同金额必须得到不同单号")
    }

    func testSuggestedFileNameIsTxt() {
        let name = BillScreenshotOCR.suggestedFileName(now: date(2026, 9, 12))
        XCTAssertTrue(name.hasPrefix("screenshot-"), name)
        XCTAssertTrue(name.hasSuffix(".txt"), "服务端按扩展名选择 txt 解析路径")
    }

    // MARK: - 服务端 splitCsvLine 的等价实现（用于断言，逐字符索引，与线上实现同构）

    private func parseQuotedCsv(_ line: String) -> [String] {
        var out: [String] = []
        var current = ""
        var inQuotes = false
        let chars = Array(line)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch == "\"" {
                if inQuotes, i + 1 < chars.count, chars[i + 1] == "\"" {
                    current.append("\"")
                    i += 2
                    continue
                }
                inQuotes.toggle()
            } else if ch == "," && !inQuotes {
                out.append(current)
                current = ""
            } else {
                current.append(ch)
            }
            i += 1
        }
        out.append(current)
        return out.map { $0.trimmingCharacters(in: .whitespaces) }
    }
}
