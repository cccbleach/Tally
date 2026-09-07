import SwiftUI

struct LiabilitiesView: View {
    @Environment(DataStore.self) private var store
    @State private var summary: LiabilitySummary?
    @State private var errorMessage: String?
    @State private var showAddBill = false

    var body: some View {
        List {
            if let s = summary {
                Section("总负债") {
                    LabeledContent("负债合计", value: Money.format(s.totalDebt))
                }
                Section("信用卡") {
                    if s.creditCards.isEmpty {
                        Text("暂无信用卡").foregroundColor(.secondary)
                    }
                    ForEach(s.creditCards) { card in
                        HStack {
                            Text(card.name)
                            Spacer()
                            Text("欠款 " + Money.format(card.debt)).foregroundColor(.red)
                        }
                    }
                }
                Section("贷款") {
                    if s.loans.isEmpty {
                        Text("暂无贷款").foregroundColor(.secondary)
                    }
                    ForEach(s.loans) { loan in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(loan.name).font(.headline)
                            Text("剩余本金 " + Money.format(loan.remainingPrincipal)).font(.subheadline)
                            if let next = loan.nextPaymentDate {
                                Text("下期 \(next) · 月供 " + Money.format(loan.monthlyPayment))
                                    .font(.caption).foregroundColor(.secondary)
                            }
                        }
                    }
                }
                Section("信用卡账单") {
                    if s.creditCardBills.isEmpty {
                        Text("暂无账单").foregroundColor(.secondary)
                    }
                    ForEach(s.creditCardBills) { bill in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(bill.period).font(.headline)
                                Text("应还 " + Money.format(bill.statementBalance)).font(.subheadline)
                                if let due = bill.dueDate {
                                    Text("还款日 \(due)").font(.caption).foregroundColor(.secondary)
                                }
                            }
                            Spacer()
                            if !bill.paid {
                                Button("标记已还") {
                                    Task { await markPaid(bill.id) }
                                }
                                .buttonStyle(.bordered)
                            } else {
                                Text("已还").foregroundColor(.green)
                            }
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("负债中心")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddBill = true
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(summary?.creditCards.isEmpty ?? true)
            }
        }
        .sheet(isPresented: $showAddBill) {
            if let cards = summary?.creditCards {
                AddCreditCardBillView(cards: cards) {
                    await load()
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .errorAlert($errorMessage)
    }

    private func load() async {
        do {
            summary = try await APIService.shared.liabilities()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func markPaid(_ id: String) async {
        // 还款需要生成「还款账户 → 信用卡」的转账，不能只改状态。
        // 自动选择账本下第一张非信用卡账户作为还款来源。
        let payFrom = store.accounts.first(where: { $0.type != "credit" })
        guard let payFrom else {
            errorMessage = "请先创建一张银行卡/现金账户用于还款"
            return
        }
        do {
            try await APIService.shared.payCreditCardBill(id: id, payFromAccountId: payFrom.id, payDate: nil)
            await store.loadAll()
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct AddCreditCardBillView: View {
    @Environment(\.dismiss) private var dismiss
    let cards: [CreditCardLiability]
    let onSaved: () async -> Void

    @State private var cardId = ""
    @State private var period = ""
    @State private var amountYuan = ""
    @State private var dueDate = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("信用卡") {
                    Picker("账户", selection: $cardId) {
                        ForEach(cards) { card in
                            Text(card.name).tag(card.id)
                        }
                    }
                }
                Section("账单") {
                    TextField("周期 YYYY-MM", text: $period)
                        .keyboardType(.numbersAndPunctuation)
                    TextField("应还金额（元）", text: $amountYuan)
                        .keyboardType(.decimalPad)
                    TextField("还款日 YYYY-MM-DD（可选）", text: $dueDate)
                        .keyboardType(.numbersAndPunctuation)
                }
            }
            .navigationTitle("新增信用卡账单")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }
                        .disabled(isSaving || cardId.isEmpty || period.isEmpty || amountYuan.isEmpty)
                }
            }
            .errorAlert($errorMessage)
        }
        .onAppear {
            if cardId.isEmpty, let first = cards.first {
                cardId = first.id
            }
        }
    }

    private func save() async {
        guard let cents = Money.cents(fromYuanString: amountYuan) else {
            errorMessage = "请输入有效金额"
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            try await APIService.shared.createCreditCardBill(
                accountId: cardId,
                period: period,
                statementBalance: cents,
                minimumPayment: nil,
                dueDate: dueDate.isEmpty ? nil : dueDate
            )
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section("账号") {
                    NavigationLink { NicknameEditView() } label: { LabeledContent("公开昵称", value: appState.user?.nickname ?? "-") }
                    LabeledContent("手机号", value: appState.user?.phoneMasked ?? "-")
                    if let next = appState.user?.nicknameChangeAvailableAt {
                        LabeledContent("下次可改昵称", value: String(next.prefix(10)))
                    }
                }

                Section("管理") {
                    NavigationLink("分类管理") { CategoryListView() }
                    NavigationLink("周期账单") { RecurringView() }
                    NavigationLink("导入账单") { StagedImportView() }
                    NavigationLink("负债中心") { LiabilitiesView() }
                }

                Section {
                    Button("退出登录", role: .destructive) { appState.logout() }
                }

                Section {
                    Text("Tally v0.1.0").font(.caption).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("设置")
            .task { await refreshProfile() }
            .refreshable { await refreshProfile() }
            .errorAlert($errorMessage)
        }
    }

    private func refreshProfile() async {
        // 设置页只刷新本人资料；共享账本与邀请统一由明细页入口维护。
        if let profile = try? await APIService.shared.myProfile() {
            appState.user = profile
        }
    }
}


// 修改公开昵称：30 天冷却 + 全局判重
struct NicknameEditView: View {
    @Environment(AppState.self) private var appState
    @State private var nickname = ""
    @State private var isSaving = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("公开昵称") {
                TextField("昵称", text: $nickname)
                    .onAppear { nickname = appState.user?.nickname ?? "" }
            }
            if let message {
                Section { Text(message).foregroundColor(.green) }
            }
            Section {
                Button("保存") {
                    Task { await save() }
                }
                .disabled(isSaving || nickname.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle("修改昵称")
        .errorAlert($errorMessage)
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await APIService.shared.changeNickname(nickname.trimmingCharacters(in: .whitespacesAndNewlines))
            appState.user = updated
            message = "昵称已更新"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
