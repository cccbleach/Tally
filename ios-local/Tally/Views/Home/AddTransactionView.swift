//
//  AddTransactionView.swift
//  Tally
//
//  Quick-edit form for a single transaction. Used for both creating and
//  editing (via TransactionDetailView).
//

import SwiftUI
import SwiftData

public struct AddTransactionView: View {
    public enum Mode {
        case create
        case edit(Transaction)
    }

    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    @Query private var ledgers: [Ledger]
    @Query(sort: \Account.sortOrder) private var allAccounts: [Account]
    @Query(sort: \Category.sortOrder) private var allCategories: [Category]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    private let mode: Mode

    @State private var kind: TransactionKind = .expense
    @State private var amountText: String = ""
    @State private var selectedAccountID: UUID?
    @State private var fromAccountID: UUID?
    @State private var toAccountID: UUID?
    @State private var selectedCategoryID: UUID?
    @State private var refundOfID: UUID?
    @State private var date: Date = Date()
    @State private var payee: String = ""
    @State private var note: String = ""
    @State private var errorMessage: String?

    public init(mode: Mode = .create) {
        self.mode = mode
    }

    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var currencyCode: String {
        ledger?.currencyCode ?? "CNY"
    }

    private var accounts: [Account] {
        guard let ledger else { return [] }
        return allAccounts.filter { $0.ledger?.id == ledger.id && !$0.isArchived }
    }

    private var categories: [Category] {
        guard let ledger else { return [] }
        let kind = kind == .income ? CategoryKind.income : CategoryKind.expense
        return allCategories.filter { $0.ledger?.id == ledger.id && $0.kind == kind && $0.isEnabled }
    }

