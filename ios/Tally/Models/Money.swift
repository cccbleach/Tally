import Foundation

/// 金额展示与输入解析的门面。
///
/// `currency` 缺省 = 账本本位币口径：统计/预算/负债等聚合金额已由服务端折算到本位币
/// （BASE_CURRENCY）返回，这些场景直接 `Money.format(x)`；流水/账户等**自带币种**的
/// 数据必须显式传 `currency:`，否则美元账户的余额会显示成 ¥。
enum Money {
    static let defaultCurrencyCode = "CNY"

    static func format(_ amount: Int, currency code: String? = nil) -> String {
        Currencies.info(for: code).format(amount)
    }

    /// 带正负号的金额（首页结余、净资产等）：负数加 "-"，正数无前缀
    static func signed(_ amount: Int, currency code: String? = nil) -> String {
        let info = Currencies.info(for: code)
        return (amount < 0 ? "-" : "") + info.formatMagnitude(amount)
    }

    /// 无符号文本（含货币符号）：供 AmountLabel 这类自带 +/- 前缀的场景拼接
    static func formatMagnitude(_ amount: Int, currency code: String? = nil) -> String {
        Currencies.info(for: code).formatMagnitude(amount)
    }

    /// 输入框金额（主单位小数字符串）→ 最小单位整数。纯整数运算，不经过 Double；
    /// 小数位多于币种精度（如 CNY 输 3 位小数）返回 nil，避免静默丢精度。
    static func minorUnits(fromInput text: String, currency code: String? = nil) -> Int? {
        Currencies.info(for: code).parseMinorUnits(text)
    }
}
