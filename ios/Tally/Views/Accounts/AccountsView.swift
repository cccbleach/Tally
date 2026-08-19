import SwiftUI

func accountTypeName(_ type: String) -> String {
    switch type {
    case "cash": return "现金"
    case "bank": return "银行卡"
    case "e-wallet": return "电子钱包"
    case "credit": return "信用卡"
    default: return "其他"
    }
}

func accountTypeIcon(_ type: String) -> String {
    switch type {
    case "cash": return "yensign.circle.fill"
    case "bank": return "building.columns.fill"
    case "e-wallet": return "wallet.pass.fill"
    case "credit": return "creditcard.fill"
    default: return "circle.fill"
    }
}

struct AccountsView: View {
    @Environment(DataStore.self) private var store
    @State private var showAdd = false
    @State private var showTransfer = false
    @State private var editing: Account?
    @State private var errorMessage: String?

    private var activeAccounts: [Account] { store.accounts.filter { !$0.isArchived } }

    // 负债账户（信用卡）单独核算：欠款不计入“资产”，避免与净资产混淆
    private var assetAccounts: [Account] {
        activeAccounts.filter { !($0.isLiability ?? false) || ($0.balance > 0) }
    }
    private var liabilityAccounts: [Account] {
        activeAccounts.filter { $0.isLiability == true && ($0.debt ?? 0) > 0 }
    }
    private var totalAssets: Int { assetAccounts.reduce(0) { $0 + $1.balance } }
    private var totalDebt: Int { liabilityAccounts.reduce(0) { $0 + ($1.debt ?? 0) } }
    private var netWorth: Int { totalAssets - totalDebt }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Text("总资产").foregroundColor(.secondary)
                        Spacer()
                        Text(Money.format(totalAssets)).font(.title3.bold()).monospacedDigit()
                    }
                    if totalDebt > 0 {
                        HStack {
                            Text("负债").foregroundColor(.secondary)
                            Spacer()
                            Text(Money.format(totalDebt)).font(.headline).foregroundColor(.red).monospacedDigit()
                        }
                        HStack {
                            Text("净资产").foregroundColor(.secondary)
                            Spacer()
                            Text(Money.format(netWorth)).font(.headline).monospacedDigit()
                        }
                    }
                }
                Section("账户") {
                    ForEach(activeAccounts) { account in
                        Button { editing = account } label: {
                            AccountRow(account: account)
                        }
                        .swipeActions {
                            Button("归档", role: .destructive) { Task { await archive(account) } }
                        }
                    }
                    if activeAccounts.isEmpty {
                        Text("暂无账户，点右上角「＋」新建")
                            .foregroundColor(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                }
            }
            .navigationTitle("账户")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showAdd = true } label: { Label("新建账户", systemImage: "plus") }
                        Button { showTransfer = true } label: { Label("转账", systemImage: "arrow.left.arrow.right") }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showAdd) { AccountFormView() }
            .sheet(item: $editing) { account in AccountFormView(existing: account) }
            .sheet(isPresented: $showTransfer) { AddTransactionView(initialType: "transfer") }
            .task { await store.refreshAccounts() }
            .refreshable { await store.refreshAccounts() }
            .errorAlert($errorMessage)
        }
    }

    private func archive(_ account: Account) async {
        do {
            try await APIService.shared.archiveAccount(id: account.id)
            await store.refreshAccounts()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct AccountRow: View {
    let account: Account

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(colorFor(hex: account.color).opacity(0.15))
                Image(systemName: accountTypeIcon(account.type))
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(colorFor(hex: account.color))
            }
            .frame(width: 34, height: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
                Text(accountTypeName(account.type)).font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            if account.isLiability == true, let debt = account.debt, debt > 0 {
                VStack(alignment: .trailing, spacing: 2) {
                    Text("欠款 " + Money.format(debt)).font(.headline).foregroundColor(.red).monospacedDigit()
                    Text(Money.format(account.balance)).font(.caption).foregroundColor(.secondary)
                }
            } else {
                Text(Money.format(account.balance)).font(.headline).monospacedDigit()
            }
        }
    }
}

struct AccountFormView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(DataStore.self) private var store
    let existing: Account?

    @State private var name = ""
    @State private var type = "other"
    @State private var initialBalance = ""
    @State private var errorMessage: String?

    private let types: [(String, String)] = [
        ("cash", "现金"), ("bank", "银行卡"), ("e-wallet", "电子钱包"), ("credit", "信用卡"), ("other", "其他")
    ]

    init(existing: Account? = nil) {
        self.existing = existing
        _name = State(initialValue: existing?.name ?? "")
        _type = State(initialValue: existing?.type ?? "other")
        _initialBalance = State(initialValue: existing == nil ? "" : String(format: "%.2f", Double(existing!.initialBalance) / 100.0))
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("账户名称", text: $name)
                Picker("类型", selection: $type) {
                    ForEach(types, id: \.0) { t in Text(t.1).tag(t.0) }
                }
                HStack {
                    Text("¥").font(.title2).foregroundColor(.secondary)
                    TextField("初始余额", text: $initialBalance).keyboardType(.decimalPad)
                }
            }
            .navigationTitle(existing == nil ? "新建账户" : "编辑账户")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { Task { await save() } }.disabled(name.isEmpty) }
            }
            .errorAlert($errorMessage)
        }
    }

    private func save() async {
        let cents = Money.cents(fromYuanString: initialBalance) ?? 0
        do {
            if let existing {
                _ = try await APIService.shared.updateAccount(id: existing.id, name: name, type: type, initialBalance: cents, icon: nil, color: nil)
            } else {
                _ = try await APIService.shared.createAccount(name: name, type: type, currency: "CNY", initialBalance: cents, icon: nil, color: nil)
            }
            await store.refreshAccounts()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