    private var editableAccounts: [Account] {
        accounts.filter { $0.id != selectedAccountID }
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("类型", selection: $kind) {
                        ForEach(TransactionKind.allCases, id: \.self) { k in
                            Text(k.displayName).tag(k)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: kind) { _, newValue in
                        // A transfer lets the user pick two accounts instead of
                        // one account + category.
                        if newValue == .transfer {
                            if fromAccountID == nil { fromAccountID = accounts.first?.id }
                            if toAccountID == nil { toAccountID = accounts.dropFirst().first?.id }
                        } else {
                            if selectedAccountID == nil { selectedAccountID = accounts.first?.id }
                        }
                        selectedCategoryID = categories.first?.id
                        if newValue != .refund { refundOfID = nil }
                    }
                }

                Section {
                    AmountField(text: $amountText, currencyCode: currencyCode)
                        .accessibilityIdentifier("transactionAmountField")
                        .onAppear {
                            if case .edit(let t) = mode {
                                amountText = AmountParser.makeText(minorUnits: t.amountMinorUnits, currencyCode: t.currencyCode)
                            }
                        }
                } header: {
                    Text("金额")
                }

                if kind == .transfer {
                    Section("账户") {
                        Picker("转出账户", selection: $fromAccountID) {
                            ForEach(accounts) { Text($0.name).tag(Optional($0.id)) }
                        }
                        Picker("转入账户", selection: $toAccountID) {
                            ForEach(accounts) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                } else {
                    Section("账户") {
                        Picker("账户", selection: $selectedAccountID) {
                            ForEach(accounts) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                    Section("分类") {
                        if categories.isEmpty {
                            Text("请先在分类管理中创建分类")
                                .foregroundStyle(.secondary)
                        } else {
                            Picker("分类", selection: $selectedCategoryID) {
                                ForEach(categories) { category in
                                    Label(category.name, systemImage: category.icon)
                                        .tag(Optional(category.id))
                                }
                            }
                            .pickerStyle(.navigationLink)
                        }
                    }
                    if kind == .refund {
                        Section("关联原交易") {
                            Picker("原交易（可选）", selection: $refundOfID) {
                                Text("不指定").tag(UUID?.none)
                                ForEach(candidatesForRefund) { t in
                                    Text("\(TransactionDateFormatter.string(from: t.date)) · \(t.money.formatted)")
                                        .tag(Optional(t.id))
                                }
                            }
                        }
                    }
                }

                Section("信息") {
                    DatePicker("日期", selection: $date, displayedComponents: [.date, .hourAndMinute])
                    TextField("商家 / 来源（可选）", text: $payee)
                    TextField("备注（可选）", text: $note)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("saveTransactionButton")
                }
            }
            .onAppear(perform: loadInitialState)
        }
    }

    private var title: String {
        if case .edit = mode { return "编辑交易" }
        return "记一笔"
    }

    private var candidatesForRefund: [Transaction] {
        guard let ledger else { return [] }
        return allTransactions.filter { $0.ledger?.id == ledger.id && !$0.isDeleted && $0.kind == .expense }
    }

    private func loadInitialState() {
        if case .edit(let t) = mode {
            kind = t.kind
            amountText = AmountParser.makeText(minorUnits: t.amountMinorUnits, currencyCode: t.currencyCode)
            date = t.date
            payee = t.payee
            note = t.note
            selectedAccountID = t.account?.id
            fromAccountID = t.fromAccount?.id
            toAccountID = t.toAccount?.id
            selectedCategoryID = t.category?.id
            refundOfID = t.refundOf?.id
        } else {
            selectedAccountID = accounts.first?.id
            selectedCategoryID = categories.first?.id
            fromAccountID = accounts.first?.id
            toAccountID = accounts.dropFirst().first?.id
        }
    }

    private func save() {
        guard let ledger else {
            errorMessage = "尚未创建账本"
            return
        }
        guard let minor = AmountParser.parse(amountText, currencyCode: currencyCode), minor > 0 else {
            errorMessage = "请输入有效的金额"
            return
        }

        switch kind {
        case .transfer:
            guard let from = fromAccountID, let to = toAccountID, from != to else {
                errorMessage = "转账需要两个不同的账户"
                return
            }
            guard let fromAccount = accounts.first(where: { $0.id == from }),
                  let toAccount = accounts.first(where: { $0.id == to }) else {
                errorMessage = "所选账户已不可用"
                return
            }
            if case .edit(let t) = mode {
                t.kind = .transfer
                update(t, minor: minor)
                t.fromAccount = fromAccount
                t.toAccount = toAccount
                t.account = nil
                t.category = nil
                t.refundOf = nil
                t.updatedAt = Date()
            } else {
                let t = Transaction(kind: .transfer,
                                    amountMinorUnits: minor,
                                    currencyCode: currencyCode,
                                    date: date,
                                    fromAccount: fromAccount,
                                    toAccount: toAccount,
                                    note: note, payee: payee)
                t.ledger = ledger
                context.insert(t)
            }
        case .expense, .income, .refund:
            guard let accountID = selectedAccountID else {
                errorMessage = "请选择账户"
                return
            }
            guard let categoryID = selectedCategoryID else {
                errorMessage = "请选择分类"
                return
            }
            guard kind != .refund || refundOfID == nil || candidatesForRefund.contains(where: { $0.id == refundOfID }) else {
                errorMessage = "指定的原交易不存在"
                return
            }
            guard let selectedAccount = accounts.first(where: { $0.id == accountID }),
                  let selectedCategory = categories.first(where: { $0.id == categoryID }) else {
                errorMessage = "所选账户或分类已不可用"
                return
            }
            if case .edit(let t) = mode {
                t.kind = kind
                update(t, minor: minor)
                t.account = selectedAccount
                t.category = selectedCategory
                t.fromAccount = nil
                t.toAccount = nil
                t.refundOf = kind == .refund ? refundOrigin : nil
                t.updatedAt = Date()
            } else {
                let t = Transaction(kind: kind,
                                    amountMinorUnits: minor,
                                    currencyCode: currencyCode,
                                    date: date,
                                    account: selectedAccount,
                                    category: selectedCategory,
                                    refundOf: kind == .refund ? refundOrigin : nil,
                                    note: note, payee: payee)
                t.ledger = ledger
                context.insert(t)
            }
        }

        do {
            try context.save()
            dismiss()
        } catch {
            context.rollback()
            errorMessage = "保存失败：\(error.localizedDescription)"
        }
    }

    private var refundOrigin: Transaction? {
        guard let id = refundOfID else { return nil }
        return allTransactions.first { $0.id == id }
    }

    private func update(_ t: Transaction, minor: Int64) {
        t.amountMinorUnits = minor
        t.currencyCode = currencyCode
        t.date = date
        t.payee = payee
        t.note = note
    }
}
