import SwiftUI

func accountTypeName(_ type: String) -> String {
    switch type {
    case "cash": return "现金"
    case "bank": return "银行卡"
    case "e-wallet": return "电子钱包"
    default: return "其他"
    }
}

func accountTypeIcon(_ type: String) -> String {
    switch type {
    case "cash": return "yensign.circle.fill"
    case "bank": return "building.columns.fill"
    case "e-wallet": return "wallet.pass.fill"
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

    // 总资产：全站人民币，本地求和与服务端 totalAssets 口径一致；
    // 仍优先用服务端汇总值（含未归档账户过滤等口径），未加载时本地兜底。
    private var totalAssets: Int {
        store.summary?.totalAssets ?? activeAccounts.reduce(0) { $0 + $1.balance }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Text("总资产").foregroundColor(.secondary)
                        Spacer()
                        Text(Money.format(totalAssets)).font(.title3.bold()).monospacedDigit()
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
    @Environment(DataStore.self) private var store
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
            Text(Money.format(account.balance)).font(.headline).monospacedDigit()
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
        ("cash", "现金"), ("bank", "银行卡"), ("e-wallet", "电子钱包"), ("other", "其他")
    ]

    init(existing: Account? = nil) {
        self.existing = existing
        _name = State(initialValue: existing?.name ?? "")
        _type = State(initialValue: existing?.type ?? "other")
        _initialBalance = State(initialValue: existing.map { Money.currency.decimalString($0.initialBalance) } ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("账户名称", text: $name)
                Picker("类型", selection: $type) {
                    ForEach(types, id: \.0) { t in Text(t.1).tag(t.0) }
                }
                HStack {
                    Text(Money.currency.symbol).font(.title2).foregroundColor(.secondary)
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
        // 解析失败必须报错：`?? 0` 会让「12.345」（人民币只允许 2 位小数）静默变成 0 元账户，
        // 用户以为存了余额、实际记成 0，属于不可见的账实不符。
        let trimmedBalance = initialBalance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let balance = Money.minorUnits(fromInput: trimmedBalance.isEmpty ? "0" : trimmedBalance) else {
            errorMessage = "\(Money.currency.code) 金额格式不正确：最多 \(Money.currency.minorUnits) 位小数，请检查后重试"
            return
        }
        do {
            if let existing {
                // 乐观锁：带上编辑时的版本号，另一端已改过则 409 提示刷新
                _ = try await APIService.shared.updateAccount(
                    id: existing.id, name: name, type: type, initialBalance: balance,
                    icon: nil, color: nil, expectedUpdatedAt: existing.updatedAt
                )
            } else {
                _ = try await APIService.shared.createAccount(name: name, type: type, initialBalance: balance, icon: nil, color: nil)
            }
            await store.refreshAccounts()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
