import SwiftUI

struct CategoryListView: View {
    @Environment(DataStore.self) private var store
    @State private var showAdd = false
    @State private var editing: Category?
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section("支出") {
                ForEach(store.categories.filter { $0.type == "expense" }) { cat in
                    row(cat)
                }
            }
            Section("收入") {
                ForEach(store.categories.filter { $0.type == "income" }) { cat in
                    row(cat)
                }
            }
        }
        .navigationTitle("分类管理")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showAdd = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showAdd) { CategoryFormView() }
        .sheet(item: $editing) { cat in CategoryFormView(existing: cat) }
        .task { await store.refreshCategories() }
        .errorAlert($errorMessage)
    }

    private func row(_ cat: Category) -> some View {
        Button { editing = cat } label: {
            HStack(spacing: 12) {
                CategoryBadge(icon: cat.icon, color: cat.color)
                Text(cat.name)
            }
        }
        .swipeActions {
            Button("删除", role: .destructive) { Task { await delete(cat) } }
        }
    }

    private func delete(_ cat: Category) async {
        do {
            try await APIService.shared.deleteCategory(id: cat.id)
            await store.refreshCategories()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct CategoryFormView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(DataStore.self) private var store
    let existing: Category?

    @State private var name = ""
    @State private var type = "expense"
    @State private var errorMessage: String?

    init(existing: Category? = nil) {
        self.existing = existing
        _name = State(initialValue: existing?.name ?? "")
        _type = State(initialValue: existing?.type ?? "expense")
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("分类名称", text: $name)
                if existing == nil {
                    Picker("类型", selection: $type) {
                        Text("支出").tag("expense")
                        Text("收入").tag("income")
                    }
                }
            }
            .navigationTitle(existing == nil ? "新建分类" : "编辑分类")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }.disabled(name.isEmpty)
                }
            }
            .errorAlert($errorMessage)
        }
    }

    private func save() async {
        do {
            if let existing {
                _ = try await APIService.shared.updateCategory(id: existing.id, name: name, icon: nil, color: nil)
            } else {
                _ = try await APIService.shared.createCategory(name: name, type: type, icon: nil, color: nil)
            }
            await store.refreshCategories()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
