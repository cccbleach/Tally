//
//  StatsService.swift
//  Tally
//
//  Monthly summaries, category breakdowns and trends.
//
//  Statistical口径 (definitions):
//  - Income  = sum of non-deleted `income` transactions in the period.
//  - Expense = sum of non-deleted `expense` transactions in the period
//              MINUS refunds in the period (a refund offsets the original
//              spend for the month in which the refund arrives).
//  - 结余 (balance) = Income − Expense.
//  - Transfers are never counted as income or expense.
//  - Soft-deleted transactions are excluded everywhere.
//

import Foundation

public struct MonthSummary: Equatable, Sendable {
    public let period: MonthPeriod
    public let incomeMinorUnits: Int64
    public let expenseMinorUnits: Int64
    /// Income − Expense
    public let netMinorUnits: Int64

    public init(period: MonthPeriod, income: Int64, expense: Int64) {
        self.period = period
        self.incomeMinorUnits = income
        self.expenseMinorUnits = expense
        self.netMinorUnits = income - expense
    }
}

public struct CategoryBreakdown: Identifiable, Equatable, Sendable {
    public var id: UUID { categoryID }
    public let categoryID: UUID
    public let name: String
    public let icon: String
    public let colorHex: String
    public let amountMinorUnits: Int64

    public init(categoryID: UUID, name: String, icon: String, colorHex: String, amountMinorUnits: Int64) {
        self.categoryID = categoryID
        self.name = name
        self.icon = icon
        self.colorHex = colorHex
        self.amountMinorUnits = amountMinorUnits
    }
}

public enum StatsService {

    private static func isInPeriod(_ t: Transaction, _ period: MonthPeriod, dayStartsOn: Int, calendar: Calendar) -> Bool {
        period.contains(t.date, calendar: calendar)
    }

    public static func summary(
        in period: MonthPeriod,
        transactions: [Transaction],
        dayStartsOn: Int = 1,
        currencyCode: String? = nil,
        calendar: Calendar = .current
    ) -> MonthSummary {
        var income: Int64 = 0
        var expense: Int64 = 0
        let period = MonthPeriod(year: period.year, month: period.month, dayStartsOn: dayStartsOn)
        for t in transactions where !t.isDeleted && t.kind != .transfer {
            if let currencyCode, t.currencyCode != currencyCode { continue }
            guard isInPeriod(t, period, dayStartsOn: dayStartsOn, calendar: calendar) else { continue }
            switch t.kind {
            case .income: income += t.amountMinorUnits
            case .expense: expense += t.amountMinorUnits
            case .refund: expense -= t.amountMinorUnits
            case .transfer: break
            }
        }
        return MonthSummary(period: period, income: income, expense: expense)
    }

    /// Expense breakdown by category for the period (after refunds offset is
    /// applied per transaction, not per category, to keep semantics simple).
    public static func expenseBreakdown(
        in period: MonthPeriod,
        transactions: [Transaction],
        categories: [Category],
        dayStartsOn: Int = 1,
        currencyCode: String? = nil,
        calendar: Calendar = .current
    ) -> [CategoryBreakdown] {
        var amounts: [UUID: Int64] = [:]
        for t in transactions where !t.isDeleted {
            if let currencyCode, t.currencyCode != currencyCode { continue }
            guard t.kind == .expense || t.kind == .refund else { continue }
            guard isInPeriod(t, period, dayStartsOn: dayStartsOn, calendar: calendar) else { continue }
            guard let category = t.category else { continue }
            switch t.kind {
            case .expense: amounts[category.id, default: 0] += t.amountMinorUnits
            case .refund: amounts[t.refundOf?.category?.id ?? category.id, default: 0] -= t.amountMinorUnits
            default: break
            }
        }
        let byID = Dictionary(uniqueKeysWithValues: categories.map { ($0.id, $0) })
        var result: [CategoryBreakdown] = []
        for (id, amount) in amounts where amount != 0 {
            let cat = byID[id]
            result.append(CategoryBreakdown(
                categoryID: id,
                name: cat?.name ?? "未分类",
                icon: cat?.icon ?? "tag",
                colorHex: cat?.colorHex ?? "8E8E93",
                amountMinorUnits: amount
            ))
        }
        return result.sorted { $0.amountMinorUnits > $1.amountMinorUnits }
    }

    /// Daily totals for a trend chart within the period.
    public struct DailyPoint: Identifiable, Sendable {
        public var id: Date { day }
        public let day: Date
        public let incomeMinorUnits: Int64
        public let expenseMinorUnits: Int64
    }

    public static func dailyTotals(
        in period: MonthPeriod,
        transactions: [Transaction],
        dayStartsOn: Int = 1,
        currencyCode: String? = nil,
        calendar: Calendar = .current
    ) -> [DailyPoint] {
        var map: [Date: (income: Int64, expense: Int64)] = [:]
        for t in transactions where !t.isDeleted && t.kind != .transfer {
            if let currencyCode, t.currencyCode != currencyCode { continue }
            guard isInPeriod(t, period, dayStartsOn: dayStartsOn, calendar: calendar) else { continue }
            let day = calendar.startOfDay(for: t.date)
            switch t.kind {
            case .income: map[day, default: (0, 0)].income += t.amountMinorUnits
            case .expense: map[day, default: (0, 0)].expense += t.amountMinorUnits
            case .refund: map[day, default: (0, 0)].expense -= t.amountMinorUnits
            case .transfer: break
            }
        }
        return map.sorted { $0.key < $1.key }.map { DailyPoint(day: $0.key, incomeMinorUnits: $0.value.income, expenseMinorUnits: $0.value.expense) }
    }

    /// A series of monthly summaries ending at `through` (inclusive), for trends.
    public static func trend(
        count: Int,
        endingAt through: MonthPeriod,
        transactions: [Transaction],
        dayStartsOn: Int = 1,
        currencyCode: String? = nil,
        calendar: Calendar = .current
    ) -> [MonthSummary] {
        let start = through.shifted(by: -(count - 1))
        let periods = DateRange.periods(from: start, through: through)
        return periods.map {
            summary(
                in: $0,
                transactions: transactions,
                dayStartsOn: dayStartsOn,
                currencyCode: currencyCode,
                calendar: calendar
            )
        }
    }
}
