//
//  StatsView.swift
//  Tally
//
//  Monthly income/expense/balance, category breakdown (donut) and daily trend
//  chart. All charts include an accessibility text summary.
//

import SwiftUI
import SwiftData
import Charts

public struct StatsView: View {
    @Environment(AppState.self) private var appState
    @Query private var ledgers: [Ledger]
    @Query private var settingsList: [AppSettings]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query private var allCategories: [Category]

    @State private var selectedMonth = Date()

    public init() {}

    private var settings: AppSettings? { settingsList.first }
    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var ledgerTransactions: [Transaction] {
        guard let ledger else { return [] }
        return allTransactions.filter { $0.ledger?.id == ledger.id && !$0.isDeleted }
    }

    private var categories: [Category] {
        guard let ledger else { return [] }
        return allCategories.filter { $0.ledger?.id == ledger.id }
    }

    private var dayStartsOn: Int { settings?.monthStartsOn ?? 1 }

    private var period: MonthPeriod {
        MonthPeriod.containing(selectedMonth, dayStartsOn: dayStartsOn)
    }

    private var currencyCode: String { ledger?.currencyCode ?? settings?.defaultCurrencyCode ?? "CNY" }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    monthNavigator
                    summaryCard
                    categoryBreakdownCard
                    trendCard
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("统计")
        }
    }

    private var monthNavigator: some View {
        HStack {
            Button {
                selectedMonth = Calendar.current.date(byAdding: .month, value: -1, to: selectedMonth) ?? selectedMonth
            } label: {
                Image(systemName: "chevron.left")
            }
            .accessibilityLabel("上一个月")
            Spacer()
            Text(period.displayTitle).font(.headline)
            Spacer()
            Button {
                selectedMonth = Calendar.current.date(byAdding: .month, value: 1, to: selectedMonth) ?? selectedMonth
            } label: {
                Image(systemName: "chevron.right")
            }
            .accessibilityLabel("下一个月")
        }
        .padding(.horizontal, 4)
    }

    private var summary: MonthSummary {
        StatsService.summary(
            in: period,
            transactions: ledgerTransactions,
            dayStartsOn: dayStartsOn,
            currencyCode: currencyCode
        )
    }

    private var summaryCard: some View {
        VStack(spacing: 12) {
            HStack(spacing: 0) {
                SummaryItem(label: "收入", value: Money(minorUnits: summary.incomeMinorUnits, currencyCode: currencyCode).formatted, color: .green)
                Divider().frame(height: 40)
                SummaryItem(label: "支出", value: Money(minorUnits: summary.expenseMinorUnits, currencyCode: currencyCode).formatted, color: .red)
                Divider().frame(height: 40)
                SummaryItem(label: "结余", value: Money(minorUnits: summary.netMinorUnits, currencyCode: currencyCode).formatted, color: .primary)
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("本月收入\(Money(minorUnits: summary.incomeMinorUnits, currencyCode: currencyCode).formatted)，支出\(Money(minorUnits: summary.expenseMinorUnits, currencyCode: currencyCode).formatted)，结余\(Money(minorUnits: summary.netMinorUnits, currencyCode: currencyCode).formatted)")
    }

    private var categoryBreakdown: [CategoryBreakdown] {
        StatsService.expenseBreakdown(
            in: period,
            transactions: ledgerTransactions,
            categories: categories,
            dayStartsOn: dayStartsOn,
            currencyCode: currencyCode
        )
    }

    private var categoryBreakdownCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("分类占比（支出）").font(.headline)
            if categoryBreakdown.isEmpty {
                Text("本月暂无支出数据")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                Chart(categoryBreakdown, id: \.categoryID) { item in
                    SectorMark(
                        angle: .value("金额", max(item.amountMinorUnits, 0)),
                        innerRadius: .ratio(0.6),
                        angularInset: 1.5
                    )
                    .foregroundStyle(Color(hex: item.colorHex))
                    .cornerRadius(3)
                }
                .frame(height: 180)
                .accessibilityLabel("支出分类占比图")

                legend
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var legend: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(categoryBreakdown.prefix(6)) { item in
                HStack {
                    Circle().fill(Color(hex: item.colorHex)).frame(width: 10, height: 10)
                    Text(item.name).font(.subheadline)
                    Spacer()
                    Text(Money(minorUnits: item.amountMinorUnits, currencyCode: currencyCode).formatted)
                        .font(.subheadline.monospacedDigit())
                }
                .accessibilityElement(children: .combine)
            }
            if categoryBreakdown.count > 6 {
                Text("等 \(categoryBreakdown.count) 个分类").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var dailyPoints: [StatsService.DailyPoint] {
        StatsService.dailyTotals(
            in: period,
            transactions: ledgerTransactions,
            dayStartsOn: dayStartsOn,
            currencyCode: currencyCode
        )
    }

    private var trendCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("每日收支趋势").font(.headline)
            if dailyPoints.isEmpty {
                Text("本月暂无数据")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 20)
            } else {
                Chart {
                    ForEach(dailyPoints) { point in
                        LineMark(
                            x: .value("日期", point.day, unit: .day),
                            y: .value("收入", point.incomeMinorUnits)
                        )
                        .foregroundStyle(.green)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.catmullRom)

                        LineMark(
                            x: .value("日期", point.day, unit: .day),
                            y: .value("支出", point.expenseMinorUnits)
                        )
                        .foregroundStyle(.red)
                        .lineStyle(StrokeStyle(lineWidth: 2))
                        .interpolationMethod(.catmullRom)
                    }
                }
                .frame(height: 180)
                .chartYAxis {
                    AxisMarks(position: .trailing) { value in
                        AxisGridLine()
                        AxisTick()
                        AxisValueLabel {
                            if let intValue = value.as(Double.self) {
                                Text("\(Int(intValue))")
                            }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 6)) { value in
                        AxisValueLabel(format: .dateTime.month().day())
                    }
                }
                .accessibilityLabel("每日收入与支出趋势图")

                Text("本月共 \(dailyPoints.count) 天有记录")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
