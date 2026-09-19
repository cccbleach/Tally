import SwiftUI

struct AddTransactionView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(DataStore.self) private var store

    @State private var type = "expense"
    @State private var amountString = ""
    @State private var selectedAccountId = ""
    @State private var selectedCategoryId = ""
    @State private var transferToAccountId = ""
    @State private var date = Date()
    @State private var note = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(initialType: String = "expense") {
        _type = State(initialValue: initialType)
    }

    private var activeAccounts: [Account] { store.accounts.filter { !$0.isArchived } }
    private var activeCategories: [Category] {
        store.categories.filter { $0.type == (type == "income" ? "income" : "expense") }
    }

    private var selectedAccount: Account? {
        store.accounts.first(where: { $0.id == selectedAccountId })
    }
    private var entryCurrencySymbol: String {
        Money.currency.symbol
    }
    /// 转账的两个账户都可以选（全站人民币，不存在跨币种转账问题）
    private var transferCandidates: [Account] {
        activeAccounts.filter { $0.id != selectedAccountId }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("类型", selection: $type) {
                        Text("支出").tag("expense")
                        Text("收入").tag("income")
                        Text("转账").tag("transfer")
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

                Section("账户") {
                    Picker("账户", selection: $selectedAccountId) {
                        ForEach(activeAccounts) { a in
                            Text(a.name + "（" + Money.format(a.balance) + "）").tag(a.id)
                        }
                    }
                }

                if type == "transfer" {
                    Section("转入账户") {
                        Picker("转入账户", selection: $transferToAccountId) {
                            ForEach(transferCandidates) { a in
                                Text(a.name).tag(a.id)
                            }
                        }
                    }
                } else {
                    Section("分类") {
                        categoryGrid
                    }
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
        .onChange(of: selectedAccountId) { _, _ in
            // 换账户后币种随之变化：转账目标必须重选为同币种账户
            if type == "transfer", transferToAccountId == selectedAccountId
                || !transferCandidates.contains(where: { $0.id == transferToAccountId }) {
                transferToAccountId = transferCandidates.first?.id ?? ""
            }
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
        if selectedAccountId.isEmpty { selectedAccountId = activeAccounts.first?.id ?? "" }
        if type != "transfer", selectedCategoryId.isEmpty { selectedCategoryId = activeCategories.first?.id ?? "" }
        if type == "transfer", transferToAccountId.isEmpty {
            transferToAccountId = transferCandidates.first?.id ?? ""
        }
    }

    private var canSave: Bool {
        guard Money.minorUnits(fromInput: amountString) != nil else { return false }
        if type == "transfer" { return !selectedAccountId.isEmpty && !transferToAccountId.isEmpty }
        return !selectedAccountId.isEmpty && !selectedCategoryId.isEmpty
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
                accountId: selectedAccountId,
                categoryId: type == "transfer" ? nil : selectedCategoryId,
                transferToAccountId: type == "transfer" ? transferToAccountId : nil,
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
                    accountId: selectedAccountId,
                    categoryId: type == "transfer" ? nil : selectedCategoryId,
                    transferToAccountId: type == "transfer" ? transferToAccountId : nil,
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
