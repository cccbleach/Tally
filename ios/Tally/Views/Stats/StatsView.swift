import SwiftUI
import Charts

struct StatsView: View {
    @Environment(DataStore.self) private var store

    var body: some View {
        NavigationStack {
            List {
                if let s = store.summary {
                    Section { summaryHeader(s) }

                    if !s.byCategory.isEmpty {
                        Section("分类占比") {
                            Chart(s.byCategory, id: \.name) { c in
                                SectorMark(
                                    angle: .value("金额", c.amount),
                                    innerRadius: .ratio(0.6),
                                    angularInset: 1.5
                                )
                                .foregroundStyle(colorFor(hex: c.color))
                                .cornerRadius(3)
                            }
                            .frame(height: 200)

                            ForEach(s.byCategory, id: \.name) { c in
                                HStack(spacing: 10) {
                                    CategoryBadge(icon: c.icon, color: c.color)
                                    Text(c.name)
                                    Spacer()
                                    Text(Money.format(c.amount)).monospacedDigit()
                                    Text(String(format: "%.1f%%", c.percent))
                                        .foregroundColor(.secondary)
                                        .frame(width: 56, alignment: .trailing)
                                        .monospacedDigit()
                                }
                            }
                        }
                    }

                    if !s.daily.isEmpty {
                        Section("每日收支") {
                            Chart(s.daily, id: \.date) { d in
                                BarMark(x: .value("日", dayString(d.date)), y: .value("支出", d.expense))
                                    .foregroundStyle(Color.red.opacity(0.65))
                                BarMark(x: .value("日", dayString(d.date)), y: .value("收入", d.income))
                                    .foregroundStyle(Color.green.opacity(0.65))
                            }
                            .frame(height: 180)
                        }
                    }
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }

                if !store.trend.isEmpty {
                    Section("近 6 个月趋势") {
                        Chart(store.trend, id: \.month) { p in
                            BarMark(x: .value("月", String(p.month) + "月"), y: .value("收入", p.income))
                                .foregroundStyle(Color.green.opacity(0.65))
                            BarMark(x: .value("月", String(p.month) + "月"), y: .value("支出", p.expense))
                                .foregroundStyle(Color.red.opacity(0.65))
                        }
                        .frame(height: 180)
                    }
                }
            }
            .navigationTitle("统计")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { MonthSwitcher() }
            }
        }
    }

    private func summaryHeader(_ s: StatsSummary) -> some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("支出").font(.caption).foregroundColor(.secondary)
                    Text(Money.format(s.expense)).font(.title2.bold()).foregroundColor(.red).monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("收入").font(.caption).foregroundColor(.secondary)
                    Text(Money.format(s.income)).font(.title2.bold()).foregroundColor(.green).monospacedDigit()
                }
            }
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("结余").font(.caption).foregroundColor(.secondary)
                    Text(Money.signed(s.net)).font(.headline).monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("总资产").font(.caption).foregroundColor(.secondary)
                    Text(Money.format(s.balance)).font(.headline).monospacedDigit()
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func dayString(_ date: String) -> String {
        let parts = date.split(separator: "-")
        if parts.count == 3, let d = Int(parts[2]) { return String(d) }
        return date
    }
}
