//
//  SettingsView.swift
//  Tally
//
//  Settings hub: appearance, currency, month start, privacy lock, data
//  import/export/backup/restore, recently deleted, legal & privacy.
//

import SwiftUI
import SwiftData
import UniformTypeIdentifiers

public struct SettingsView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppState.self) private var appState
    @Query private var settingsList: [AppSettings]
    @Query private var ledgers: [Ledger]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]

    @State private var exportingCSV: TransactionExportDocument?
    @State private var exportingBackup: BackupExportDocument?
    @State private var showingImportPicker = false
    @State private var showingClearConfirm = false
    @State private var showingRestoreConfirm = false
    @State private var pendingRestoreData: Data?
    @State private var toast: String?
    @State private var biometricToggle = BiometricToggleCoordinator()

    public init() {}

    private var settings: AppSettings? { settingsList.first }
    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var activeLedgerTransactions: [Transaction] {
        guard let ledger else { return [] }
        return allTransactions.filter { $0.ledger?.id == ledger.id }
    }

    private var recentlyDeleted: [Transaction] {
        activeLedgerTransactions.filter { $0.isDeleted }.sorted { ($0.deletedAt ?? .distantPast) > ($1.deletedAt ?? .distantPast) }
    }

    public var body: some View {
        NavigationStack {
            mainList
        }
        .fileExporter(
            isPresented: exportCSVFlag,
            document: exportingCSV,
            contentType: .commaSeparatedText,
            defaultFilename: "tally-transactions-\(DateFormatter.backupStamp.string(from: Date())).csv"
        ) { result in
            if case .failure(let error) = result {
                showToast("导出失败：\(error.localizedDescription)")
            } else {
                showToast("CSV 已导出")
            }
        }
        .fileExporter(
            isPresented: exportBackupFlag,
            document: exportingBackup,
            contentType: .json,
            defaultFilename: "tally-backup-\(DateFormatter.backupStamp.string(from: Date())).json"
        ) { result in
            if case .failure(let error) = result {
                showToast("备份失败：\(error.localizedDescription)")
            } else {
                showToast("备份已导出")
            }
        }
        .fileImporter(isPresented: $showingImportPicker, allowedContentTypes: [.commaSeparatedText, .json, .plainText], allowsMultipleSelection: false) { result in
            handleImport(result)
        }
        .confirmationDialog("清除全部数据？", isPresented: $showingClearConfirm, titleVisibility: .visible) {
            Button("删除全部数据", role: .destructive) { clearAll() }
            Button("取消", role: .cancel) {}
        } message: {
            Text("这将删除本机上的所有账本、账户、分类、交易和预算，且无法撤销。建议先导出备份。")
        }
        .confirmationDialog("恢复备份？", isPresented: $showingRestoreConfirm, titleVisibility: .visible) {
            Button("覆盖当前数据并恢复", role: .destructive) {
                if let data = pendingRestoreData {
                    restoreBackup(data)
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("恢复会用备份覆盖当前全部数据。")
        }
        .overlay(alignment: .bottom) {
            if let toast {
                Text(toast)
                    .font(.subheadline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 16)
            }
        }
    }

    private var mainList: some View {
        List {
            if let settings {
                Section("外观") {
                    Picker("外观模式", selection: appearanceBinding(settings)) {
                        ForEach(AppSettings.Appearance.allCases, id: \.self) { mode in
                            Text(mode.displayName).tag(mode)
                        }
                    }
                }
                Section("账本") {
                    Picker("默认币种", selection: currencyBinding(settings)) {
                        ForEach(Currencies.all, id: \.code) { c in
                            Text("\(c.code) \(c.symbol)").tag(c.code)
                        }
                    }
                    Stepper(value: monthStartBinding(settings), in: 1...31) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("每月起始日")
                            Text("每月 \(settings.monthStartsOn) 日开始新的统计月")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    NavigationLink("账本管理") { LedgersView() }
                    NavigationLink("账户管理") { AccountsView() }
                    NavigationLink("分类管理") { CategoriesView() }
                }
                Section("隐私与安全") {
                    Toggle("启动时使用生物识别锁定", isOn: biometricBinding(settings))
                    if settings.biometricLockEnabled && !LockService.isBiometryAvailable {
                        Text("此设备未设置面容 ID / 触控 ID，将回退到设备密码。")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
            }

            Section("最近删除") {
                if recentlyDeleted.isEmpty {
                    Text("没有可恢复的交易").foregroundStyle(.secondary)
                } else {
                    ForEach(recentlyDeleted.prefix(5)) { t in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(t.kind.displayName + " " + t.money.formatted)
                                Text(TransactionDateFormatter.string(from: t.date))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("恢复") { restore(t) }
                                .font(.subheadline)
                        }
                    }
                    if recentlyDeleted.count > 5 {
                        NavigationLink("查看全部 (\(recentlyDeleted.count))") { RecentlyDeletedView() }
                    }
                }
            }

            Section {
                Button {
                    exportCSV()
                } label: {
                    Label("导出交易 CSV", systemImage: "square.and.arrow.up")
                }
                Button {
                    exportBackup()
                } label: {
                    Label("完整备份（JSON）", systemImage: "externaldrive.fill")
                }
                Button {
                    showingImportPicker = true
                } label: {
                    Label("导入数据", systemImage: "square.and.arrow.down")
                }
                Button("清除全部数据", role: .destructive) {
                    showingClearConfirm = true
                }
            } header: {
                Text("数据")
            } footer: {
                Text("导出的文件可能包含敏感财务信息，请注意保管。")
            }

            Section("关于") {
                NavigationLink("隐私说明") { PrivacyView() }
                HStack {
                    Text("版本")
                    Spacer()
                    Text(versionString).foregroundStyle(.secondary)
                }
                Label("数据仅保存在本机", systemImage: "lock.shield.fill")
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("设置")
    }

    // MARK: - Bindings

    private func appearanceBinding(_ settings: AppSettings) -> Binding<AppSettings.Appearance> {
        Binding {
            settings.appearance
        } set: {
            settings.appearance = $0
            saveSettingsChange("外观设置")
        }
    }

    private func currencyBinding(_ settings: AppSettings) -> Binding<String> {
        Binding {
            settings.defaultCurrencyCode
        } set: {
            settings.defaultCurrencyCode = $0
            saveSettingsChange("默认币种")
        }
    }

    private func monthStartBinding(_ settings: AppSettings) -> Binding<Int> {
        Binding {
            settings.monthStartsOn
        } set: {
            settings.monthStartsOn = $0
            saveSettingsChange("每月起始日")
        }
    }

    private func biometricBinding(_ settings: AppSettings) -> Binding<Bool> {
        Binding {
            settings.biometricLockEnabled
        } set: { newValue in
            let previouslyEnabled = settings.biometricLockEnabled
            // Route every toggle through the coordinator so a stale
            // authentication result from an earlier toggle can never override a
            // newer intent (e.g. ON → OFF before the prompt returns must not
            // re-enable the lock).
            biometricToggle.run(
                previouslyEnabled: previouslyEnabled,
                desired: newValue,
                authenticate: { reason in
                    await LockService.authenticate(reason: reason)
                }
            ) { wasEnabled, effective, desired in
                if desired && !effective {
                    showToast("未能验证身份，生物识别锁未启用")
                }
                settings.biometricLockEnabled = effective
                saveSettingsChange("生物识别锁")
                // React to the persisted setting change. Re-enabling locks
                // immediately so main never stays visible after the lock is
                // turned back on in the same foreground session.
                appState.handleBiometricSettingChange(
                    wasEnabled: wasEnabled,
                    isEnabled: settings.biometricLockEnabled
                )
            }
        }
    }

    private func saveSettingsChange(_ name: String) {
        do {
            try context.save()
        } catch {
            context.rollback()
            showToast("\(name)保存失败：\(error.localizedDescription)")
        }
    }

    // MARK: - Export

    private var exportCSVFlag: Binding<Bool> {
        Binding(get: { exportingCSV != nil }, set: { if !$0 { exportingCSV = nil } })
    }

    private var exportBackupFlag: Binding<Bool> {
        Binding(get: { exportingBackup != nil }, set: { if !$0 { exportingBackup = nil } })
    }

    private func exportCSV() {
        let transactions = activeLedgerTransactions.filter { !$0.isDeleted }
        let text = CSVService.exportCSV(transactions: transactions)
        exportingCSV = TransactionExportDocument(text: text)
    }

    private func exportBackup() {
        do {
            let categories = try context.fetch(FetchDescriptor<Category>())
            let accounts = try context.fetch(FetchDescriptor<Account>())
            let budgets = try context.fetch(FetchDescriptor<Budget>())
            let allSettings = try context.fetch(FetchDescriptor<AppSettings>())
            let doc = try SnapshotBuilder.makeDocument(
                ledgers: ledgers,
                accounts: accounts,
                categories: categories,
                transactions: allTransactions,
                budgets: budgets,
                settings: allSettings
            )
            let data = try BackupService.encode(doc)
            exportingBackup = BackupExportDocument(data: data)
        } catch {
            showToast("备份生成失败：\(error.localizedDescription)")
        }
    }

    // MARK: - Import

    private func handleImport(_ result: Result<[URL], Error>) {
        do {
            guard let url = try result.get().first else { return }
            let accessing = url.startAccessingSecurityScopedResource()
            defer { if accessing { url.stopAccessingSecurityScopedResource() } }

            let data = try Data(contentsOf: url)
            if url.pathExtension.lowercased() == "json" {
                _ = try BackupService.decode(data)
                pendingRestoreData = data
                showingRestoreConfirm = true
            } else {
                guard let text = String(data: data, encoding: .utf8) else {
                    throw CSVService.CSVError.malformed("无法读取文件（需要 UTF-8 编码）")
                }
                try importCSV(text)
            }
        } catch {
            showToast("导入失败：\(error.localizedDescription)")
        }
    }

    private func importCSV(_ text: String) throws {
        guard let ledger else { return }
        let result = try CSVImportService.importCSV(text, into: ledger, context: context)
        if result.skippedDuplicateCount > 0 {
            showToast("已导入 \(result.insertedCount) 笔，跳过 \(result.skippedDuplicateCount) 笔重复交易")
        } else {
            showToast("已导入 \(result.insertedCount) 笔交易")
        }
    }

    // MARK: - Restore / Clear

    private func restoreBackup(_ data: Data) {
        do {
            let doc = try BackupService.decode(data)
            try SnapshotBuilder.restore(doc, context: context)
            appState.selectedLedgerID = doc.settings.first?.defaultLedgerID
            showToast("恢复完成")
        } catch {
            showToast("恢复失败：\(error.localizedDescription)")
        }
    }

    private func restore(_ t: Transaction) {
        t.isDeleted = false
        t.deletedAt = nil
        do {
            try context.save()
            showToast("已恢复")
        } catch {
            context.rollback()
            showToast("恢复失败：\(error.localizedDescription)")
        }
    }

    private func clearAll() {
        do {
            try PersistenceController.resetAllData(context: context)
            let freshSettings = try context.fetch(FetchDescriptor<AppSettings>()).first
            appState.selectedLedgerID = freshSettings?.defaultLedgerID
            showToast("已清除全部数据")
        } catch {
            context.rollback()
            showToast("清除失败：\(error.localizedDescription)")
        }
    }

    private var versionString: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(version) (\(build))"
    }

    private func showToast(_ message: String) {
        withAnimation { toast = message }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            withAnimation { toast = nil }
        }
    }
}

// MARK: - Recently deleted

public struct RecentlyDeletedView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppState.self) private var appState
    @Query private var ledgers: [Ledger]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @State private var errorMessage: String?

    public init() {}

    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    public var body: some View {
        List {
            let deleted = allTransactions.filter { $0.ledger?.id == ledger?.id && $0.isDeleted }
            if deleted.isEmpty {
                Text("没有可恢复的交易").foregroundStyle(.secondary)
            } else {
                ForEach(deleted) { t in
                    HStack {
                        VStack(alignment: .leading) {
                            Text("\(t.kind.displayName) · \(t.money.formatted)")
                            Text(TransactionDateFormatter.string(from: t.date))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("恢复") {
                            t.isDeleted = false
                            t.deletedAt = nil
                            do {
                                try context.save()
                            } catch {
                                context.rollback()
                                errorMessage = "恢复失败：\(error.localizedDescription)"
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("最近删除")
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

// MARK: - Privacy

public struct PrivacyView: View {
    public init() {}

    public var body: some View {
        List {
            Section {
                Label("数据只保存在本机", systemImage: "iphone")
                Label("无需注册或登录", systemImage: "person.slash")
                Label("默认离线可用", systemImage: "wifi.slash")
                Label("不含广告 SDK", systemImage: "nosign")
            } header: {
                Text("隐私承诺")
            } footer: {
                Text("Tally 不会上传你的财务数据。所有账目、分类与预算均存储在设备本地。")
            }
            Section("数据导出") {
                Text("你可以随时将交易导出为标准 CSV，或将全部数据备份为 JSON 文件。导出的文件包含敏感财务信息，请妥善保管。")
            }
        }
        .navigationTitle("隐私说明")
    }
}

// MARK: - Exportable documents

public struct TransactionExportDocument: FileDocument {
    public static var readableContentTypes: [UTType] { [.commaSeparatedText] }
    public var text: String

    public init(text: String) {
        self.text = text
    }

    public init(configuration: ReadConfiguration) throws {
        if let data = configuration.file.regularFileContents {
            text = String(decoding: data, as: UTF8.self)
        } else {
            text = ""
        }
    }

    public func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

public struct BackupExportDocument: FileDocument {
    public static var readableContentTypes: [UTType] { [.json] }
    public var data: Data

    public init(data: Data) {
        self.data = data
    }

    public init(configuration: ReadConfiguration) throws {
        if let data = configuration.file.regularFileContents {
            self.data = data
        } else {
            self.data = Data()
        }
    }

    public func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

public extension DateFormatter {
    static let backupStamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmm"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
}
