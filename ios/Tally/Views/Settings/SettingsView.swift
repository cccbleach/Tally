import SwiftUI
import UniformTypeIdentifiers

enum BillSource: String, CaseIterable, Identifiable {
    case wechat = "微信"
    case alipay = "支付宝"
    case bank = "银行"
    var id: String { rawValue }
    var apiValue: String {
        switch self {
        case .wechat: return "wechat"
        case .alipay: return "alipay"
        case .bank: return "bank"
        }
    }
}

struct BillImportView: View {
    @Environment(DataStore.self) private var store
    @State private var source: BillSource = .wechat
    @State private var showPicker = false
    @State private var importing = false
    @State private var lastData: Data?
    @State private var hasDuplicates = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("账单来源") {
                Picker("来源", selection: $source) {
                    ForEach(BillSource.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }
            Section("导出文件") {
                Button {
                    showPicker = true
                } label: {
                    if importing {
                        ProgressView()
                    } else {
                        Text("选择账单文件（txt / csv）")
                    }
                }
                .disabled(importing)
                Text("微信：我 → 服务 → 钱包 → 账单 → 导出账单（xlsx/txt）\n支付宝：我的 → 账单 → 右上角… → 开具交易流水（csv）\n银行：银行 App 导出交易流水（pdf/csv）")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if let message {
                Section {
                    Text(message).foregroundColor(.green)
                    if hasDuplicates, let data = lastData {
                        Button("仍导入这些重复项") {
                            Task { await forceImport(data) }
                        }
                        .disabled(importing)
                    }
                }
            }
        }
        .navigationTitle("导入账单")
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url):
                Task { await importFile(url) }
            case .failure(let error):
                errorMessage = error.localizedDescription
            }
        }
        .errorAlert($errorMessage)
    }

    private func importFile(_ url: URL) async {
        importing = true
        let accessing = url.startAccessingSecurityScopedResource()
        defer {
            if accessing { url.stopAccessingSecurityScopedResource() }
            importing = false
        }
        do {
            let data = try Data(contentsOf: url)
            lastData = data
            let res = try await APIService.shared.importBill(source: source.apiValue, data: data)
            let dups = res.suspectedDuplicates ?? []
            hasDuplicates = !dups.isEmpty
            var msg = "导入成功 \(res.imported) 条，重复跳过 \(res.skipped) 条"
            if hasDuplicates {
                msg += "，疑似重复 \(dups.count) 条（已自动跳过）"
            }
            message = msg
            await store.loadAll()
        } catch {
            errorMessage = "导入失败：" + error.localizedDescription
        }
    }

    private func forceImport(_ data: Data) async {
        importing = true
        defer { importing = false }
        do {
            let res = try await APIService.shared.importBill(source: source.apiValue, data: data, force: true)
            hasDuplicates = false
            message = "已强制导入 \(res.imported) 条（重复项保留）"
            await store.loadAll()
        } catch {
            errorMessage = "导入失败：" + error.localizedDescription
        }
    }
}

struct FamilyLedgerView: View {
    @State private var families: [Family] = []
    @State private var ledgers: [LedgerInfo] = []
    @State private var newFamilyName = ""
    @State private var isLoading = false
    @State private var selectedFamilyId = ""
    @State private var memberUserId = ""
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("创建家庭") {
                TextField("家庭名称", text: $newFamilyName)
                Button("创建家庭并切换") { Task { await createFamily() } }
                    .disabled(newFamilyName.isEmpty || isLoading)
            }
            Section("我的家庭") {
                if families.isEmpty {
                    Text("还没有家庭").foregroundColor(.secondary)
                }
                ForEach(families) { family in
                    Text(family.name)
                }
            }
            Section("添加成员（输入对方手机号/邮箱）") {
                Picker("家庭", selection: $selectedFamilyId) {
                    ForEach(families) { family in
                        Text(family.name).tag(family.id)
                    }
                }
                TextField("成员手机号/邮箱", text: $memberUserId)
                Button("添加成员") { Task { await addMember() } }
                    .disabled(selectedFamilyId.isEmpty || memberUserId.isEmpty || isLoading)
            }
            Section("账本（点击切换当前账本）") {
                ForEach(ledgers) { ledger in
                    Button {
                        Task { await switchLedger(ledger.id) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(ledger.name)
                                if let fid = ledger.familyId {
                                    Text("家庭账本").font(.caption).foregroundColor(.secondary)
                                } else {
                                    Text("个人账本").font(.caption).foregroundColor(.secondary)
                                }
                            }
                            Spacer()
                            if ledger.isCurrent {
                                Image(systemName: "checkmark.circle.fill").foregroundColor(.accentColor)
                            }
                        }
                    }
                }
            }
            if let message {
                Section { Text(message).foregroundColor(.green) }
            }
        }
        .navigationTitle("家庭与账本")
        .task { await load() }
        .errorAlert($errorMessage)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let f = APIService.shared.families()
            async let l = APIService.shared.ledgers()
            (families, ledgers) = try await (f, l)
            if selectedFamilyId.isEmpty, let first = families.first {
                selectedFamilyId = first.id
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createFamily() async {
        isLoading = true
        defer { isLoading = false }
        do {
            _ = try await APIService.shared.createFamily(name: newFamilyName)
            newFamilyName = ""
            message = "家庭已创建并切换"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func addMember() async {
        isLoading = true
        defer { isLoading = false }
        do {
            try await APIService.shared.addFamilyMember(familyId: selectedFamilyId, account: memberUserId)
            memberUserId = ""
            message = "成员已添加"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func switchLedger(_ id: String) async {
        do {
            try await APIService.shared.switchLedger(id: id)
            message = "已切换账本"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct LiabilitiesView: View {
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
        do {
            try await APIService.shared.markCreditCardBillPaid(id: id, paid: true)
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
                    LabeledContent("邮箱", value: appState.user?.email ?? "-")
                    LabeledContent("昵称", value: appState.user?.displayName ?? "-")
                }

                Section("管理") {
                    NavigationLink("分类管理") { CategoryListView() }
                    NavigationLink("周期账单") { RecurringView() }
                    NavigationLink("导入账单") { BillImportView() }
                    NavigationLink("家庭与账本") { FamilyLedgerView() }
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
            .errorAlert($errorMessage)
        }
    }
}
