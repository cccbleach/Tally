import SwiftUI

struct TransactionGroup: Identifiable {
    let date: String
    let items: [Transaction]
    var id: String { date }
}

struct HomeView: View {
    @Environment(DataStore.self) private var store
    @State private var showAdd = false

    private var grouped: [TransactionGroup] {
        let dict = Dictionary(grouping: store.transactions, by: { $0.date })
        return dict.keys.sorted(by: >).map { TransactionGroup(date: $0, items: dict[$0] ?? []) }
    }

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottomTrailing) {
                List {
                    Section { summaryHeader } header: { Text("") }

                    if store.isOffline {
                        Label("离线模式：正在显示缓存数据", systemImage: "wifi.slash")
                            .font(.footnote)
                            .foregroundColor(.orange)
                            .frame(maxWidth: .infinity)
                    }

                    ForEach(grouped) { group in
                        Section {
                            ForEach(group.items) { tx in
                                TransactionRow(transaction: tx)
                            }
                        } header: {
                            Text(TallyDate.display(group.date))
                        }
                    }

                    if grouped.isEmpty && !store.isLoading {
                        VStack(spacing: 8) {
                            Image(systemName: "tray").font(.largeTitle).foregroundColor(.secondary)
                            Text("本月还没有流水").foregroundColor(.secondary)
                            Text("点右下角「+」记一笔").font(.caption).foregroundColor(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                    }
                }

                Button { showAdd = true } label: {
                    Image(systemName: "plus")
                        .font(.title2.weight(.bold))
                        .foregroundColor(.white)
                        .frame(width: 56, height: 56)
                        .background(Circle().fill(Color.accentColor))
                        .shadow(radius: 4)
                }
                .padding(24)
            }
            .navigationTitle("明细")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { MonthSwitcher() }
            }
            .sheet(isPresented: $showAdd) { AddTransactionView() }
            .refreshable { await store.loadAll() }
            .errorAlert(Binding(get: { store.errorMessage }, set: { store.errorMessage = $0 }))
        }
    }

    private var summaryHeader: some View {
        VStack(spacing: 8) {
            if let s = store.summary {
                Text("本月结余").font(.caption).foregroundColor(.secondary)
                Text(Money.signed(s.net))
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .foregroundColor(s.net >= 0 ? .primary : .red)
                    .monospacedDigit()
                HStack(spacing: 32) {
                    VStack(spacing: 2) {
                        Text("收入").font(.caption).foregroundColor(.secondary)
                        Text(Money.format(s.income)).font(.subheadline.weight(.semibold)).foregroundColor(.green).monospacedDigit()
                    }
                    Divider().frame(height: 32)
                    VStack(spacing: 2) {
                        Text("支出").font(.caption).foregroundColor(.secondary)
                        Text(Money.format(s.expense)).font(.subheadline.weight(.semibold)).foregroundColor(.red).monospacedDigit()
                    }
                }
            } else {
                ProgressView().padding()
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}

struct TransactionRow: View {
    let transaction: Transaction

    var body: some View {
        HStack(spacing: 12) {
            if transaction.type == "transfer" {
                ZStack {
                    Circle().fill(Color.blue.opacity(0.15))
                    Image(systemName: "arrow.left.arrow.right")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundColor(.blue)
                }
                .frame(width: 34, height: 34)
            } else {
                CategoryBadge(icon: transaction.categoryIcon, color: transaction.categoryColor)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let note = transaction.note, !note.isEmpty {
                    Text(note).font(.caption).foregroundColor(.secondary)
                }
            }

            Spacer()

            AmountLabel(amount: transaction.amount, type: transaction.type)
        }
    }

    private var title: String {
        if transaction.type == "transfer" {
            return (transaction.accountName ?? "账户") + " → " + (transaction.transferToAccountName ?? "账户")
        }
        return transaction.categoryName ?? (transaction.accountName ?? "未分类")
    }
}
