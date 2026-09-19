import Foundation

/// 日历记账的纯逻辑（无 SwiftUI）：月历网格、按日收支汇总、紧凑金额文本。
/// 与视图分离是为了单元测试可以直接钉死网格形状与格式化行为。
enum MonthCalendar {
    /// 单日收支合计（分）。金额恒为正，方向由交易 type 决定。
    struct DayTotals: Hashable {
        var income: Int
        var expense: Int
        var isEmpty: Bool { income == 0 && expense == 0 }
    }

    /// 日历的显示筛选：全部（收支都显示）/ 只看收入 / 只看支出。
    enum Filter: String, CaseIterable, Identifiable {
        case all
        case income
        case expense

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: return "全部"
            case .income: return "收入"
            case .expense: return "支出"
            }
        }
    }

    /// 周标题，周一开头。App 是纯中文界面，写死中文避免跟随模拟器/系统语言变化。
    static let weekdayHeadings = ["一", "二", "三", "四", "五", "六", "日"]

    /// 月历网格：nil 为对齐补位。每行恰好 7 个格子，行首对齐周一。
    static func grid(year: Int, month: Int) -> [[Int?]] {
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        guard let first = Calendar.current.date(from: comps),
              let days = Calendar.current.range(of: .day, in: .month, for: first)?.count, days > 0
        else { return [] }
        // .weekday 恒为 周日=1…周六=7；周一开头的偏移 = (weekday + 5) % 7（周一→0，周日→6）
        let offset = (Calendar.current.component(.weekday, from: first) + 5) % 7
        var cells: [Int?] = Array(repeating: nil, count: offset)
        cells.append(contentsOf: (1...days).map { Optional($0) })
        while cells.count % 7 != 0 { cells.append(nil) }
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0 ..< $0 + 7]) }
    }

    /// 月内日号 → "yyyy-MM-dd" 日期键（与后端 DailyStat.date、Transaction.date 同格式）。
    static func dateKey(year: Int, month: Int, day: Int) -> String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// DailyStat 列表 → 日期键 → 收支合计。
    static func totalsByDay(_ daily: [DailyStat]) -> [String: DayTotals] {
        var result: [String: DayTotals] = [:]
        for d in daily {
            var t = result[d.date] ?? DayTotals(income: 0, expense: 0)
            t.income += d.income
            t.expense += d.expense
            result[d.date] = t
        }
        return result
    }

    /// 紧凑金额文本（日历小格子放不下完整格式）：纯整数运算，不经过 Double。
    /// 整数元省小数、角为 0 时再省分位："2350"→"23.5"、"2300"→"23"、"5"→"0.05"、"123456"→"1234.56"。
    static func compactAmount(_ minor: Int) -> String {
        let magnitude = abs(minor)
        let major = magnitude / 100
        let cents = magnitude % 100
        if cents == 0 { return String(major) }
        if cents % 10 == 0 { return "\(major).\(cents / 10)" }
        let frac = cents < 10 ? "0\(cents)" : String(cents)
        return "\(major).\(frac)"
    }

    /// 日期键是否是今天（注入 now 便于测试）。
    static func isToday(_ key: String, now: Date = Date()) -> Bool {
        key == TallyDate.dayFormatter.string(from: now)
    }
}
