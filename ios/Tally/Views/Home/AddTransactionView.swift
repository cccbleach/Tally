import SwiftUI

struct AddTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(DataStore.self) private var store

    @State private var type = "expense"
    @State private var amountString = ""
    @State private var selectedCategoryId = ""
    @State private var date = Date()
    @State private var note = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(initialType: String = "expense") {
        _type = State(initialValue: initialType)
    }

    private var activeCategories: [Category] {
        store.categories.filter { $0.type == (type == "income" ? "income" : "expense") }
    }

    private var entryCurrencySymbol: String {
        Money.currency.symbol
    }

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
                        Text(entryCurrencySymbol).font(.title2).foregroundColor(.secondary)
                        TextField("0.00", text: $amountString)
                            .keyboardType(.decimalPad)
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section("分类") {
                    categoryGrid
                }

                Section {
                    DatePicker("日期", selection: $date, displayedComponents: .date)
                    TextField("备注（可选）", text: $note)
                }
            }
            .navigationTitle("记一笔")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(!canSave || isSaving)
                }
            }
            .errorAlert($errorMessage)
        }
        .onAppear { ensureSelections() }
        .onChange(of: type) { _, _ in
            selectedCategoryId = activeCategories.first?.id ?? ""
        }
    }

    private var categoryGrid: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(activeCategories) { cat in
                    CategoryChip(category: cat, isSelected: selectedCategoryId == cat.id) {
                        selectedCategoryId = cat.id
                    }
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func ensureSelections() {
        if selectedCategoryId.isEmpty { selectedCategoryId = activeCategories.first?.id ?? "" }
    }

    private var canSave: Bool {
        guard Money.minorUnits(fromInput: amountString) != nil else { return false }
        return !selectedCategoryId.isEmpty
    }

    private func save() async {
        guard let amount = Money.minorUnits(fromInput: amountString) else { return }
        isSaving = true
        defer { isSaving = false }
        let dateStr = TallyDate.dayFormatter.string(from: date)
        let clientRequestId = UUID().uuidString
        do {
            _ = try await APIService.shared.createTransaction(
                type: type,
                amount: amount,
                date: dateStr,
                note: note.isEmpty ? nil : note,
                categoryId: selectedCategoryId,
                clientRequestId: clientRequestId
            )
            await store.loadAll()
            dismiss()
        } catch {
            if PendingTransactionQueue.isRetryableTransportError(error) {
                // 断网：入本地队列（幂等键 = clientRequestId，联网重放不会重复入账）
                PendingTransactionQueue.enqueue(QueuedTransaction(
                    id: clientRequestId,
                    type: type,
                    amount: amount,
                    date: dateStr,
                    note: note.isEmpty ? nil : note,
                    categoryId: selectedCategoryId,
                    queuedAt: Date()
                ))
                store.pendingSyncCount = PendingTransactionQueue.count()
                await store.loadAll()
                dismiss()
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }
}

struct CategoryChip: View {
    let category: Category
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                Circle().fill(isSelected ? colorFor(hex: category.color) : colorFor(hex: category.color).opacity(0.15))
                Image(systemName: categoryIcon(category.icon))
                    .font(.system(size: 18))
                    .foregroundColor(isSelected ? .white : colorFor(hex: category.color))
            }
            .frame(width: 48, height: 48)
            Text(category.name)
                .font(.caption)
                .foregroundColor(isSelected ? .primary : .secondary)
        }
        .onTapGesture(perform: action)
    }
}
