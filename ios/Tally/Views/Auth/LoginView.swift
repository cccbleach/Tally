import SwiftUI

enum LoginMode: String, CaseIterable, Identifiable {
    case password = "密码登录"
    case code = "验证码登录"
    var id: String { rawValue }
}

struct LoginView: View {
    @Environment(AppState.self) private var appState
    @State private var mode: LoginMode = .password
    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var isSubmitting = false
    @State private var isRequesting = false
    @State private var lastCodeSent = false
    @State private var cooldownLeft = 0
    @State private var cooldownTask: Task<Void, Never>?
    @State private var errorMessage: String?
    @State private var showRegister = false

    private var phoneDigits: String {
        email.replacingOccurrences(of: " ", with: "").filter { $0.isNumber }
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

                Picker("登录方式", selection: $mode) {
                    ForEach(LoginMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                if mode == .password {
                    passwordSection
                } else {
                    codeSection
                }

                if mode == .password {
                    Button("还没有账号？注册") { showRegister = true }
                        .font(.subheadline)
                }

                Spacer()
            }
            .padding()
            .navigationDestination(isPresented: $showRegister) { RegisterView() }
            .errorAlert($errorMessage)
            .onDisappear { cooldownTask?.cancel() }
        }
    }

    @ViewBuilder
    private var passwordSection: some View {
        TextField("手机号 / 邮箱", text: $email)
            .textContentType(.username)
            .keyboardType(.default)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)

        SecureField("密码", text: $password)
            .textContentType(.password)
            .textFieldStyle(.roundedBorder)

        Button {
            Task { await submitPassword() }
        } label: {
            if isSubmitting {
                ProgressView().frame(maxWidth: .infinity)
            } else {
                Text("登录").frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isSubmitting || email.isEmpty || password.isEmpty)
    }

    @ViewBuilder
    private var codeSection: some View {
        HStack {
            TextField("手机号", text: $email)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
                .textFieldStyle(.roundedBorder)
            if cooldownLeft > 0 {
                Text("\(cooldownLeft)s 后可重发")
                    .font(.footnote).foregroundColor(.secondary)
                    .frame(minWidth: 96)
            } else {
                Button(lastCodeSent ? "重新获取" : "获取验证码") {
                    Task { await requestCode() }
                }
                .buttonStyle(.bordered)
                .disabled(!phoneValid || isRequesting)
            }
        }

        if !email.isEmpty && !phoneValid {
            Text("请输入 11 位手机号").font(.footnote).foregroundColor(.red)
        }

        TextField("验证码", text: $code)
            .keyboardType(.numberPad)
            .textFieldStyle(.roundedBorder)

        Button {
            Task { await submitCode() }
        } label: {
            if isSubmitting {
                ProgressView().frame(maxWidth: .infinity)
            } else {
                Text("登录").frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isSubmitting || !phoneValid || code.isEmpty)
    }

    private func requestCode() async {
        isRequesting = true
        defer { isRequesting = false }
        do {
            _ = try await APIService.shared.requestLoginCode(phone: email)
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

    private func submitPassword() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await appState.login(email: email, password: password)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func submitCode() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await appState.loginWithCode(phone: email, code: code)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
