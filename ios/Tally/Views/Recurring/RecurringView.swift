import SwiftUI

struct RecurringView: View {
    @Environment(DataStore.self) private var store
    @State private var showAdd = false

    var body: some View {
        List {
            ForEach(store.recurring) { bill in
                RecurringRow(bill: bill)
            }
            if store.recurring.isEmpty {
                Text("暂无周期账单，点右上角「+」添加")
                    .foregroundColor(.secondary)
            }
        }
        .navigationTitle("周期账单")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showAdd = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showAdd) { RecurringFormView() }
        .task { await store.refreshRecurring() }
    }
}

struct RecurringRow: View {
    @Environment(DataStore.self) private var store
    let bill: RecurringBill
    @State private var errorMessage: String?

    private var category: Category? {
        store.categories.first(where: { $0.id == bill.categoryId })
    }

    var body: some View {
        HStack(spacing: 12) {
            CategoryBadge(icon: category?.icon, color: category?.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(bill.categoryName ?? "未分类")
                Text(frequencyText).font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                AmountLabel(amount: bill.amount, type: bill.type)
                Toggle("", isOn: Binding(
                    get: { bill.isActive },
                    set: { _ in Task { await toggle() } }
                ))
                .labelsHidden()
                .scaleEffect(0.8)
            }
        }
        .swipeActions {
            Button("删除", role: .destructive) { Task { await delete() } }
        }
        .errorAlert($errorMessage)
    }

    private var frequencyText: String {
        let map = ["daily": "每天", "weekly": "每周", "monthly": "每月", "yearly": "每年"]
        let base = map[bill.frequency] ?? bill.frequency
        return bill.interval > 1 ? "每 \(bill.interval) 个周期（\(base)）" : base
    }

    private func toggle() async {
        do {
            _ = try await APIService.shared.updateRecurring(id: bill.id, body: UpdateRecurringBody(isActive: !bill.isActive))
            await store.refreshRecurring()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete() async {
        do {
            try await APIService.shared.deleteRecurring(id: bill.id)
            await store.refreshRecurring()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct RecurringFormView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(DataStore.self) private var store

    @State private var type = "expense"
    @State private var amountString = ""
    @State private var selectedCategoryId = ""
    @State private var frequency = "monthly"
    @State private var interval = 1
    @State private var startDate = Date()
    @State private var hasEndDate = false
    @State private var endDate = Date()
    @State private var note = ""
    @State private var errorMessage: String?

    private var activeCategories: [Category] { store.categories.filter { $0.type == type } }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("类型", selection: $type) {
                        Text("支出").tag("expense")
                        Text("收入").tag("income")
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    HStack {
                        Text(Money.currency.symbol).font(.title2).foregroundColor(.secondary)
                        TextField("0.00", text: $amountString)
                            .keyboardType(.decimalPad)
                            .font(.title2.bold())
                    }
                }
                Section {
                    Picker("分类", selection: $selectedCategoryId) {
                        ForEach(activeCategories) { c in Text(c.name).tag(c.id) }
                    }
                }
                Section("频率") {
                    Picker("频率", selection: $frequency) {
                        Text("每天").tag("daily")
                        Text("每周").tag("weekly")
                        Text("每月").tag("monthly")
                        Text("每年").tag("yearly")
                    }
                    Stepper("每 \(interval) 期", value: $interval, in: 1...365)
                }
                Section {
                    DatePicker("开始日期", selection: $startDate, displayedComponents: .date)
                    Toggle("设置结束日期", isOn: $hasEndDate)
                    if hasEndDate {
                        DatePicker("结束日期", selection: $endDate, displayedComponents: .date)
                    }
                    TextField("备注（可选）", text: $note)
                }
            }
            .navigationTitle("新建周期账单")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }.disabled(amountString.isEmpty)
                }
            }
            .errorAlert($errorMessage)
        }
        .onAppear {
            if selectedCategoryId.isEmpty { selectedCategoryId = activeCategories.first?.id ?? "" }
        }
        .onChange(of: type) { _, _ in
            selectedCategoryId = activeCategories.first?.id ?? ""
        }
    }

    private func save() async {
        // 解析失败要明确提示：静默 return 会表现为「保存按钮没反应」，用户不知道哪里错了
        guard let amount = Money.minorUnits(fromInput: amountString) else {
            errorMessage = "金额格式不正确：\(Money.currency.code) 最多 \(Money.currency.minorUnits) 位小数，且必须大于 0"
            return
        }
        let df = TallyDate.dayFormatter
        do {
            _ = try await APIService.shared.createRecurring(
                categoryId: selectedCategoryId,
                type: type,
                amount: amount,
                note: note.isEmpty ? nil : note,
                frequency: frequency,
                interval: interval,
                startDate: df.string(from: startDate),
                endDate: hasEndDate ? df.string(from: endDate) : nil
            )
            await store.refreshRecurring()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
