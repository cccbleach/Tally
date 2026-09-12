import CryptoKit
import Foundation
import UIKit
import Vision

// 账单截图识别（微信/支付宝支付成功页 → 暂存导入管道）。
//
// 隐私与复用策略：
// - 识别全部在本机用 Vision 完成，截图**不上传**；只把识别结果合成的文本上传；
// - 合成文本伪装成「微信支付明细 txt」的表头格式，服务端会自动识别为 wechat 来源，
//   复用既有暂存导入管道（预览逐项确认 + 跨来源去重），服务端零改动；
// - 交易单号使用「截图内容派生的稳定哈希」：同一张截图（或同一笔交易的两张截图）
//   重复导入会命中服务端 (ledger_id, source_type, external_id) 硬去重，不会重复入账。
enum BillScreenshotOCR {
    /// 从截图文本中提取出的结构化账单
    struct RecognizedBill: Equatable {
        /// "YYYY-MM-DD HH:mm"（时间部分可能缺失）；nil = 完全识别不到日期
        var occurredAt: String?
        var minorUnits: Int?
        var type: String  // "expense" | "income"
        var merchant: String?
        var isSuccessful: Bool
    }

    enum OCRError: LocalizedError {
        case noText
        case noAmount

        var errorDescription: String? {
            switch self {
            case .noText: return "截图里没有识别到文字，请确认是支付成功页截图"
            case .noAmount: return "没能从截图中识别出金额，请换一张更清晰的支付截图"
            }
        }
    }

    // MARK: - Vision 识别（仅本机执行）

    static func recognizeLines(from imageData: Data) async throws -> [String] {
        guard let image = cgImage(from: imageData) else {
            throw OCRError.noText
        }
        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations.compactMap { $0.topCandidates(1).first?.string }
                continuation.resume(returning: lines)
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private static func cgImage(from data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    // MARK: - 结构化提取（纯函数，可测）

    /// 从 OCR 文本行提取账单要素。启发式规则按微信/支付宝支付成功页的常见版式设计：
    /// 金额取「独立的 ¥ 大数字行」优先，其次任意含 ¥ 的行；类型按「收入/收款」关键词判定。
    static func extractBill(from lines: [String], now: Date = Date()) -> RecognizedBill {
        let joined = lines.joined(separator: "\n")

        // 金额：优先匹配整行只有钱的（支付成功页的大金额），否则取第一个含 ¥ 的数字
        var minorUnits: Int?
        for line in lines {
            if let value = moneyOnly(in: line) { minorUnits = value; break }
        }
        if minorUnits == nil {
            for line in lines {
                if line.contains("¥") || line.contains("￥"), let value = firstMoney(in: line) {
                    minorUnits = value
                    break
                }
            }
        }

        let type = joined.contains("收入") || joined.contains("已存入") || joined.contains("收款码")
            ? "income" : "expense"

        let merchant = merchantFrom(lines: lines)

        return RecognizedBill(
            occurredAt: dateFrom(lines: lines, now: now),
            minorUnits: minorUnits,
            type: type,
            merchant: merchant,
            isSuccessful: joined.contains("成功") || joined.contains("已支付") || joined.contains("已收账")
        )
    }

    /// 整行只有金额（可带正负号与 ¥/￥ 前缀）："−25.00" / "¥1,234.50"。
    /// 负号只表示支出方向（方向由 type 字段表达），金额取绝对值：
    /// 服务端对金额 ≤ 0 的行直接跳过，保留负号会让记录无声丢失。
    private static func moneyOnly(in line: String) -> Int? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let range = trimmed.range(of: #"^[-−+]?\s*[¥￥]?\s*\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?$"#, options: .regularExpression) else {
            return nil
        }
        let normalized = String(trimmed[range]).replacingOccurrences(of: "−", with: "-")
        return Money.minorUnits(fromInput: normalized).map { magnitude(of: $0) }
    }

    /// 行内第一个 ¥ 金额："支付金额 ¥25.00" → 2500（同样取绝对值）
    private static func firstMoney(in line: String) -> Int? {
        guard let range = line.range(of: #"[¥￥]\s*[-−]?\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?"#, options: .regularExpression) else {
            return nil
        }
        let text = String(line[range])
        let digits = text.drop { $0 == "¥" || $0 == "￥" || $0.isWhitespace }
        return Money.minorUnits(fromInput: String(digits).replacingOccurrences(of: "−", with: "-")).map { magnitude(of: $0) }
    }

    /// Int.min 安全的绝对值
    private static func magnitude(of value: Int) -> Int {
        value == Int.min ? Int.max : Swift.abs(value)
    }

    /// 商家：优先「商家：/商户：/对方：xxx」标注行，否则取最长的纯中文短行
    private static func merchantFrom(lines: [String]) -> String? {
        for line in lines {
            for prefix in ["商家：", "商家:", "商户：", "商户:", "对方：", "对方:"] {
                if let range = line.range(of: prefix) {
                    let candidate = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
                    if !candidate.isEmpty { return candidate }
                }
            }
        }
        return lines
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0.count <= 20 && !$0.contains(where: { $0.isNumber || $0 == "¥" }) }
            .filter(containsCJK)
            .max(by: { $0.count < $1.count })
    }

