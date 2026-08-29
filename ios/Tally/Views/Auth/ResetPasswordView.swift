import SwiftUI

/// 找回密码（短信恢复）。
///
/// 本项目不提供的功能：邮件找回。服务端未接入 SMTP，邮件 reset-token 契约已下线，
/// 因此这里只有「已注册手机号 + 短信验证码 → 设置新密码」这一条可用路径。
struct ResetPasswordView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var phone = ""
    @State private var code = ""
    @State private var newPassword = ""
    @State private var confirmPassword = ""
    @State private var isRequesting = false
    @State private var isSubmitting = false
    @State private var cooldownLeft = 0
    @State private var cooldownTask: Task<Void, Never>?
    @State private var devCode: String?
    @State private var errorMessage: String?
    @State private var doneMessage: String?

    private var phoneDigits: String { phone.replacingOccurrences(of: " ", with: "").filter { $0.isNumber } }
    private var phoneValid: Bool { phoneDigits.count == 11 && phoneDigits.hasPrefix("1") }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("已注册的手机号", text: $phone)
                        .textContentType(.telephoneNumber)
                        .keyboardType(.phonePad)

                    HStack {
                        TextField("短信验证码", text: $code)
                            .keyboardType(.numberPad)
                        if cooldownLeft > 0 {
                            Text("\(cooldownLeft)s")
                                .font(.footnote).foregroundColor(.secondary)
                        } else {
                            Button("获取验证码") { Task { await requestCode() } }
                                .font(.footnote)
                                .disabled(isRequesting)
                        }
                    }

                    SecureField("新密码（至少 8 位）", text: $newPassword)
                        .textContentType(.newPassword)
                    SecureField("确认新密码", text: $confirmPassword)
                        .textContentType(.newPassword)
                } footer: {
                    Text("验证码通过短信发送到该机号；重置成功后其他设备需重新登录。邮箱账号暂不支持自助找回。")
                        .font(.footnote)
                }

                if let devCode {
                    // 仅开发/联调环境后端会回传验证码；生产环境恒为 nil，界面不会出现这一行
                    Text("开发环境验证码：\(devCode)").font(.footnote).foregroundColor(.secondary)
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        if isSubmitting {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("设置新密码").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(isSubmitting || code.isEmpty || newPassword.count < 8 || confirmPassword.count < 8)
                }
            }
            .navigationTitle("找回密码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .errorAlert($errorMessage)
            .alert("密码已重置", isPresented: Binding(get: { doneMessage != nil }, set: { if !$0 { doneMessage = nil } })) {
                Button("去登录") { dismiss() }
            } message: {
                Text(doneMessage ?? "")
            }
            .onDisappear { cooldownTask?.cancel() }
        }
    }

    private func requestCode() async {
        guard phoneValid else {
            errorMessage = "请输入 11 位手机号"
            return
        }
        isRequesting = true
        defer { isRequesting = false }
        do {
            devCode = try await APIService.shared.requestPasswordResetCode(phone: phone)
            errorMessage = nil
            startCooldown()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

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
        guard phoneValid else { errorMessage = "请输入 11 位手机号"; return }
        guard newPassword == confirmPassword else { errorMessage = "两次输入的新密码不一致"; return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await APIService.shared.resetPasswordByCode(phone: phone, code: code, newPassword: newPassword)
            doneMessage = "已用短信验证码重设密码，请用新密码重新登录。"
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
