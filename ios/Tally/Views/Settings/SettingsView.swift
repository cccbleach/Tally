import SwiftUI

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