    private static func containsCJK(_ text: String) -> Bool {
        text.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) }
    }

    /// 日期：支持 "2026年9月12日"、"2026-09-12"、"09月12日"、"09-12 12:30"、"今天/昨天 HH:mm"
    private static func dateFrom(lines: [String], now: Date) -> String? {
        let joined = lines.joined(separator: "\n")
        let calendar = Calendar.current

        if let r = joined.range(of: #"\d{4}年\d{1,2}月\d{1,2}日"#, options: .regularExpression) {
            let parts = String(joined[r])
                .replacingOccurrences(of: "年", with: "-")
                .replacingOccurrences(of: "月", with: "-")
                .replacingOccurrences(of: "日", with: "")
            let nums = parts.split(separator: "-").compactMap { Int($0) }
            if nums.count == 3 {
                return formatted(year: nums[0], month: nums[1], day: nums[2])
            }
        }
        if let r = joined.range(of: #"\d{4}-\d{2}-\d{2}"#, options: .regularExpression) {
            return String(joined[r])
        }
        if let r = joined.range(of: #"(?<!\d)(\d{1,2})月(\d{1,2})日"#, options: .regularExpression) {
            let nums = joined[r].split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
            if nums.count == 2 {
                let year = calendar.component(.year, from: now)
                return formatted(year: year, month: nums[0], day: nums[1])
            }
        }
        if joined.contains("昨天") {
            let yesterday = calendar.date(byAdding: .day, value: -1, to: now)!
            return formatted(year: calendar.component(.year, from: yesterday),
                             month: calendar.component(.month, from: yesterday),
                             day: calendar.component(.day, from: yesterday))
        }
        if joined.contains("今天") {
            return formatted(year: calendar.component(.year, from: now),
                             month: calendar.component(.month, from: now),
                             day: calendar.component(.day, from: now))
        }
        return nil
    }

    private static func formatted(year: Int, month: Int, day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    // MARK: - 合成账单文本（微信支付明细格式，服务端自动识别 + 走暂存管道）

    /// 表头必须同含「交易时间/金额」（行解析）与「收/支/交易单号/当前状态」（来源识别），
    /// 字段全部引号包裹（服务端 splitCsvLine 支持引号内逗号）。
    static func synthesizeBillText(_ bill: RecognizedBill, now: Date = Date(), fileNameSalt: String = "") -> String {
        let minor = bill.minorUnits ?? 0
        let occurredAt = bill.occurredAt
            ?? formatted(year: Calendar.current.component(.year, from: now),
                         month: Calendar.current.component(.month, from: now),
                         day: Calendar.current.component(.day, from: now))
        let merchant = sanitizeText(bill.merchant ?? "截图识别")
        let type = bill.type == "income" ? "收入" : "支出"
        let amount = Currencies.cny.decimalString(minor)
        let status = bill.isSuccessful ? "支付成功" : ""
        let externalId = syntheticExternalId(bill: bill, occurredAt: occurredAt, salt: fileNameSalt)

        let header = "交易时间,交易单号,商品,收/支,金额,当前状态"
        let row = [quote(occurredAt), quote(externalId), quote(merchant), quote(type), quote(amount), quote(status)]
            .joined(separator: ",")
        return header + "\n" + row + "\n"
    }

    /// 稳定合成单号：同一笔交易（同日期/金额/类型/商家）的重复截图导入会被服务端硬去重
    static func syntheticExternalId(bill: RecognizedBill, occurredAt: String, salt: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data("\(occurredAt)|\(bill.minorUnits ?? 0)|\(bill.type)|\(bill.merchant ?? "")|\(salt)".utf8))
        return "ocr-" + digest.map { String(format: "%02x", $0) }.joined().prefix(16)
    }

    /// 截图上传文件名（服务端按扩展名走 txt 解析）
    static func suggestedFileName(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        formatter.timeZone = .current
        return "screenshot-\(formatter.string(from: now)).txt"
    }

    // MARK: - 文本清洗

    /// 引号包裹 + 内部引号翻倍（服务端 splitCsvLine 语义）
    private static func quote(_ field: String) -> String {
        "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    /// OCR 文本可能带出换行/引号/多余空白，压平成单行
    private static func sanitizeText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\"", with: "'")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
