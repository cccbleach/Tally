import SwiftUI

struct LoginView: View {
    @Environment(AppState.self) private var appState
    @State private var email = ""
    @State private var password = ""
    @State private var isSubmitting = false
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
                    Task { await submit() }
                } label: {
                    if isSubmitting {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("登录").frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSubmitting || email.isEmpty || password.isEmpty)

                Button("还没有账号？注册") { showRegister = true }
                    .font(.subheadline)

                Spacer()
            }
            .padding()
            .navigationDestination(isPresented: $showRegister) { RegisterView() }
            .errorAlert($errorMessage)
        }
    }

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await appState.login(email: email, password: password)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
