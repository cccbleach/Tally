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
                    // 负债中心的金额已由服务端折算到账本本位币
                    LabeledContent("负债合计", value: Money.format(s.totalDebt, currency: store.baseCurrencyCode))
                }
                Section("信用卡") {
                    if s.creditCards.isEmpty {
                        Text("暂无信用卡").foregroundColor(.secondary)
                    }
                    ForEach(s.creditCards) { card in
                        HStack {
                            Text(card.name)
                            Spacer()
                            Text("欠款 " + Money.format(card.debt, currency: store.baseCurrencyCode)).foregroundColor(.red)
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
                            Text("剩余本金 " + Money.format(loan.remainingPrincipal, currency: store.baseCurrencyCode)).font(.subheadline)
                            if let next = loan.nextPaymentDate {
                                Text("下期 \(next) · 月供 " + Money.format(loan.monthlyPayment, currency: store.baseCurrencyCode))
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
                                Text("应还 " + Money.format(bill.statementBalance, currency: store.baseCurrencyCode)).font(.subheadline)
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
        // 选还款来源的三条硬约束（服务端都会拒绝，但不能让用户按键后才发现）：
        //   1) 不能是信用卡/贷款负债账户（服务端 INVALID_PAY_ACCOUNT）；
        //   2) 必须与信用卡同币种（服务端 CURRENCY_MISMATCH）——多币种账本里
        //      「第一张非信用卡账户」很可能是别的币种；
        //   3) 不能是已归档账户（store.accounts 包含归档账户）。
        let billCurrency = summary?.creditCardBills.first(where: { $0.id == id })?.currency
        let candidate = store.accounts.first { account in
            guard account.type != "credit", account.type != "loan", !account.isArchived else { return false }
            guard let billCurrency else { return true }
            return account.currency == billCurrency
        }
        guard let payFrom = candidate else {
            errorMessage = billCurrency.map { "请先创建一张 \($0) 的银行卡/现金账户（还款账户必须与信用卡同币种且未归档）" }
                ?? "请先创建一张银行卡/现金账户用于还款"
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
    @Environment(DataStore.self) private var store
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
        // 账单金额按账本本位币解析（负债中心整体折算到本位币展示）
        guard let amount = Money.minorUnits(fromInput: amountYuan, currency: store.baseCurrencyCode) else {
            errorMessage = "请输入有效金额"
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            try await APIService.shared.createCreditCardBill(
                accountId: cardId,
                period: period,
                statementBalance: amount,
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
    @Environment(LockService.self) private var lockService
    @AppStorage(LockService.enabledKey) private var biometricLockEnabled = false
    @State private var errorMessage: String?
    @State private var confirmLogoutAll = false
    @State private var logoutAllNotice: String?
    @State private var isLoggingOutAll = false
    // CSV 导出：异步拉全量流水 → 写临时文件 → 系统分享面板
    @State private var isExporting = false
    @State private var exportFile: ExportFile?

    /// 分享面板需要 Identifiable 才能用 sheet(item:) 弹出
    struct ExportFile: Identifiable {
        let id = UUID()
        let url: URL
    }

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
                    Button {
                        Task { await exportCSV() }
                    } label: {
                        if isExporting {
                            HStack { Text("正在生成导出文件…"); Spacer(); ProgressView() }
                        } else {
                            Label("导出全部流水（CSV）", systemImage: "square.and.arrow.up")
                        }
                    }
                    .disabled(isExporting)
                } footer: {
                    Text("导出当前账本全部流水为 CSV（含币种列），可通过「文件」/AirDrop 等保存备份。")
                }

                if lockService.deviceSupportsLock {
                    Section {
                        Toggle("生物锁（Face ID / 触控 ID）", isOn: $biometricLockEnabled)
                    } footer: {
                        Text("开启后，App 切到后台即上锁，回到前台需验证才能查看账目。")
                    }
                }

                Section {
                    Button("退出登录", role: .destructive) { appState.logout() }
                    // 令牌疑似泄漏时的兜底：吊销该账号在所有设备上的会话
                    Button {
                        confirmLogoutAll = true
                    } label: {
                        if isLoggingOutAll {
                            HStack { Text("正在退出全部设备…"); Spacer(); ProgressView() }
                        } else {
                            Text("退出全部设备")
                        }
                    }
                    .disabled(isLoggingOutAll)
                } footer: {
                    Text("「退出全部设备」会让其他手机/平板上已登录的会话立即失效，需要重新登录。")
                }

                Section {
                    // 版本号从 Bundle 读，避免写死值与 MARKETING_VERSION 漂移（历史上写的是 v0.1.0，
                    // 而工程版本早已是 1.0.0）。构建号一并展示，方便核对测试包。
                    Text(Self.versionText).font(.caption).foregroundColor(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("设置")
            .task { await refreshProfile() }
            .refreshable { await refreshProfile() }
            .sheet(item: $exportFile) { file in
                ActivityShareSheet(items: [file.url])
                    .presentationDetents([.medium, .large])
                    .ignoresSafeArea()
            }
            .confirmationDialog("退出全部设备？", isPresented: $confirmLogoutAll, titleVisibility: .visible) {
                Button("退出全部设备", role: .destructive) {
                    Task { await performLogoutAll() }
                }
                Button("取消", role: .cancel) {}
            } message: {
                Text("将吊销你账号在所有设备上的登录会话，其他设备需要重新用短信验证码登录。")
            }
            .alert("退出全部设备", isPresented: Binding(get: { logoutAllNotice != nil }, set: { if !$0 { logoutAllNotice = nil } })) {
                Button("好", role: .cancel) {}
            } message: {
                Text(logoutAllNotice ?? "")
            }
            .errorAlert($errorMessage)
        }
    }

    /// 形如 "Tally v1.0.0 (1)"；Info.plist 缺失时退化为 "Tally"
    private static var versionText: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? ""
        let build = info?["CFBundleVersion"] as? String ?? ""
        guard !version.isEmpty else { return "Tally" }
        return build.isEmpty ? "Tally v\(version)" : "Tally v\(version) (\(build))"
    }

    /// 退出全部设备：服务端吊销成功与否都要完成本地登出；
    /// 服务端吊销失败时明确告知用户"其他设备仍然有效"，而不是假装成功。
    private func performLogoutAll() async {
        isLoggingOutAll = true
        let revokedOnServer = await appState.logoutAllDevices()
        isLoggingOutAll = false
        logoutAllNotice = revokedOnServer
            ? "已吊销全部设备上的会话，其他设备需重新登录。"
            : "本地已退出，但服务端吊销失败（网络不可用？）。其他设备上的登录仍然有效，请联网后重新登录并再次执行。"
    }

    private func refreshProfile() async {
        // 设置页只刷新本人资料；共享账本与邀请统一由明细页入口维护。
        if let profile = try? await APIService.shared.myProfile() {
            appState.user = profile
        }
    }

    /// 拉全量流水（分页）→ 生成 CSV → 写临时文件 → 弹分享面板。
    /// 失败时如实提示，不弹空文件。
    private func exportCSV() async {
        isExporting = true
        defer { isExporting = false }
        do {
            let transactions = try await TransactionCSVExport.fetchAll { page in
                try await APIService.shared.transactions(
                    from: nil, to: nil, accountId: nil, categoryId: nil, type: nil,
                    page: page, limit: 200
                )
            }
            let csv = TransactionCSVExport.csv(from: transactions)
            exportFile = ExportFile(
                url: try TransactionCSVExport.writeTemporaryFile(csv, fileName: TransactionCSVExport.suggestedFileName())
            )
        } catch {
            errorMessage = "导出失败：\(error.localizedDescription)"
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
