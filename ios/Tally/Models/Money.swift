import Foundation

enum Money {
    static func format(_ cents: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "CNY"
        formatter.currencySymbol = "¥"
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: Double(cents) / 100.0)) ?? "¥0.00"
    }

    // 带正负号的金额，用于首页摘要
    static func signed(_ cents: Int) -> String {
        (cents >= 0 ? "" : "-") + format(abs(cents))
    }

    // 输入的数字字符串（元）转分
    static func cents(fromYuanString s: String) -> Int? {
        let cleaned = s.replacingOccurrences(of: ",", with: "")
        guard let value = Double(cleaned) else { return nil }
        return Int((value * 100).rounded())
    }
}
