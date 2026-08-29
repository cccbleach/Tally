import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState
    @State private var phone = ""
    @State private var code = ""
    @State private var isSubmitting = false
    @State private var isRequesting = false
    @State private var lastCodeSent = false
    @State private var cooldownLeft = 0
    @State private var cooldownTask: Task<Void, Never>?
    @State private var errorMessage: String?
    @State private var showResetPassword = false

    private var phoneDigits: String {
        phone.replacingOccurrences(of: " ", with: "").filter { $0.isNumber }
    }
    private var phoneValid: Bool {
        phoneDigits.count == 11 && phoneDigits.hasPrefix("1")
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()
                Image(systemName: "list.bullet.rectangle.portrait.fill")
                    .font(.system(size: 64))
                    .foregroundColor(.accentColor)
                Text("Tally").font(.largeTitle.bold())
                Text("简单记账，清楚生活").font(.subheadline).foregroundColor(.secondary)
                Spacer()

                TextField("手机号", text: $phone)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .textFieldStyle(.roundedBorder)

                HStack {
                    TextField("验证码", text: $code)
                        .keyboardType(.numberPad)
                        .textFieldStyle(.roundedBorder)
                    if cooldownLeft > 0 {
                        Text("\(cooldownLeft)s 后可重发")
                            .font(.footnote).foregroundColor(.secondary)
                            .frame(minWidth: 90)
                    } else {
                        Button(lastCodeSent ? "重新获取" : "获取验证码") {
                            Task { await requestCode() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(isRequesting)
                    }
                }

                Button {
                    Task { await submit() }
                } label: {
                    if isSubmitting {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("登录").frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSubmitting || code.isEmpty)

                Text("未注册的手机号将自动创建账号").font(.caption).foregroundColor(.secondary)

                // 账号恢复：只有短信一条路（邮件找回的邮件投递从未接通，契约已下线）
                Button("用手机号找回密码") { showResetPassword = true }
                    .font(.footnote)
                    .foregroundColor(.accentColor)

                Spacer()
            }
            .padding()
            .errorAlert($errorMessage)
            .sheet(isPresented: $showResetPassword) { ResetPasswordView() }
            .onDisappear { cooldownTask?.cancel() }
        }
    }

    // 只在点击“获取验证码”时校验手机号；不合法就提示，不发请求
    private func requestCode() async {
        if !phoneValid {
            errorMessage = "请输入 11 位手机号"
            return
        }
        isRequesting = true
        defer { isRequesting = false }
        do {
            _ = try await APIService.shared.requestLoginCode(phone: phone)
            lastCodeSent = true
            errorMessage = nil
            startCooldown()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // 60 秒重发间隔
    private func startCooldown() {
        cooldownTask?.cancel()
        cooldownLeft = 60
        cooldownTask = Task { @MainActor in
            while cooldownLeft > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { break }
                cooldownLeft -= 1
            }
        }
    }

    private func submit() async {
        guard phoneValid else {
            errorMessage = "请输入 11 位手机号"
            return
        }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await appState.loginWithCode(phone: phone, code: code)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
