import SwiftUI

/// 明细页的月历视图：按日展示收入/支出（红/绿区分），可筛选只看一类，
/// 点击有流水的日期进入当日明细（导航由宿主 HomeView 处理）。
/// 数据来自 StatsSummary.daily（后端按月聚合，离线缓存同样可用），无需额外请求。
struct MonthCalendarView: View {
    let year: Int
    let month: Int
    let daily: [DailyStat]
    @Binding var filter: MonthCalendar.Filter
    let onSelect: (String) -> Void

    private var totals: [String: MonthCalendar.DayTotals] { MonthCalendar.totalsByDay(daily) }
    private var rows: [[Int?]] { MonthCalendar.grid(year: year, month: month) }
    private var todayKey: String { TallyDate.todayString() }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    var body: some View {
        VStack(spacing: 12) {
            Picker("显示", selection: $filter) {
                ForEach(MonthCalendar.Filter.allCases) { f in
                    Text(f.label).tag(f)
                }
            }
            .pickerStyle(.segmented)

            HStack {
                ForEach(MonthCalendar.weekdayHeadings, id: \.self) { s in
                    Text(s)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }

            LazyVGrid(columns: columns, spacing: 6) {
                ForEach(rows.indices, id: \.self) { r in
                    ForEach(rows[r].indices, id: \.self) { c in
                        if let day = rows[r][c] {
                            let key = MonthCalendar.dateKey(year: year, month: month, day: day)
                            DayCell(
                                day: day,
                                isToday: key == todayKey,
                                totals: totals[key],
                                filter: filter,
                                onTap: { onSelect(key) }
                            )
                        } else {
                            Color.clear
                                .frame(maxWidth: .infinity, minHeight: 46)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// 日历里的单日格子：日号 + 收支金额行。没有流水的日子不可点。
private struct DayCell: View {
    let day: Int
    let isToday: Bool
    let totals: MonthCalendar.DayTotals?
    let filter: MonthCalendar.Filter
    let onTap: () -> Void

    private var hasData: Bool { !(totals?.isEmpty ?? true) }

    private var showExpense: Bool {
        guard let t = totals, t.expense > 0 else { return false }
        return filter == .all || filter == .expense
    }

    private var showIncome: Bool {
        guard let t = totals, t.income > 0 else { return false }
        return filter == .all || filter == .income
    }

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 3) {
                Text("\(day)")
                    .font(.caption2.weight(isToday ? .bold : .semibold))
                    .foregroundColor(isToday ? .white : .primary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(isToday ? Color.accentColor : Color.clear, in: Capsule())
                if showExpense {
                    amountText("-" + MonthCalendar.compactAmount(totals?.expense ?? 0), color: .red)
                }
                if showIncome {
                    amountText("+" + MonthCalendar.compactAmount(totals?.income ?? 0), color: .green)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(hasData ? Color.primary.opacity(0.05) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(!hasData)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint(hasData ? "查看当日明细" : "")
    }

    private func amountText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundColor(color)
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .frame(maxWidth: .infinity)
    }

    private var accessibilityText: String {
        var parts = ["\(day)日"]
        if let t = totals, !t.isEmpty {
            if t.income > 0 { parts.append("收入\(Money.format(t.income))") }
            if t.expense > 0 { parts.append("支出\(Money.format(t.expense))") }
        } else {
            parts.append("无流水")
        }
        return parts.joined(separator: " ")
    }
}
