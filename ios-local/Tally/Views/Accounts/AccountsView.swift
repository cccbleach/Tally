//
//  AccountsView.swift
//  Tally
//
//  Account list with live computed balances; create/edit/archive accounts.
//

import SwiftUI
import SwiftData

public struct AccountsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var ledgers: [Ledger]
    @Query(sort: \Account.sortOrder) private var allAccounts: [Account]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @State private var showingAdd = false
    @State private var editingAccount: Account?

    public init() {}

    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var accounts: [Account] {
        guard let ledger else { return [] }
        return allAccounts.filter { $0.ledger?.id == ledger.id && !$0.isArchived }
    }

    private var archived: [Account] {
        guard let ledger else { return [] }
        return allAccounts.filter { $0.ledger?.id == ledger.id && $0.isArchived }
    }

    private var transactions: [Transaction] {
        guard let ledger else { return [] }
        return allTransactions.filter { $0.ledger?.id == ledger.id && !$0.isDeleted }
    }

    private var currencyCode: String { ledger?.currencyCode ?? "CNY" }

    public var body: some View {
        NavigationStack {
            List {
                Section("账户") {
                    if accounts.isEmpty {
                        Text("还没有账户，点击右上角 + 添加")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(accounts) { account in
                            accountRow(account)
                                .contentShape(Rectangle())
                                .onTapGesture { editingAccount = account }
                        }
                    }
                }
                if !archived.isEmpty {
                    Section("已归档") {
                        ForEach(archived) { account in
                            accountRow(account)
                                .contentShape(Rectangle())
                                .onTapGesture { editingAccount = account }
                        }
                    }
                }
                Section {
                    HStack {
                        Text("净资产")
                        Spacer()
                        Text(netWorthText)
                            .font(.body.bold())
                            .foregroundStyle(.primary)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("账户")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建账户")
                }
            }
            .sheet(isPresented: $showingAdd) { AccountEditView(ledger: ledger, currencyCode: currencyCode) }
            .sheet(item: $editingAccount) { account in
                AccountEditView(account: account, ledger: ledger, currencyCode: currencyCode)
            }
        }
    }

    private var netWorth: Int64 {
        let totals = BalanceService.netWorth(accounts: allAccounts.filter { $0.ledger?.id == ledger?.id }, transactions: transactions)
        return totals[currencyCode] ?? 0
    }

    private var netWorthText: String {
        Money(minorUnits: netWorth, currencyCode: currencyCode).formatted
    }

    private func accountRow(_ account: Account) -> some View {
        let balance = BalanceService.balance(for: account, transactions: transactions)
        return HStack(spacing: 12) {
            Image(systemName: accountIcon(account.kind))
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name).font(.body.weight(.medium))
                Text(account.kind.displayName + (account.note.isEmpty ? "" : " · \(account.note)"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Money(minorUnits: balance, currencyCode: account.currencyCode).formatted)
                    .font(.body.bold().monospacedDigit())
                if account.initialBalanceMinorUnits != 0 {
                    Text("初始 \(Currencies.info(forCode: account.currencyCode).string(fromMinorUnits: account.initialBalanceMinorUnits))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(account.name)，\(account.kind.displayName)，余额 \(Money(minorUnits: balance, currencyCode: account.currencyCode).formatted)")
    }

    private func accountIcon(_ kind: AccountKind) -> String {
        switch kind {
        case .cash: return "banknote"
        case .debit: return "creditcard"
        case .credit: return "creditcard.fill"
        case .ewallet: return "wallet.pass.fill"
        case .savings: return "percent"
        case .other: return "tray"
        }
    }
}

public struct AccountEditView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let account: Account?
    let ledger: Ledger?
    let currencyCode: String

    @State private var name: String
    @State private var kind: AccountKind
    @State private var initialBalanceText: String
    @State private var note: String
    @State private var isArchived: Bool
    @State private var errorMessage: String?
    @State private var showingDeleteConfirmation = false

    @Query private var allTransactions: [Transaction]

    public init(account: Account? = nil, ledger: Ledger?, currencyCode: String) {
        self.account = account
        self.ledger = ledger
        self.currencyCode = currencyCode
        _name = State(initialValue: account?.name ?? "")
        _kind = State(initialValue: account?.kind ?? .cash)
        _initialBalanceText = State(initialValue: account.map { AmountParser.makeText(minorUnits: $0.initialBalanceMinorUnits, currencyCode: $0.currencyCode) } ?? "")
        _note = State(initialValue: account?.note ?? "")
        _isArchived = State(initialValue: account?.isArchived ?? false)
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("基本信息") {
                    TextField("账户名称", text: $name)
                    Picker("类型", selection: $kind) {
                        ForEach(AccountKind.allCases, id: \.self) { k in
                            Text(k.displayName).tag(k)
                        }
                    }
                }
                Section("初始余额") {
                    AmountField(text: $initialBalanceText, currencyCode: currencyCode, font: .system(size: 28, weight: .bold, design: .rounded))
                    Text("余额 = 初始余额 + 全部收支")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("备注（可选）", text: $note)
                    if account != nil {
                        Toggle("归档账户", isOn: $isArchived)
                    }
                }
                if let account, account.initialBalanceMinorUnits != 0 {
                    Section {
                        Text("修改初始余额会影响当前余额显示。")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
                if account != nil {
                    Section {
                        Button("删除账户", role: .destructive) {
                            showingDeleteConfirmation = true
                        }
                    } footer: {
                        Text("有历史交易的账户不能删除，只能归档，以免破坏余额和流水。")
                    }
                }
            }
            .navigationTitle(account == nil ? "新建账户" : "编辑账户")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
            .confirmationDialog("删除账户？", isPresented: $showingDeleteConfirmation, titleVisibility: .visible) {
                Button("删除账户", role: .destructive) { deleteAccount() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("仅未被任何交易使用的账户可以删除，此操作无法撤销。")
            }
        }
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        let initial = AmountParser.parse(initialBalanceText, currencyCode: currencyCode) ?? 0
        if let account {
            account.name = trimmed
            account.kind = kind
            account.initialBalanceMinorUnits = initial
            account.currencyCode = currencyCode
            account.note = note
            account.isArchived = isArchived
        } else {
            let a = Account(name: trimmed, kind: kind, currencyCode: currencyCode, initialBalanceMinorUnits: initial, note: note, sortOrder: (ledger?.accounts.count ?? 0))
            a.ledger = ledger
            context.insert(a)
        }
        do {
            try context.save()
            dismiss()
        } catch {
            context.rollback()
            errorMessage = "保存失败：\(error.localizedDescription)"
        }
    }

    private func deleteAccount() {
        guard let account else { return }
        guard AccountPolicy.canDelete(account, transactions: allTransactions) else {
            errorMessage = "该账户包含历史交易，请改为归档账户"
            return
        }
        do {
            context.delete(account)
            try context.save()
            dismiss()
        } catch {
            context.rollback()
            errorMessage = "删除失败：\(error.localizedDescription)"
        }
    }
}
