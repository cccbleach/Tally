import Foundation

/// 金额展示与输入解析的门面。全站人民币（见 Currency.swift），不再有按币种分派的参数：
/// 服务端返回的聚合与流水金额都是人民币分，直接按人民币格式化即可。
enum Money {
    static let currency = Currencies.cny

    static func format(_ amount: Int) -> String {
        currency.format(amount)
    }

    /// 带正负号的金额（首页结余、净资产等）：负数加 "-"，正数无前缀
    static func signed(_ amount: Int) -> String {
        (amount < 0 ? "-" : "") + currency.formatMagnitude(amount)
    }

    /// 无符号文本（含货币符号）：供 AmountLabel 这类自带 +/- 前缀的场景拼接
    static func formatMagnitude(_ amount: Int) -> String {
        currency.formatMagnitude(amount)
    }

    /// 输入框金额（主单位小数字符串）→ 最小单位整数。纯整数运算，不经过 Double；
    /// 小数位多于 2 位（如 ¥1.999）返回 nil，避免静默丢精度。
    static func minorUnits(fromInput text: String) -> Int? {
        currency.parseMinorUnits(text)
    }
}
