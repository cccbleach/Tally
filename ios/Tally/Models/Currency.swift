import Foundation

/// 币种元数据。金额一律以「最小货币单位的整数」表示（人民币为分），
/// 展示与输入解析都按对应币种的小数位处理，任何金额运算都不经过 Double。
///
/// 全站单一币种：2026-09 起多币种与汇率已下线（服务端不再有 currency 字段，
/// 历史外币数据已在迁移里按汇率折算成人民币并保留原币种备注），因此这里只保留人民币。
struct CurrencyInfo: Equatable, Hashable, Sendable {
    let code: String
    let symbol: String
    /// 小数位数（CNY/USD = 2，JPY/KRW = 0），决定展示精度与输入解析的合法小数位
    let minorUnits: Int

    init(code: String, symbol: String, minorUnits: Int) {
        self.code = code
        self.symbol = symbol
        self.minorUnits = minorUnits
    }

    /// 10^minorUnits：一个主单位等于多少最小单位
    var scale: Int {
        var result = 1
        for _ in 0..<minorUnits { result *= 10 }
        return result
    }

    // MARK: - 格式化

    /// 展示格式：符号 + 千分位，负数带前导减号。如 "¥1,234.50"、"-JP¥500"。
    func format(_ amount: Int) -> String {
        let (negative, body) = components(of: amount)
        return (negative ? "-" : "") + symbol + body
    }

    /// 无符号展示文本（含货币符号与千分位），供上层自行拼接正负前缀（如收支 +/-）。
    func formatMagnitude(_ amount: Int) -> String {
        symbol + components(of: amount).body
    }

    /// 纯小数字符串（无符号、无千分位），负数带减号："1234.50"。
    /// 用于输入框预填与 CSV 导出（回读方不该处理千分位）。
    func decimalString(_ amount: Int) -> String {
        let (negative, body) = components(of: amount, grouped: false)
        return (negative ? "-" : "") + body
    }

    /// 拆出符号与主体文本。绝对值走 UInt64，Int.min 也不会溢出。
    private func components(of amount: Int, grouped: Bool = true) -> (negative: Bool, body: String) {
        let negative = amount < 0
        let magnitude = UInt64(amount.magnitude)
        let scale = UInt64(self.scale)
        let major = magnitude / scale
        let fraction = magnitude % scale

        var majorText = String(major)
        if grouped, majorText.count > 3 {
            majorText = Self.withGrouping(majorText)
        }
        if minorUnits > 0 {
            var fractionText = String(fraction)
            while fractionText.count < minorUnits { fractionText = "0" + fractionText }
            return (negative, majorText + "." + fractionText)
        }
        return (negative, majorText)
    }

    /// 千分位分组合法性：除末组外（末组可能带小数部分，交给后续数字校验），
    /// 首组 1–3 位数字、其余组恰好 3 位数字。"1,234,567" / "1,234.56" 合法；
    /// "1.2.3"（组长度参差）是输入错误，拒绝而不是猜一个值。
    private static func isValidGrouping(_ text: String, separator: Character) -> Bool {
        let groups = text.split(separator: separator, omittingEmptySubsequences: false)
        guard groups.count > 1 else { return false }
        guard let first = groups.first, (1...3).contains(first.count), first.allSatisfy(\.isNumber) else {
            return false
        }
        // 中间组必须恰好 3 位数字（末组允许形如 "234.56"，由后续小数解析校验）
        let middleGroups = groups.dropFirst().dropLast()
        return middleGroups.allSatisfy { $0.count == 3 && $0.allSatisfy(\.isNumber) }
    }

    /// 每 3 位插入千分位逗号："1234567" → "1,234,567"
    private static func withGrouping(_ digits: String) -> String {
        var result = ""
        let chars = Array(digits)
        for (offset, char) in chars.enumerated() {
            if offset > 0 && (chars.count - offset) % 3 == 0 { result += "," }
            result.append(char)
        }
        return result
    }

    // MARK: - 输入解析

    /// 输入的金额文本（主单位）→ 最小单位整数。纯整数运算。
    ///
    /// 容错规则：接受 "." 与 "," 作小数分隔（最后一个分隔符为小数点，其余视为千分位）；
    /// 币种符号/代码、全角逗号、空格与 ' 、_ 分隔符自动剔除；显式 +/- 前缀。
    /// 小数位多于 `minorUnits`（如 CNY 输入 3 位小数）返回 nil，避免静默丢精度。
    func parseMinorUnits(_ input: String) -> Int? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !symbol.isEmpty { text = text.replacingOccurrences(of: symbol, with: "") }
        text = text.replacingOccurrences(of: code, with: "", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "，", with: ",")
        text.removeAll { $0.isWhitespace || $0 == "'" || $0 == "_" }

        var negative = false
        if let first = text.first, first == "-" || first == "+" {
            negative = first == "-"
            text.removeFirst()
        }
        guard !text.isEmpty, !text.contains("-"), !text.contains("+") else { return nil }

        let dotCount = text.filter { $0 == "." }.count
        let commaCount = text.filter { $0 == "," }.count

        // 决定小数分隔符：两类分隔符并存时取最后一个为小数点、另一类全部当千分位剔除；
        // 同类分隔符出现多次视为纯千分位分组（"1,234,567"）；仅出现一次才是小数点。
        var decimalSeparator: Character?
        if text.contains("."), text.contains(",") {
            if let lastDot = text.lastIndex(of: "."), let lastComma = text.lastIndex(of: ",") {
                decimalSeparator = lastDot > lastComma ? "." : ","
                let grouping: Character = decimalSeparator == "." ? "," : "."
                guard Self.isValidGrouping(text, separator: grouping) else { return nil }
                text.removeAll { $0 == grouping }
            }
        } else if dotCount > 1 {
            guard Self.isValidGrouping(text, separator: ".") else { return nil }
            text.removeAll { $0 == "." }
        } else if commaCount > 1 {
            guard Self.isValidGrouping(text, separator: ",") else { return nil }
            text.removeAll { $0 == "," }
        } else if dotCount == 1 {
            decimalSeparator = "."
        } else if commaCount == 1 {
            decimalSeparator = ","
        }

        let majorText: String
        let fractionText: String
        if let separator = decimalSeparator {
            let parts = text.split(separator: separator, omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }
            majorText = parts[0].isEmpty ? "0" : String(parts[0])
            fractionText = String(parts[1])
        } else {
            majorText = text
            fractionText = ""
        }
        guard !majorText.isEmpty,
              majorText.allSatisfy(\.isNumber),
              fractionText.allSatisfy(\.isNumber),
              fractionText.count <= minorUnits else { return nil }

        let paddedFraction = fractionText + String(repeating: "0", count: minorUnits - fractionText.count)
        guard let major = Int64(majorText) else { return nil }
        let fraction = minorUnits > 0 ? Int64(paddedFraction) ?? 0 : 0
        let (scaled, multiplyOverflow) = major.multipliedReportingOverflow(by: Int64(scale))
        guard !multiplyOverflow else { return nil }
        let (magnitude, addOverflow) = scaled.addingReportingOverflow(fraction)
        guard !addOverflow else { return nil }
        let signed = negative ? -magnitude : magnitude
        return Int(exactly: signed)
    }
}

/// 币种注册表：全站只支持人民币。保留 `CurrencyInfo` 是因为它承载金额格式化/解析规则
/// （千分位、小数位校验、符号剔除），这些规则与具体币种无关，将来若要重新支持多币种只需往这里加。
enum Currencies {
    static let cny = CurrencyInfo(code: "CNY", symbol: "¥", minorUnits: 2)
}
