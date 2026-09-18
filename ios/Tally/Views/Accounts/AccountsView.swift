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
    // 优先用服务端折算后的口径（StatsSummary.totalAssets/totalDebt 已按本位币换算）；
    // 账户余额是各自币种的原生值，本地直接相加在多币种账本下会算错。
    // summary 尚未加载时退回本地求和（与历史行为一致，单币种账本下结果相同）。
    private var totalAssets: Int {
        store.summary?.totalAssets ?? assetAccounts.reduce(0) { $0 + $1.balance }
    }
    private var totalDebt: Int {
        store.summary?.totalDebt ?? liabilityAccounts.reduce(0) { $0 + ($1.debt ?? 0) }
    }
    private var netWorth: Int { totalAssets - totalDebt }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Text("总资产").foregroundColor(.secondary)
                        Spacer()
                        Text(Money.format(totalAssets, currency: store.baseCurrencyCode)).font(.title3.bold()).monospacedDigit()
                    }
                    if totalDebt > 0 {
                        HStack {
                            Text("负债").foregroundColor(.secondary)
                            Spacer()
                            Text(Money.format(totalDebt, currency: store.baseCurrencyCode)).font(.headline).foregroundColor(.red).monospacedDigit()
                        }
                        HStack {
                            Text("净资产").foregroundColor(.secondary)
                            Spacer()
                            Text(Money.format(netWorth, currency: store.baseCurrencyCode)).font(.headline).monospacedDigit()
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
            if account.isLiability == true, let debt = account.debt, debt > 0 {
                VStack(alignment: .trailing, spacing: 2) {
                    // debt 字段由服务端折算到本位币；balance 是账户原生币种余额
                    Text("欠款 " + Money.format(debt, currency: store.baseCurrencyCode)).font(.headline).foregroundColor(.red).monospacedDigit()
                    Text(Money.format(account.balance, currency: account.currency)).font(.caption).foregroundColor(.secondary)
                }
            } else {
                Text(Money.format(account.balance, currency: account.currency)).font(.headline).monospacedDigit()
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
    @State private var currency = Money.defaultCurrencyCode
    @State private var initialBalance = ""
    @State private var errorMessage: String?

    private let types: [(String, String)] = [
        ("cash", "现金"), ("bank", "银行卡"), ("e-wallet", "电子钱包"), ("credit", "信用卡"), ("other", "其他")
    ]

    init(existing: Account? = nil) {
        self.existing = existing
        _name = State(initialValue: existing?.name ?? "")
        _type = State(initialValue: existing?.type ?? "other")
        _currency = State(initialValue: existing?.currency ?? Money.defaultCurrencyCode)
        if let existing {
            _initialBalance = State(initialValue: Currencies.info(for: existing.currency).decimalString(existing.initialBalance))
        } else {
            _initialBalance = State(initialValue: "")
        }
    }

    private var currencyInfo: CurrencyInfo { Currencies.info(for: currency) }

    var body: some View {
        NavigationStack {
            Form {
                TextField("账户名称", text: $name)
                Picker("类型", selection: $type) {
                    ForEach(types, id: \.0) { t in Text(t.1).tag(t.0) }
                }
                if existing == nil {
                    // 新建可选币种（默认账本本位币）；编辑不换币种——已有流水的账户
                    // 换币种会让历史金额被新币种重新解释，服务端也会拒绝
                    Picker("币种", selection: $currency) {
                        ForEach(Currencies.common, id: \.code) { c in
                            Text("\(c.code) \(c.symbol)").tag(c.code)
                        }
                    }
                }
                HStack {
                    Text(currencyInfo.symbol).font(.title2).foregroundColor(.secondary)
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
        .onAppear {
            // 未显式选择时跟随账本本位币（而非写死 CNY）
            if existing == nil, currency == Money.defaultCurrencyCode {
                currency = store.baseCurrencyCode
            }
        }
    }

    private func save() async {
        // 解析失败必须报错：`?? 0` 会让「12.345」（CNY 只允许 2 位小数）静默变成 0 元账户，
        // 用户以为存了余额、实际记成 0，属于不可见的账实不符。
        let trimmedBalance = initialBalance.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let balance = Money.minorUnits(fromInput: trimmedBalance.isEmpty ? "0" : trimmedBalance, currency: currency) else {
            errorMessage = "\(Currencies.info(for: currency).code) 金额格式不正确：最多 \(Currencies.info(for: currency).minorUnits) 位小数，请检查后重试"
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
                _ = try await APIService.shared.createAccount(name: name, type: type, currency: currency, initialBalance: balance, icon: nil, color: nil)
            }
            await store.refreshAccounts()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
