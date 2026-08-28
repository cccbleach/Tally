//
//  LedgersView.swift
//  Tally
//
//  Create / edit / delete ledgers and choose the default one.
//

import SwiftUI
import SwiftData

public struct LedgersView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var ledgers: [Ledger]
    @Query private var settingsList: [AppSettings]

    @State private var showingAdd = false
    @State private var editingLedger: Ledger?
    @State private var deletingLedger: Ledger?
    @State private var errorMessage: String?

    public init() {}

    public var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(ledgers) { ledger in
                        HStack(spacing: 12) {
                            Image(systemName: ledger.icon)
                                .font(.title3)
                                .foregroundStyle(Color(hex: ledger.colorHex))
                                .frame(width: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ledger.name).font(.body.weight(.medium))
                                Text(ledger.isDefault ? "默认账本 · \(ledger.currencyCode)" : ledger.currencyCode)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if ledger.id == appState.selectedLedgerID {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        .contentShape(Rectangle())
                        .onTapGesture {
                            appState.selectedLedgerID = ledger.id
                        }
                        .contextMenu {
                            Button("设为默认") {
                                setDefault(ledger)
                            }
                            Button("编辑") { editingLedger = ledger }
                            if !ledger.isDefault {
                                Button("删除", role: .destructive) { deletingLedger = ledger }
                            }
                        }
                    }
                } footer: {
                    Text("点按账本切换当前账本。默认账本不可删除。")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("账本管理")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建账本")
                }
            }
            .sheet(isPresented: $showingAdd) { LedgerEditView() }
            .sheet(item: $editingLedger) { LedgerEditView(ledger: $0) }
            .confirmationDialog("删除账本？", isPresented: Binding(get: { deletingLedger != nil }, set: { if !$0 { deletingLedger = nil } }), titleVisibility: .visible) {
                Button("删除账本及其全部数据", role: .destructive) {
                    if let ledger = deletingLedger {
                        delete(ledger)
                    }
                    deletingLedger = nil
                }
                Button("取消", role: .cancel) { deletingLedger = nil }
            } message: {
                Text("该操作会删除账本、账户、分类、交易和预算，且无法撤销。")
            }
            .alert("操作失败", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("好") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "未知错误")
            }
        }
    }

    private func setDefault(_ ledger: Ledger) {
        let previousSelectedLedgerID = appState.selectedLedgerID
        for l in ledgers { l.isDefault = (l.id == ledger.id) }
        settingsList.first?.defaultLedgerID = ledger.id
        appState.selectedLedgerID = ledger.id
        do {
            try context.save()
        } catch {
            context.rollback()
            appState.selectedLedgerID = previousSelectedLedgerID
            errorMessage = "设置默认账本失败：\(error.localizedDescription)"
        }
    }

    private func delete(_ ledger: Ledger) {
        let previousSelectedLedgerID = appState.selectedLedgerID
        if settingsList.first?.defaultLedgerID == ledger.id {
            settingsList.first?.defaultLedgerID = nil
        }
        if appState.selectedLedgerID == ledger.id {
            appState.selectedLedgerID = nil
        }
        context.delete(ledger)
        do {
            try context.save()
        } catch {
            context.rollback()
            appState.selectedLedgerID = previousSelectedLedgerID
            errorMessage = "删除账本失败：\(error.localizedDescription)"
        }
    }
}

public struct LedgerEditView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var settingsList: [AppSettings]
    @Query private var allLedgers: [Ledger]

    let ledger: Ledger?
    @State private var name: String
    @State private var icon: String
    @State private var colorHex: String
    @State private var currencyCode: String
    @State private var errorMessage: String?
    @State private var didApplyDefaultCurrency = false

    private let icons = ["book", "briefcase.fill", "house.fill", "cart.fill", "graduationcap.fill", "heart.fill", "airplane", "creditcard.fill"]
    private let colors = ["0A84FF", "FF9F0A", "32D74B", "FF375F", "AF52DE", "FFD60A"]

    public init(ledger: Ledger? = nil) {
        self.ledger = ledger
        _name = State(initialValue: ledger?.name ?? "")
        _icon = State(initialValue: ledger?.icon ?? "book")
        _colorHex = State(initialValue: ledger?.colorHex ?? "0A84FF")
        _currencyCode = State(initialValue: ledger?.currencyCode ?? "CNY")
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("基本信息") {
                    TextField("账本名称", text: $name)
                    Picker("默认币种", selection: $currencyCode) {
                        ForEach(Currencies.all, id: \.code) { c in
                            Text("\(c.code) \(c.symbol)").tag(c.code)
                        }
                    }
                    .disabled(currencyIsLocked)
                    if currencyIsLocked {
                        Text("已有交易、预算或非零余额后不能直接更换账本币种。请新建账本后迁移数据。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Section("图标") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(icons, id: \.self) { choice in
                            Image(systemName: choice)
                                .font(.title3)
                                .frame(width: 40, height: 40)
                                .background(icon == choice ? Color.accentColor.opacity(0.2) : Color.clear)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .onTapGesture { icon = choice }
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section("颜色") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(colors, id: \.self) { choice in
                            Circle().fill(Color(hex: choice))
                                .frame(width: 32, height: 32)
                                .overlay(Circle().stroke(colorHex == choice ? Color.primary : Color.clear, lineWidth: 2))
                                .onTapGesture { colorHex = choice }
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle(ledger == nil ? "新建账本" : "编辑账本")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
            .onAppear {
                guard ledger == nil, !didApplyDefaultCurrency else { return }
                didApplyDefaultCurrency = true
                if let defaultCode = settingsList.first?.defaultCurrencyCode,
                   Currencies.supportedInfo(forCode: defaultCode) != nil {
                    currencyCode = defaultCode
                }
            }
        }
    }

    private var currencyIsLocked: Bool {
        guard let ledger else { return false }
        return !LedgerCurrencyPolicy.canChangeCurrency(of: ledger)
    }

    private func save() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        if let ledger {
            let oldCurrency = ledger.currencyCode
            if oldCurrency != currencyCode {
                do {
                    try LedgerCurrencyPolicy.changeCurrency(of: ledger, to: currencyCode)
                } catch {
                    errorMessage = error.localizedDescription
                    return
                }
            }
            ledger.name = trimmed
            ledger.icon = icon
            ledger.colorHex = colorHex
        } else {
            let newLedger = Ledger(name: trimmed, icon: icon, colorHex: colorHex, currencyCode: currencyCode, isDefault: allLedgers.isEmpty)
            context.insert(newLedger)
            // Seed fresh categories/accounts for the new ledger.
            for category in SeedData.makeDefaultCategories() {
                category.ledger = newLedger
                context.insert(category)
            }
            for account in SeedData.makeDefaultAccounts(currencyCode: currencyCode) {
                account.ledger = newLedger
                context.insert(account)
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
}
