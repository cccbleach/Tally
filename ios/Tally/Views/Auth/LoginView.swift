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
    @State private var sentCodeHint: String?
    @State private var errorMessage: String?
    @State private var showRegister = false

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
            Button(lastCodeSent ? "重新获取" : "获取验证码") {
                Task { await requestCode() }
            }
            .buttonStyle(.bordered)
            .disabled(email.isEmpty || isRequesting)
        }

        if let hint = sentCodeHint, lastCodeSent {
            Text("验证码：\(hint)").font(.footnote).foregroundColor(.secondary)
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
        .disabled(isSubmitting || email.isEmpty || code.isEmpty)
    }

    private func requestCode() async {
        isRequesting = true
        defer { isRequesting = false }
        do {
            sentCodeHint = try await APIService.shared.requestLoginCode(phone: email)
            lastCodeSent = true
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
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
