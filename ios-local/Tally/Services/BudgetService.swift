//
//  BudgetService.swift
//  Tally
//
//  Budget progress computation.
//
//  Rules:
//  - A whole-ledger budget (categoryID == nil) compares against total
//    expense for the period.
//  - A category budget (categoryID != nil) compares against that category's
//    net expense for the period.
//  - Refunds offset expense.
//  - Transfers are excluded.
//  - A budget with `periodISO` only applies to that exact period; otherwise it
//    applies to every period (recurring monthly budget).
//  - Only enabled budgets are considered.
//

import Foundation

public struct BudgetProgress: Identifiable, Equatable {
    public var id: UUID { budget.id }
    public let budget: Budget
    public let spentMinorUnits: Int64
    public let limitMinorUnits: Int64
    public let categoryName: String?

    public var remainingMinorUnits: Int64 { limitMinorUnits - spentMinorUnits }
    public var isOver: Bool { spentMinorUnits > limitMinorUnits }
    /// 0...1 or more when over budget.
    public var ratio: Double {
        guard limitMinorUnits > 0 else { return spentMinorUnits > 0 ? 1 : 0 }
        return Double(spentMinorUnits) / Double(limitMinorUnits)
    }
}

public enum BudgetService {

    public static func applies(_ budget: Budget, to period: MonthPeriod) -> Bool {
        guard budget.isEnabled else { return false }
        if let periodISO = budget.periodISO, periodISO != period.isoString {
            return false
        }
        return true
    }

    /// Spent amount for a given budget in the period.
    public static func spent(
        for budget: Budget,
        period: MonthPeriod,
        transactions: [Transaction],
        categories: [Category],
        dayStartsOn: Int = 1,
        calendar: Calendar = .current
    ) -> Int64 {
        let period = MonthPeriod(year: period.year, month: period.month, dayStartsOn: dayStartsOn)
        if let categoryID = budget.categoryID {
            var spent: Int64 = 0
            for t in transactions where !t.isDeleted && period.contains(t.date, calendar: calendar) {
                guard t.currencyCode == budget.currencyCode else { continue }
                if t.kind == .expense, let cat = t.category, cat.id == categoryID {
                    // Resolve category from object to handle rename; fallback to id.
                    spent += t.amountMinorUnits
                } else if t.kind == .refund {
                    let refundCategoryID = t.refundOf?.category?.id ?? t.category?.id
                    if refundCategoryID == categoryID { spent -= t.amountMinorUnits }
                }
            }
            return spent
        } else {
            return StatsService.summary(
                in: period,
                transactions: transactions,
                dayStartsOn: dayStartsOn,
                currencyCode: budget.currencyCode,
                calendar: calendar
            ).expenseMinorUnits
        }
    }

    public static func progress(
        for budget: Budget,
        period: MonthPeriod,
        transactions: [Transaction],
        categories: [Category],
        dayStartsOn: Int = 1,
        calendar: Calendar = .current
    ) -> BudgetProgress? {
        guard applies(budget, to: period) else { return nil }
        let spent = spent(for: budget, period: period, transactions: transactions, categories: categories, dayStartsOn: dayStartsOn, calendar: calendar)
        return BudgetProgress(
            budget: budget,
            spentMinorUnits: spent,
            limitMinorUnits: budget.amountMinorUnits,
            categoryName: budget.categoryID.flatMap { id in categories.first { $0.id == id }?.name }
        )
    }

    public static func allProgress(
        budgets: [Budget],
        period: MonthPeriod,
        transactions: [Transaction],
        categories: [Category],
        dayStartsOn: Int = 1,
        calendar: Calendar = .current
    ) -> [BudgetProgress] {
        budgets.compactMap { progress(for: $0, period: period, transactions: transactions, categories: categories, dayStartsOn: dayStartsOn, calendar: calendar) }
            .sorted { $0.budget.categoryID == nil && $1.budget.categoryID != nil }
    }
}
