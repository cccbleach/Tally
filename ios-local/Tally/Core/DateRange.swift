//
//  DateRange.swift
//  Tally
//
//  Calendar range helpers. Supports a configurable "month start day"
//  (1...31). A reporting month is [start, nextStart).
//

import Foundation

public struct MonthPeriod: Equatable, Hashable, Sendable {
    public let year: Int
    public let month: Int   // 1...12 (the month in which the period starts)
    public let dayStartsOn: Int

    public init(year: Int, month: Int, dayStartsOn: Int = 1) {
        self.year = year
        self.month = month
        self.dayStartsOn = max(1, min(31, dayStartsOn))
    }

    /// The calendar period after this one.
    public var next: MonthPeriod {
        var y = year
        var m = month + 1
        if m > 12 { m = 1; y += 1 }
        return MonthPeriod(year: y, month: m, dayStartsOn: dayStartsOn)
    }

    /// The calendar period before this one.
    public var previous: MonthPeriod {
        var y = year
        var m = month - 1
        if m < 1 { m = 12; y -= 1 }
        return MonthPeriod(year: y, month: m, dayStartsOn: dayStartsOn)
    }

    public var displayTitle: String {
        String(format: "%d年%02d月", year, month)
    }

    public var isoString: String {
        String(format: "%04d-%02d", year, month)
    }

    /// The label of the period that a given date falls into, using the
    /// configured month-start day.
    public static func containing(_ date: Date, dayStartsOn: Int, calendar: Calendar = .current) -> MonthPeriod {
        let startDay = max(1, min(31, dayStartsOn))
        let comps = calendar.dateComponents([.year, .month], from: date)
        let candidate = MonthPeriod(
            year: comps.year ?? 1,
            month: comps.month ?? 1,
            dayStartsOn: startDay
        )
        return date >= candidate.startDate(calendar: calendar) ? candidate : candidate.previous
    }

    public func shifted(by months: Int) -> MonthPeriod {
        var y = year
        var m = month + months
        while m < 1 { m += 12; y -= 1 }
        while m > 12 { m -= 12; y += 1 }
        return MonthPeriod(year: y, month: m, dayStartsOn: dayStartsOn)
    }

    /// Start date of the period (inclusive).
    public func startDate(calendar: Calendar = .current) -> Date {
        var firstComponents = DateComponents()
        firstComponents.year = year
        firstComponents.month = month
        firstComponents.day = 1
        firstComponents.hour = 0
        firstComponents.minute = 0
        firstComponents.second = 0
        guard let firstDay = calendar.date(from: firstComponents),
              let validDays = calendar.range(of: .day, in: .month, for: firstDay) else {
            return .distantPast
        }
        let clampedDay = min(max(1, dayStartsOn), validDays.count)
        return calendar.date(byAdding: .day, value: clampedDay - 1, to: firstDay) ?? .distantPast
    }

    /// End date of the period (exclusive) — the next period's start.
    public func endDate(calendar: Calendar = .current) -> Date {
        next.startDate(calendar: calendar)
    }

    /// Whether a date falls within this period.
    public func contains(_ date: Date, calendar: Calendar = .current) -> Bool {
        let start = startDate(calendar: calendar)
        let end = endDate(calendar: calendar)
        return date >= start && date < end
    }
}

public enum DateRange {

    public static func dayRange(containing date: Date, calendar: Calendar = .current) -> (start: Date, end: Date) {
        let start = calendar.startOfDay(for: date)
        let end = calendar.date(byAdding: .day, value: 1, to: start) ?? start
        return (start, end)
    }

    /// A canonical list of periods between (inclusive) two periods.
    public static func periods(from: MonthPeriod, through: MonthPeriod) -> [MonthPeriod] {
        var result: [MonthPeriod] = []
        var current = from
        while (current.year, current.month) <= (through.year, through.month) {
            result.append(current)
            if current.year == through.year && current.month == through.month { break }
            current = current.next
        }
        return result
    }
}
