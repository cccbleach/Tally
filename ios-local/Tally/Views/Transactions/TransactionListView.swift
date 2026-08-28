//
//  TransactionListView.swift
//  Tally
//
//  Searchable, filterable transaction list grouped by day with per-day totals.
//

import SwiftUI
import SwiftData

public struct TransactionListView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var ledgers: [Ledger]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query private var allAccounts: [Account]
    @Query private var allCategories: [Category]

    @State private var searchText = ""
    @State private var kindFilter: TransactionKind?
    @State private var categoryFilterID: UUID?
    @State private var accountFilterID: UUID?
    @State private var showingFilters = false
    @State private var usesDateFilter = false
    @State private var startDate = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @State private var endDate = Date()
    @State private var minimumAmountText = ""
    @State private var maximumAmountText = ""
    @State private var showingAdd = false
    @State private var selected: Transaction?
    @State private var errorMessage: String?

    public init() {}

    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var filtered: [Transaction] {
        guard let ledger else { return [] }
        var result = allTransactions.filter { $0.ledger?.id == ledger.id && !$0.isDeleted }
        if let kindFilter { result = result.filter { $0.kind == kindFilter } }
        if let categoryFilterID { result = result.filter { $0.category?.id == categoryFilterID } }
        if let accountFilterID {
            result = result.filter {
                $0.account?.id == accountFilterID || $0.fromAccount?.id == accountFilterID || $0.toAccount?.id == accountFilterID
            }
        }
        if usesDateFilter {
            let calendar = Calendar.current
            let start = calendar.startOfDay(for: startDate)
            let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: endDate)) ?? endDate
            result = result.filter { $0.date >= start && $0.date < end }
        }
        let currencyCode = ledger.currencyCode
        if let minimum = AmountParser.parse(minimumAmountText, currencyCode: currencyCode) {
            result = result.filter { $0.amountMinorUnits >= minimum }
        }
        if let maximum = AmountParser.parse(maximumAmountText, currencyCode: currencyCode) {
            result = result.filter { $0.amountMinorUnits <= maximum }
        }
        if !searchText.isEmpty {
            let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
            result = result.filter {
                $0.payee.lowercased().contains(query) ||
                $0.note.lowercased().contains(query) ||
                ($0.category?.name.lowercased().contains(query) ?? false) ||
                ($0.account?.name.lowercased().contains(query) ?? false) ||
                ($0.fromAccount?.name.lowercased().contains(query) ?? false) ||
                ($0.toAccount?.name.lowercased().contains(query) ?? false)
            }
        }
        return result.sorted { $0.date > $1.date }
    }

    private var groupedByDay: [(day: Date, transactions: [Transaction])] {
        let calendar = Calendar.current
        var groups: [Date: [Transaction]] = [:]
        for t in filtered {
            let day = calendar.startOfDay(for: t.date)
            groups[day, default: []].append(t)
        }
        return groups
            .map { (day: $0.key, transactions: $0.value.sorted { $0.date > $1.date }) }
            .sorted { $0.day > $1.day }
    }

    public var body: some View {
        NavigationStack {
            List {
                if filtered.isEmpty {
                    Section {
                        EmptyStateView(
                            icon: "magnifyingglass",
                            title: searchText.isEmpty ? "暂无交易" : "没有匹配的交易",
                            message: searchText.isEmpty ? "点击右上角 + 记一笔" : "试试更换关键词或清除筛选"
                        )
                        .listRowBackground(Color.clear)
                    }
                } else {
                    ForEach(groupedByDay, id: \.day) { group in
                        Section {
                            ForEach(group.transactions) { t in
                                Button {
                                    selected = t
                                } label: {
                                    TransactionRow(transaction: t)
                                }
                                .buttonStyle(.plain)
                            }
                            .onDelete { offsets in
                                delete(offsets, in: group.transactions)
                            }
                        } header: {
                            dayHeader(group)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("明细")
            .searchable(text: $searchText, prompt: "搜索商家、备注、分类、账户")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        showingFilters = true
                    } label: {
                        Image(systemName: hasActiveFilters ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityLabel("筛选")
                    .accessibilityIdentifier("transactionFilterButton")
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("记一笔")
                }
            }
            .sheet(isPresented: $showingAdd) { AddTransactionView() }
            .sheet(isPresented: $showingFilters) {
                TransactionFilterView(
                    kind: $kindFilter,
                    categoryID: $categoryFilterID,
                    accountID: $accountFilterID,
                    usesDateFilter: $usesDateFilter,
                    startDate: $startDate,
                    endDate: $endDate,
                    minimumAmountText: $minimumAmountText,
                    maximumAmountText: $maximumAmountText,
                    accounts: ledgerAccounts,
                    categories: ledgerCategories,
                    currencyCode: ledger?.currencyCode ?? "CNY"
                )
            }
            .sheet(item: $selected) { t in
                TransactionDetailView(transaction: t)
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

    private var ledgerAccounts: [Account] {
        guard let ledger else { return [] }
        return allAccounts.filter { $0.ledger?.id == ledger.id }
    }

    private var ledgerCategories: [Category] {
        guard let ledger else { return [] }
        return allCategories.filter { $0.ledger?.id == ledger.id }
    }

    private var hasActiveFilters: Bool {
        kindFilter != nil || categoryFilterID != nil || accountFilterID != nil
            || usesDateFilter || !minimumAmountText.isEmpty || !maximumAmountText.isEmpty
    }

    private func dayHeader(_ group: (day: Date, transactions: [Transaction])) -> some View {
        let dayTotal = group.transactions.reduce(into: (income: Int64(0), expense: Int64(0))) { acc, t in
            switch t.kind {
            case .income: acc.income += t.amountMinorUnits
            case .expense: acc.expense += t.amountMinorUnits
            case .refund: acc.expense -= t.amountMinorUnits
            case .transfer: break
            }
        }
        let currency = ledger?.currencyCode ?? "CNY"
        return HStack {
            Text(DayHeaderFormatter.string(from: group.day))
            Spacer()
            if dayTotal.income != 0 {
                Text("收 \(Money(minorUnits: dayTotal.income, currencyCode: currency).formatted)")
                    .foregroundStyle(.green)
            }
            if dayTotal.expense != 0 {
                Text("支 \(Money(minorUnits: dayTotal.expense, currencyCode: currency).formatted)")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }

    private func delete(_ offsets: IndexSet, in group: [Transaction]) {
        for index in offsets {
            let t = group[index]
            t.isDeleted = true
            t.deletedAt = Date()
        }
        do {
            try context.save()
        } catch {
            context.rollback()
            errorMessage = "删除交易失败：\(error.localizedDescription)"
        }
    }
}

public struct TransactionFilterView: View {
    @Environment(\.dismiss) private var dismiss

    @Binding var kind: TransactionKind?
    @Binding var categoryID: UUID?
    @Binding var accountID: UUID?
    @Binding var usesDateFilter: Bool
    @Binding var startDate: Date
    @Binding var endDate: Date
    @Binding var minimumAmountText: String
    @Binding var maximumAmountText: String

    let accounts: [Account]
    let categories: [Category]
    let currencyCode: String
    @State private var errorMessage: String?

    public var body: some View {
        NavigationStack {
            Form {
                Section("类型") {
                    Picker("交易类型", selection: $kind) {
                        Text("全部").tag(TransactionKind?.none)
                        ForEach(TransactionKind.allCases, id: \.self) { value in
                            Text(value.displayName).tag(Optional(value))
                        }
                    }
                }
                Section("账户与分类") {
                    Picker("账户", selection: $accountID) {
                        Text("全部").tag(UUID?.none)
                        ForEach(accounts) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Picker("分类", selection: $categoryID) {
                        Text("全部").tag(UUID?.none)
                        ForEach(categories) { Text("\($0.kind.displayName) · \($0.name)").tag(Optional($0.id)) }
                    }
                }
                Section("日期") {
                    Toggle("限定日期范围", isOn: $usesDateFilter)
                    if usesDateFilter {
                        DatePicker("开始", selection: $startDate, displayedComponents: .date)
                        DatePicker("结束", selection: $endDate, displayedComponents: .date)
                    }
                }
                Section("金额") {
                    TextField("最低金额（可选）", text: $minimumAmountText)
                        .keyboardType(.decimalPad)
                    TextField("最高金额（可选）", text: $maximumAmountText)
                        .keyboardType(.decimalPad)
                    Text("币种：\(currencyCode)").font(.caption).foregroundStyle(.secondary)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("筛选交易")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("重置") { reset() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { validateAndDismiss() }
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private func validateAndDismiss() {
        if usesDateFilter && Calendar.current.startOfDay(for: startDate) > Calendar.current.startOfDay(for: endDate) {
            errorMessage = "开始日期不能晚于结束日期"
            return
        }
        let minimum = minimumAmountText.isEmpty ? nil : AmountParser.parse(minimumAmountText, currencyCode: currencyCode)
        let maximum = maximumAmountText.isEmpty ? nil : AmountParser.parse(maximumAmountText, currencyCode: currencyCode)
        if (!minimumAmountText.isEmpty && minimum == nil) || (!maximumAmountText.isEmpty && maximum == nil) {
            errorMessage = "请输入有效的金额范围"
            return
        }
        if let minimum, minimum < 0 {
            errorMessage = "最低金额不能为负数"
            return
        }
        if let maximum, maximum < 0 {
            errorMessage = "最高金额不能为负数"
            return
        }
        if let minimum, let maximum, minimum > maximum {
            errorMessage = "最低金额不能大于最高金额"
            return
        }
        dismiss()
    }

    private func reset() {
        kind = nil
        categoryID = nil
        accountID = nil
        usesDateFilter = false
        minimumAmountText = ""
        maximumAmountText = ""
        errorMessage = nil
    }
}

public enum DayHeaderFormatter {
    public static let shared: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "M月d日 EEEE"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    public static func string(from date: Date) -> String {
        shared.string(from: date)
    }
}
