import SwiftUI

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
