import SwiftUI

struct BudgetsView: View {
    @Environment(DataStore.self) private var store
    @State private var showTotal = false
    @State private var showCategory = false

    var body: some View {
        NavigationStack {
            List {
                if let o = store.budgetOverview {
                    Section { totalHeader(o) }

                    Section("分类预算") {
                        ForEach(o.items) { item in
                            BudgetRow(item: item)
                        }
                        if o.items.isEmpty {
                            Text("暂无分类预算，点右上角「+」添加")
                                .foregroundColor(.secondary)
                        }
                    }
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .navigationTitle("预算")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { MonthSwitcher() }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showTotal = true } label: { Label("总预算", systemImage: "sum") }
                        Button { showCategory = true } label: { Label("分类预算", systemImage: "square.grid.2x2") }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showTotal) { BudgetFormView(mode: "total") }
            .sheet(isPresented: $showCategory) { BudgetFormView(mode: "category") }
        }
    }

    private func totalHeader(_ o: BudgetOverview) -> some View {
        VStack(spacing: 8) {
            Text("本月总预算").font(.caption).foregroundColor(.secondary)
            if o.totalBudget > 0 {
                Text(Money.format(o.totalSpent) + " / " + Money.format(o.totalBudget))
                    .font(.title2.bold())
                    .monospacedDigit()
                ProgressView(value: min(o.totalPercent, 100), total: 100)
                    .tint(o.totalPercent > 100 ? .red : .accentColor)
            } else {
                Text("未设置").font(.headline).foregroundColor(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
}

struct BudgetRow: View {
    let item: BudgetOverviewItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(item.categoryName)
                Spacer()
                Text(Money.format(item.spent) + " / " + Money.format(item.budget))
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .monospacedDigit()
            }
            ProgressView(value: min(item.percent, 100), total: 100)
                .tint(item.percent > 100 ? .red : .accentColor)
            if item.percent > 100 {
                Text("超支 " + Money.format(item.spent - item.budget))
                    .font(.caption)
                    .foregroundColor(.red)
            }
        }
        .padding(.vertical, 2)
    }
}

struct BudgetFormView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(DataStore.self) private var store
    let mode: String // "total" | "category"

    @State private var categoryId = ""
    @State private var amountString = ""
    @State private var errorMessage: String?

    private var expenseCategories: [Category] { store.categories.filter { $0.type == "expense" } }

    var body: some View {
        NavigationStack {
            Form {
                if mode == "category" {
                    Picker("分类", selection: $categoryId) {
                        ForEach(expenseCategories) { c in Text(c.name).tag(c.id) }
                    }
                } else {
                    LabeledContent("类型", value: "总预算")
                }
                HStack {
                    Text("¥").font(.title2).foregroundColor(.secondary)
                    TextField("0.00", text: $amountString)
                        .keyboardType(.decimalPad)
                        .font(.title2.bold())
                }
            }
            .navigationTitle(mode == "total" ? "设置总预算" : "设置分类预算")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(amountString.isEmpty || (mode == "category" && categoryId.isEmpty))
                }
            }
            .errorAlert($errorMessage)
        }
        .onAppear {
            if mode == "category", categoryId.isEmpty { categoryId = expenseCategories.first?.id ?? "" }
        }
    }

    private func save() async {
        guard let cents = Money.cents(fromYuanString: amountString) else { return }
        do {
            try await APIService.shared.upsertBudget(
                year: store.selectedYear,
                month: store.selectedMonth,
                categoryId: mode == "total" ? nil : categoryId,
                amount: cents
            )
            await store.refreshBudgetOverview()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
