import SwiftUI
import UniformTypeIdentifiers

enum BillSource: String, CaseIterable, Identifiable {
    case wechat = "微信"
    case alipay = "支付宝"
    var id: String { rawValue }
    var apiValue: String {
        switch self {
        case .wechat: return "wechat"
        case .alipay: return "alipay"
        }
    }
}

struct BillImportView: View {
    @Environment(DataStore.self) private var store
    @State private var source: BillSource = .wechat
    @State private var showPicker = false
    @State private var importing = false
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
                Text("微信：我 → 服务 → 钱包 → 账单 → 导出账单 → 保存到手机\n支付宝：我的 → 账单 → 右上角… → 开具交易流水/导出")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            if let message {
                Section { Text(message).foregroundColor(.green) }
            }
        }
        .navigationTitle("导入账单")
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.plainText, .commaSeparatedText]) { result in
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
        defer { importing = false }
        do {
            let data = try Data(contentsOf: url)
            guard let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) else {
                throw APIError.invalidResponse
            }
            let res = try await APIService.shared.importBill(source: source.apiValue, content: text)
            message = "导入成功 \(res.imported) 条，重复跳过 \(res.skipped) 条"
            await store.loadAll()
        } catch {
            errorMessage = "导入失败：" + error.localizedDescription
        }
    }
}

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var baseURL = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section("账号") {
                    LabeledContent("邮箱", value: appState.user?.email ?? "-")
                    LabeledContent("昵称", value: appState.user?.displayName ?? "-")
                }

                Section("服务器地址") {
                    TextField("http://…", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("保存并重新登录") { saveBaseURL() }
                }

                Section("管理") {
                    NavigationLink("分类管理") { CategoryListView() }
                    NavigationLink("周期账单") { RecurringView() }
                    NavigationLink("导入账单") { BillImportView() }
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
        .onAppear {
            baseURL = UserDefaults.standard.string(forKey: "baseURL") ?? APIClient.shared.baseURL
        }
    }

    private func saveBaseURL() {
        let trimmed = baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))
        UserDefaults.standard.set(trimmed.isEmpty ? "http://127.0.0.1:8080" : trimmed, forKey: "baseURL")
        appState.logout()
    }
}
