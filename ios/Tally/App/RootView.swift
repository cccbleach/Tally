import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var appState
    @Environment(DataStore.self) private var dataStore
    @Environment(SharedLedgerStore.self) private var sharedLedgerStore
    @Environment(LockService.self) private var lockService
    // 深链（tally://add）：小组件/快捷指令/Safari 触发
    @State private var deepLink: DeepLink.Route?

    var body: some View {
        Group {
            if appState.isLoading {
                ProgressView("加载中…")
            } else if appState.needsNicknameSetup {
                NicknameOnboardingView()
            } else if appState.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
        // 深链只在已登录时生效（未登录先去登录，避免弹出到登录页上的记账表单）
        .onOpenURL { url in
            if appState.isAuthenticated {
                deepLink = DeepLink.route(for: url)
            }
        }
        .sheet(item: $deepLink) { _ in
            AddTransactionView()
        }
        // 生物锁盖层：只盖已登录内容（登录/引导页自身即门槛，不再叠加锁屏）
        .overlay {
            if lockService.isLocked, appState.isAuthenticated {
                LockScreenView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: lockService.isLocked)
        // 用 currentUserId：离线冷启动时 user 为 nil，但 offlineUserId 有值，同样要切到
        // 该用户的缓存命名空间（否则离线启动会读到 anon 命名空间，界面全空）
        .onChange(of: appState.currentUserId) { _, newUser in
            // 换账号/退出登录时：清空内存并切换缓存命名空间，避免串数据
            lockService.isAuthenticated = appState.isAuthenticated
            if appState.isAuthenticated {
                dataStore.setContext(userId: newUser, ledgerId: dataStore.ledgerId)
            } else {
                sharedLedgerStore.reset()
                dataStore.setContext(userId: nil, ledgerId: nil)
            }
        }
    }
}

/// 锁屏层：出现即发起一次验证；取消/失败后可手动重试
struct LockScreenView: View {
    @Environment(LockService.self) private var lockService

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                Text("Tally 已锁定").font(.title3.bold())
                Button {
                    Task { await lockService.unlock() }
                } label: {
                    Label("解锁", systemImage: "faceid")
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .task { await lockService.unlock() }
    }
}

// 新账号/旧“用户”账号：短信验证通过后必须完成公开昵称设置（一次性 onboarding ticket）
struct NicknameOnboardingView: View {
    @Environment(AppState.self) private var appState
    @State private var nickname = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    // 可用性检查防抖 + 可取消（快速连续输入时只发最后一次请求）
    @State private var availabilityTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "person.text.rectangle")
                .font(.system(size: 56))
                .foregroundColor(.accentColor)
            Text("设置公开昵称").font(.title2.bold())
            Text("昵称仅用于共享账本邀请与成员展示，2–20 个中文/字母/数字/下划线，不能是纯数字")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)

            TextField("公开昵称", text: $nickname)
                .textFieldStyle(.roundedBorder)
                .onChange(of: nickname) { _, value in
                    availabilityTask?.cancel()
                    if value.count < 2 {
                        errorMessage = nil
                        return
                    }
                    availabilityTask = Task { await checkAvailability(value) }
                }
                .onDisappear { availabilityTask?.cancel() }

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
            }

            Button {
                Task { await submit() }
            } label: {
                if isSubmitting {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("完成并进入").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSubmitting || nickname.trimmingCharacters(in: .whitespacesAndNewlines).count < 2)

            Spacer()
        }
        .padding()
        .errorAlert($errorMessage)
    }

    private func checkAvailability(_ value: String) async {
        // 300ms 防抖：避免每敲一个字都打接口
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled { return }
        do {
            let res = try await APIService.shared.checkNicknameAvailability(value)
            guard !Task.isCancelled else { return }
            if !res.available, let reason = res.reason {
                errorMessage = reason
            } else {
                errorMessage = nil
            }
        } catch let error as APIError {
            // 不能吞掉 401：认证类错误要提示，避免用户以为昵称可用
            if case .unauthorized = error {
                errorMessage = "登录状态已失效，请重新登录"
            }
            // 其它错误（网络/限流）不阻塞提交，静默保留当前输入
        } catch {
            // 非 APIError 的底层错误同样不阻塞
        }
    }

    private func submit() async {
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await appState.completeProfile(nickname: nickname.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
