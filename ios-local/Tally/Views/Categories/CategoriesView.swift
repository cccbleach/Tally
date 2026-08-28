//
//  CategoriesView.swift
//  Tally
//
//  Manage expense/income categories: add, edit, enable/disable, reorder.
//

import SwiftUI
import SwiftData

public struct CategoriesView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var ledgers: [Ledger]
    @Query(sort: \Category.sortOrder) private var allCategories: [Category]

    @State private var showingAdd = false
    @State private var editingCategory: Category?
    @State private var kindTab: CategoryKind = .expense
    @State private var errorMessage: String?

    public init() {}

    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var categories: [Category] {
        guard let ledger else { return [] }
        return allCategories.filter { $0.ledger?.id == ledger.id && $0.kind == kindTab }
    }

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("类型", selection: $kindTab) {
                    Text("支出").tag(CategoryKind.expense)
                    Text("收入").tag(CategoryKind.income)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.bottom, 4)

                List {
                    Section {
                        ForEach(categories) { category in
                            categoryRow(category)
                                .contentShape(Rectangle())
                                .onTapGesture { editingCategory = category }
                        }
                        .onDelete { offsets in
                            for index in offsets {
                                context.delete(categories[index])
                            }
                            do {
                                try context.save()
                            } catch {
                                context.rollback()
                                errorMessage = "删除分类失败：\(error.localizedDescription)"
                            }
                        }
                    } header: {
                        Text("\(kindTab == .expense ? "支出" : "收入")分类")
                    } footer: {
                        Text("停用后不再出现在记账分类中，历史交易不受影响。")
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("分类")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新建分类")
                }
            }
            .sheet(isPresented: $showingAdd) { CategoryEditView(ledger: ledger, defaultKind: kindTab) }
            .sheet(item: $editingCategory) { category in
                CategoryEditView(category: category, ledger: ledger, defaultKind: kindTab)
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

    private func categoryRow(_ category: Category) -> some View {
        HStack(spacing: 12) {
            IconBadge(icon: category.icon, colorHex: category.colorHex, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(category.name).font(.body.weight(.medium))
                if category.isSystem {
                    Text("内置分类").font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if !category.isEnabled {
                Text("已停用").font(.caption).foregroundStyle(.secondary)
            } else {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.secondary)
                    .opacity(0.4)
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
    }
}

public struct CategoryEditView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let category: Category?
    let ledger: Ledger?
    let defaultKind: CategoryKind

    @State private var name: String
    @State private var icon: String
    @State private var colorHex: String
    @State private var isEnabled: Bool
    @State private var kind: CategoryKind
    @State private var errorMessage: String?

    private let iconChoices = ["fork.knife", "bus.fill", "bag.fill", "house.fill", "gamecontroller.fill", "cross.case.fill", "book.fill", "gift.fill", "creditcard.fill", "star.fill", "chart.line.uptrend.xyaxis", "ellipsis.circle.fill", "cart.fill", "phone.fill", "pawprint.fill", "tshirt.fill", "fuelpump.fill", "heart.fill", "airplane", "plus.circle.fill"]
    private let colorChoices = ["FF9F0A", "0A84FF", "FF375F", "64D2FF", "AF52DE", "FF3B30", "5E5CE6", "FFD60A", "32D74B", "8E8E93"]

    public init(category: Category? = nil, ledger: Ledger?, defaultKind: CategoryKind) {
        self.category = category
        self.ledger = ledger
        self.defaultKind = defaultKind
        _name = State(initialValue: category?.name ?? "")
        _icon = State(initialValue: category?.icon ?? "tag")
        _colorHex = State(initialValue: category?.colorHex ?? "0A84FF")
        _isEnabled = State(initialValue: category?.isEnabled ?? true)
        _kind = State(initialValue: category?.kind ?? defaultKind)
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("基本信息") {
                    TextField("分类名称", text: $name)
                    Picker("类型", selection: $kind) {
                        Text("支出").tag(CategoryKind.expense)
                        Text("收入").tag(CategoryKind.income)
                    }
                    .pickerStyle(.segmented)
                    .disabled(category != nil) // 改变类型会破坏统计口径，编辑时不允许
                    Toggle("启用", isOn: $isEnabled)
                }
                Section("图标") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(iconChoices, id: \.self) { choice in
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
                        ForEach(colorChoices, id: \.self) { choice in
                            Circle()
                                .fill(Color(hex: choice))
                                .frame(width: 32, height: 32)
                                .overlay(
                                    Circle().stroke(colorHex == choice ? Color.primary : Color.clear, lineWidth: 2)
                                )
                                .onTapGesture { colorHex = choice }
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle(category == nil ? "新建分类" : "编辑分类")
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
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        if let category {
            category.name = trimmed
            category.icon = icon
            category.colorHex = colorHex
            category.isEnabled = isEnabled
            category.kind = kind
        } else {
            let c = Category(name: trimmed, icon: icon, colorHex: colorHex, kind: kind, isSystem: false, isEnabled: isEnabled, sortOrder: (ledger?.categories.count ?? 0))
            c.ledger = ledger
            context.insert(c)
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
