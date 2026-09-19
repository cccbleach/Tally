import SwiftUI

/// 某一天的流水明细：月历视图点日期进入。
/// 数据从 DataStore 当月已加载的流水里按日期过滤（月历只能点到当月，数据必然在）。
struct DayDetailView: View {
    @Environment(DataStore.self) private var store
    let date: String

    private var items: [Transaction] {
        store.transactions
            .filter { $0.date == date }
            .sorted { $0.createdAt < $1.createdAt }
    }

    private var totals: MonthCalendar.DayTotals {
        var t = MonthCalendar.DayTotals(income: 0, expense: 0)
        for tx in items {
            if tx.type == "income" {
                t.income += tx.amount
            } else if tx.type == "expense" {
                t.expense += tx.amount
            }
        }
        return t
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 0) {
                    dayStat("收入", Money.format(totals.income), .green)
                    Divider().frame(height: 30)
                    dayStat("支出", Money.format(totals.expense), .red)
                    Divider().frame(height: 30)
                    dayStat(
                        "结余", Money.signed(totals.income - totals.expense),
                        totals.income >= totals.expense ? .green : .red)
                }
                .frame(maxWidth: .infinity)
            }

            Section {
                ForEach(items) { tx in
                    TransactionRow(transaction: tx)
                }
            }
        }
        .navigationTitle(TallyDate.display(date))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func dayStat(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(spacing: 2) {
            Text(label).font(.caption).foregroundColor(.secondary)
            Text(value).font(.subheadline.weight(.semibold)).foregroundColor(color).monospacedDigit()
        }
        .frame(maxWidth: .infinity)
    }
}
