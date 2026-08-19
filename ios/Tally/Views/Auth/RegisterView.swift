import SwiftUI

struct RegisterView: View {
    @Environment(AppState.self) private var appState
    @State private var email = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 16) {
            Text("创建账号").font(.title2.bold()).padding(.top)

            TextField("昵称（可选）", text: $displayName)
                .textFieldStyle(.roundedBorder)
            TextField("手机号 / 邮箱", text: $email)
                .textContentType(.username)
                .keyboardType(.default)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            SecureField("密码（至少 8 位）", text: $password)
                .textContentType(.newPassword)
                .textFieldStyle(.roundedBorder)

            Button {
                Task { await submit() }
            } label: {
                if isSubmitting {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("注册并登录").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSubmitting || email.isEmpty || password.count < 8)

            Spacer()
        }
        .padding()
        .navigationTitle("注册")
        .navigationBarTitleDisplayMode(.inline)
        .errorAlert($errorMessage)
    }

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await appState.register(email: email, password: password, displayName: displayName)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
