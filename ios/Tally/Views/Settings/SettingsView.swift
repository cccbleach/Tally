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
    @Environment(AppState.self) private var appState
    @Environment(DataStore.self) private var dataStore
    @State private var families: [Family] = []
    @State private var ledgers: [LedgerInfo] = []
    @State private var newFamilyName = ""
    @State private var isLoading = false
    @State private var selectedFamilyId = ""
    @State private var memberUserId = ""
    @State private var pending: [PendingInvitation] = []
    @State private var members: [FamilyMember] = []
    @State private var currentFamilyDetail: FamilyDetail?
    @State private var renameText = ""
    @State private var transferTarget: String?
    @State private var confirmTransfer = false
    @State private var confirmRemove: String?
    @State private var confirmDeleteFamily = false
    @State private var pendingConfirm: PendingInvitation?
    @State private var message: String?
    @State private var errorMessage: String?

    private var isOwner: Bool {
        currentFamilyDetail?.ownerUserId == appState.user?.id
    }

    private var selector: String {
        selectedFamilyId.isEmpty ? (families.first?.id ?? "") : selectedFamilyId
    }

    var body: some View {
        Form {
            // 无家庭时才展示创建家庭（单家庭模型：有家庭即隐藏）
            if families.isEmpty {
                Section("创建你的家庭") {
                    TextField("家庭名称", text: $newFamilyName)
                    Button("创建家庭并切换") { Task { await createFamily() } }
                        .disabled(newFamilyName.isEmpty || isLoading)
                }
            }
            Section("待处理邀请（邀请箱）") {
                if pending.isEmpty {
                    Text("暂无待处理邀请").foregroundColor(.secondary)
                }
                ForEach(pending) { inv in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(inv.familyName).font(.subheadline.weight(.semibold))
                        Text("由 \(inv.inviterNickname) 邀请").font(.caption).foregroundColor(.secondary)
                        HStack {
                            Button("接受") { pendingConfirm = inv }
                                .buttonStyle(.borderedProminent)
                            Button("拒绝") { Task { await declineInvite(inv.id) } }
                                .buttonStyle(.bordered)
                        }
                    }
                }
            }
            Section("我的家庭") {
                if families.isEmpty {
                    Text("还没有家庭").foregroundColor(.secondary)
                }
                ForEach(families) { family in
                    Text(family.name)
                }
            }
            if currentFamilyDetail != nil {
                Section("家庭成员") {
                    if members.isEmpty {
                        Text("暂无成员").foregroundColor(.secondary)
                    }
                    ForEach(members) { m in
                        HStack {
                            Text(m.nickname)
                            Spacer()
                            if m.role == "owner" {
                                Text("创建者").font(.caption).foregroundColor(.secondary)
                            } else if isOwner {
                                Button("移除") { confirmRemove = m.userId }
                                    .font(.caption)
                            }
                        }
                    }
                }
                Section("家庭操作") {
                    if isOwner {
                        TextField("新家庭名", text: $renameText)
                        Button("改家庭名") { Task { await renameFamily() } }
                            .disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        if members.filter({ $0.role != "owner" }).count > 1 {
                            // 多成员：可选择目标，不固定第一个；选好后用独立按钮发起确认弹窗
                            Picker("转移给", selection: $transferTarget) {
                                ForEach(members.filter { $0.role != "owner" }) { m in
                                    Text(m.nickname).tag(Optional(m.userId))
                                }
                            }
                            if transferTarget != nil {
                                Button("执行转移所有权") { confirmTransfer = true }
                            }
                        } else if let only = members.filter({ $0.role != "owner" }).first {
                            Button("转移所有权给 \(only.nickname)") {
                                transferTarget = only.userId
                                confirmTransfer = true
                            }
                        }
                        Button("删除家庭", role: .destructive) { confirmDeleteFamily = true }
                    } else {
                        Button("退出家庭", role: .destructive) { Task { await exitFamily() } }
                    }
                }
                if let message {
                    Section { Text(message).foregroundColor(.green) }
                }
            }
            if isOwner {
                Section("邀请成员（输入对方精确昵称）") {
                    TextField("对方昵称", text: $memberUserId)
                    Button("发送邀请") { Task { await addMember() } }
                        .disabled(memberUserId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
                }
            } else if !families.isEmpty {
                Section {
                    Text("作为成员你可共同记账，退出家庭可回到个人账本").font(.caption).foregroundColor(.secondary)
                }
            }
            Section("账本（点击切换当前账本）") {
                ForEach(ledgers) { ledger in
                    Button {
                        Task { await switchLedger(ledger.id) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(ledger.name)
                                if ledger.familyId != nil {
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
        // 接受邀请前二次确认
        .confirmationDialog(
            "加入家庭",
            isPresented: Binding(
                get: { pendingConfirm != nil },
                set: { if !$0 { pendingConfirm = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let inv = pendingConfirm {
                Button("加入 \(inv.familyName)") { Task { await acceptInvite(inv.id) } }
                Button("取消", role: .cancel) { pendingConfirm = nil }
            }
        }
        // 移除成员二次确认
        .confirmationDialog(
            "移除成员",
            isPresented: Binding(
                get: { confirmRemove != nil },
                set: { if !$0 { confirmRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let uid = confirmRemove {
                Button("确定移除") { Task { await removeMember(uid) } }
                Button("取消", role: .cancel) { confirmRemove = nil }
            }
        }
        // 转移所有权二次确认（真正的 confirmationDialog）
        .confirmationDialog(
            "转移所有权",
            isPresented: $confirmTransfer,
            titleVisibility: .visible
        ) {
            if let target = transferTarget {
                let name = members.first(where: { $0.userId == target })?.nickname ?? "所选成员"
                Button("确认转移给 \(name)") { Task { await confirmTransfer() } }
            }
            Button("取消", role: .cancel) { confirmTransfer = false }
        }
        // 删除家庭二次确认
        .confirmationDialog(
            "删除家庭",
            isPresented: $confirmDeleteFamily,
            titleVisibility: .visible
        ) {
            Button("删除家庭（软删除账本，成员回个人账本）", role: .destructive) { Task { await deleteFamily() } }
            Button("取消", role: .cancel) { confirmDeleteFamily = false }
        }
        .errorAlert($errorMessage)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let f = APIService.shared.families()
            async let l = APIService.shared.ledgers()
            async let p = APIService.shared.pendingInvitations()
            (families, ledgers, pending) = try await (f, l, p)
            await appState.refreshPendingInvitations()
            // 单家庭模型：每次 load 都把选中家庭同步为唯一家庭（无家庭则为空），
            // 保证退出/删除后立即清空，加入/创建 C 后能正常加载 C 的成员与 Owner 控件。
            selectedFamilyId = families.first?.id ?? ""
            if !selector.isEmpty {
                await refreshFamilyDetail(selector)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func renameFamily() async {
        guard !selector.isEmpty else { return }
        let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            try await APIService.shared.renameFamily(id: selector, name: name)
            renameText = ""
            message = "家庭名已更新"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func removeMember(_ memberUserId: String) async {
        confirmRemove = nil
        guard !selector.isEmpty else { return }
        do {
            try await APIService.shared.removeMember(familyId: selector, memberUserId: memberUserId)
            message = "已移除成员"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func confirmTransfer() async {
        guard let target = transferTarget, !selector.isEmpty else { return }
        confirmTransfer = false
        do {
            try await APIService.shared.transferOwnership(familyId: selector, toMemberUserId: target)
            transferTarget = nil
            message = "所有权已转移"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func refreshFamilyDetail(_ id: String) async {
        do {
            let detail = try await APIService.shared.familyDetail(id: id)
            currentFamilyDetail = detail
            members = detail.members
        } catch {
            currentFamilyDetail = nil
            members = []
        }
    }

    private func acceptInvite(_ id: String) async {
        pendingConfirm = nil
        do {
            try await APIService.shared.acceptInvitation(id: id)
            await appState.refreshPendingInvitations()
            message = "已加入家庭并切换账本"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func declineInvite(_ id: String) async {
        do {
            try await APIService.shared.declineInvitation(id: id)
            await appState.refreshPendingInvitations()
            message = "已拒绝邀请"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func exitFamily() async {
        guard !selector.isEmpty else { return }
        do {
            try await APIService.shared.exitFamily(id: selector)
            message = "已退出家庭，切回个人账本"
            // 退出后立即清空选中家庭，确保不会残留旧家庭导致误加载
            selectedFamilyId = ""
            currentFamilyDetail = nil
            members = []
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteFamily() async {
        confirmDeleteFamily = false
        guard !selector.isEmpty else { return }
        do {
            try await APIService.shared.deleteFamily(id: selector)
            message = "家庭已删除"
            // 删除后立即清空选中家庭，确保不会残留旧家庭导致误加载
            selectedFamilyId = ""
            currentFamilyDetail = nil
            members = []
            await load()
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
            let item = try await APIService.shared.inviteByNickname(familyId: selector, nickname: memberUserId)
            memberUserId = ""
            message = "已向 \(item.targetNickname) 发送邀请"
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func switchLedger(_ id: String) async {
        do {
            try await APIService.shared.switchLedger(id: id)
            dataStore.setContext(userId: appState.user?.id, ledgerId: id)
            message = "已切换账本"
            await load()
            await dataStore.loadAll()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

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
                    NavigationLink("转入账单（预览确认）") { StagedImportView() }
                    if appState.pendingInvitationCount > 0 {
                        NavigationLink("家庭与账本") { FamilyLedgerView() }
                            .badge(appState.pendingInvitationCount)
                    } else {
                        NavigationLink("家庭与账本") { FamilyLedgerView() }
                    }
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
            .task { await refreshBadge() }
            .refreshable { await refreshBadge() }
            .errorAlert($errorMessage)
        }
    }

    private func refreshBadge() async {
        // 刷新本人资料（脱敏手机号）与邀请箱数量；角标由 AppState 全局维护
        if let profile = try? await APIService.shared.myProfile() {
            appState.user = profile
        }
        await appState.refreshPendingInvitations()
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
