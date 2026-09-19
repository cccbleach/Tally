import XCTest
@testable import Tally

// 日历记账纯逻辑回归（MonthCalendar：网格形状 / 按日汇总 / 紧凑金额）。
//
// 日历视图的数据与形状全部来自这里的纯函数，视图层只做渲染，因此钉死：
//   1) 网格恒为 7 列、周一开头、按整周补位——任何月份都不能画出歪的星期对齐；
//   2) 按日汇总是纯整数累加（金额是分，不经过 Double）；
//   3) 紧凑金额文本是小格子专用格式：整数元省小数、角为 0 省分位，逐样例钉死。
final class CalendarLogicTests: XCTestCase {
    // MARK: - 月历网格

    func testGridMondayFirstAndCompleteWeeks() {
        // 2026-09-01 是周二：1 个补位（周一），30 天，末尾补齐整周
        let sep = MonthCalendar.grid(year: 2026, month: 9)
        XCTAssertEqual(sep.first!, [nil, 1, 2, 3, 4, 5, 6])
        XCTAssertEqual(sep.last!, [28, 29, 30, nil, nil, nil, nil])
        XCTAssertTrue(sep.allSatisfy { $0.count == 7 })

        // 2026-02-01 是周日：6 个补位，28 天（平年），末尾补 1 格到整周
        let feb = MonthCalendar.grid(year: 2026, month: 2)
        XCTAssertEqual(feb.first!, [nil, nil, nil, nil, nil, nil, 1])
        XCTAssertEqual(feb.last!, [23, 24, 25, 26, 27, 28, nil])

        // 周一开头月份（2026-06-01 是周一）：无前导补位
        let june = MonthCalendar.grid(year: 2026, month: 6)
        XCTAssertEqual(june.first!, [1, 2, 3, 4, 5, 6, 7])
    }

    func testGridCoversAllDaysExactlyOnce() {
        for (year, month, expectedDays) in [(2026, 2, 28), (2026, 9, 30), (2028, 2, 29), (2026, 12, 31)] {
            let flat = MonthCalendar.grid(year: year, month: month).flatMap { $0 }
            XCTAssertEqual(flat.compactMap { $0 }, Array(1...expectedDays), "\(year)-\(month)")
        }
    }

    // MARK: - 按日汇总

    func testTotalsByDayAccumulatesSameDayEntries() {
        let daily = [
            DailyStat(date: "2026-09-01", income: 100, expense: 0),
            DailyStat(date: "2026-09-01", income: 0, expense: 250),
            DailyStat(date: "2026-09-02", income: 0, expense: 50),
        ]
        let totals = MonthCalendar.totalsByDay(daily)
        XCTAssertEqual(totals["2026-09-01"], MonthCalendar.DayTotals(income: 100, expense: 250))
        XCTAssertEqual(totals["2026-09-02"], MonthCalendar.DayTotals(income: 0, expense: 50))
        XCTAssertNil(totals["2026-09-03"])
    }

    // MARK: - 日期键与今天判定

    func testDateKeyZeroPadsMonthAndDay() {
        XCTAssertEqual(MonthCalendar.dateKey(year: 2026, month: 9, day: 1), "2026-09-01")
        XCTAssertEqual(MonthCalendar.dateKey(year: 2026, month: 12, day: 18), "2026-12-18")
    }

    func testIsTodayComparesAgainstInjectedNow() {
        let now = TallyDate.dayFormatter.date(from: "2026-09-19")!
        XCTAssertTrue(MonthCalendar.isToday("2026-09-19", now: now))
        XCTAssertFalse(MonthCalendar.isToday("2026-09-18", now: now))
    }

    // MARK: - 紧凑金额（分 → 小格子文本）

    func testCompactAmountStripsTrailingZeros() {
        XCTAssertEqual(MonthCalendar.compactAmount(0), "0")
        XCTAssertEqual(MonthCalendar.compactAmount(100), "1")
        XCTAssertEqual(MonthCalendar.compactAmount(5), "0.05")
        XCTAssertEqual(MonthCalendar.compactAmount(50), "0.5")
        XCTAssertEqual(MonthCalendar.compactAmount(2300), "23")
        XCTAssertEqual(MonthCalendar.compactAmount(2350), "23.5")
        XCTAssertEqual(MonthCalendar.compactAmount(123456), "1234.56")
        XCTAssertEqual(MonthCalendar.compactAmount(13954409), "139544.09")
    }
}
