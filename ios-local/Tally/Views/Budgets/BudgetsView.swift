//
//  BudgetsView.swift
//  Tally
//
//  Monthly budget list (whole-ledger + per-category) with progress bars and a
//  clear over-budget indicator.
//

import SwiftUI
import SwiftData

public struct BudgetsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var ledgers: [Ledger]
    @Query private var settingsList: [AppSettings]
    @Query private var budgets: [Budget]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query private var allCategories: [Category]

    @State private var showingAdd = false
    @State private var editingBudget: Budget?
    @State private var errorMessage: String?

    public init() {}

    private var settings: AppSettings? { settingsList.first }
    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var ledgerBudgets: [Budget] {
        guard let ledger else { return [] }
        return budgets.filter { $0.ledger?.id == ledger.id }
    }

    private var ledgerTransactions: [Transaction] {
        guard let ledger else { return [] }
        return allTransactions.filter { $0.ledger?.id == ledger.id && !$0.isDeleted }
    }

    private var categories: [Category] {
        guard let ledger else { return [] }
        return allCategories.filter { $0.ledger?.id == ledger.id }
    }

    private var period: MonthPeriod {
        MonthPeriod.containing(Date(), dayStartsOn: settings?.monthStartsOn ?? 1)
    }

    private var currencyCode: String { ledger?.currencyCode ?? settings?.defaultCurrencyCode ?? "CNY" }

    private var progress: [BudgetProgress] {
        BudgetService.allProgress(budgets: ledgerBudgets, period: period, transactions: ledgerTransactions, categories: categories, dayStartsOn: settings?.monthStartsOn ?? 1)
    }

    public var body: some View {
        NavigationStack {
            List {
                if progress.isEmpty {
                    Section {
                        EmptyStateView(
                            icon: "target",
                            title: "还没有预算",
                            message: "为你的月度支出设定一个预算，避免超支"
                        )
                        .listRowBackground(Color.clear)
                    }
                } else {
                    Section {
                        ForEach(progress) { item in
                            BudgetRow(item: item, currencyCode: currencyCode)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    editingBudget = item.budget
                                }
                        }
                        .onDelete { offsets in
                            for index in offsets {
                                context.delete(progress[index].budget)
                            }
                            do {
                                try context.save()
                            } catch {
                                context.rollback()
                                errorMessage = "删除预算失败：\(error.localizedDescription)"
                            }
                        }
                    } header: {
                        Text(period.displayTitle)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("预算")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建预算")
                }
            }
            .sheet(isPresented: $showingAdd) { BudgetEditView(ledger: ledger, categories: categories, currencyCode: currencyCode) }
            .sheet(item: $editingBudget) { budget in
                BudgetEditView(budget: budget, ledger: ledger, categories: categories, currencyCode: currencyCode)
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
}

public struct BudgetRow: View {
    public let item: BudgetProgress
    public let currencyCode: String

    public var body: some View {
        let color: Color = item.ratio >= 1 ? .red : (item.ratio >= 0.8 ? .orange : .green)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.budget.categoryID == nil ? "总预算" : (item.categoryName ?? "已删除分类"))
                    .font(.body.weight(.medium))
                Spacer()
                Text("\(Money(minorUnits: item.spentMinorUnits, currencyCode: currencyCode).formatted) / \(Money(minorUnits: item.limitMinorUnits, currencyCode: currencyCode).formatted)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            ProgressBarView(ratio: item.ratio, color: color)
            HStack {
                if item.isOver {
                    Label("已超支 \(Money(minorUnits: item.spentMinorUnits - item.limitMinorUnits, currencyCode: currencyCode).formatted)", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                } else {
                    if item.ratio >= 0.8 {
                        Label("即将超支", systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    Text("剩余 \(Money(minorUnits: item.remainingMinorUnits, currencyCode: currencyCode).formatted)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(budgetAccessibilityLabel)
    }

    private var budgetAccessibilityLabel: String {
        let limit = Money(minorUnits: item.limitMinorUnits, currencyCode: currencyCode).formatted
        let spent = Money(minorUnits: item.spentMinorUnits, currencyCode: currencyCode).formatted
        if item.isOver {
            return "预算 \(limit)，已用 \(spent)，已超支"
        }
        return "预算 \(limit)，已用 \(spent)，剩余 \(Money(minorUnits: item.remainingMinorUnits, currencyCode: currencyCode).formatted)"
    }
}

public struct BudgetEditView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let budget: Budget?
    let ledger: Ledger?
    let categories: [Category]
    let currencyCode: String

    @State private var amountText = ""
    @State private var categoryID: UUID?
    @State private var isEnabled = true
    @State private var errorMessage: String?

    public init(budget: Budget? = nil, ledger: Ledger?, categories: [Category], currencyCode: String) {
        self.budget = budget
        self.ledger = ledger
        self.categories = categories
        self.currencyCode = currencyCode
        _categoryID = State(initialValue: budget?.categoryID)
        _isEnabled = State(initialValue: budget?.isEnabled ?? true)
        if let budget {
            _amountText = State(initialValue: AmountParser.makeText(minorUnits: budget.amountMinorUnits, currencyCode: budget.currencyCode))
        }
    }

    private var validCategories: [Category] {
        categories.filter { $0.kind == .expense && $0.isEnabled }
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("预算金额") {
                    AmountField(text: $amountText, currencyCode: currencyCode, font: .system(size: 28, weight: .bold, design: .rounded))
                }
                Section("范围") {
                    Picker("类型", selection: $categoryID) {
                        Text("总预算").tag(UUID?.none)
                        ForEach(validCategories) { cat in
                            Text(cat.name).tag(Optional(cat.id))
                        }
                    }
                }
                Section {
                    Toggle("启用", isOn: $isEnabled)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle(budget == nil ? "新建预算" : "编辑预算")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
        }
    }

    private func save() {
        guard let minor = AmountParser.parse(amountText, currencyCode: currencyCode), minor > 0 else {
            errorMessage = "请输入有效的预算金额"
            return
        }
        if let budget {
            budget.amountMinorUnits = minor
            budget.currencyCode = currencyCode
            budget.categoryID = categoryID
            budget.isEnabled = isEnabled
        } else {
            let b = Budget(amountMinorUnits: minor, currencyCode: currencyCode, categoryID: categoryID, isEnabled: isEnabled)
            b.ledger = ledger
            context.insert(b)
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
