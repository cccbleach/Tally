import Foundation
import Observation

@MainActor
@Observable
final class AppState {
    var user: User?
    var isAuthenticated = false
    var isLoading = true
    // 新账号/旧“用户”账号：验证码通过后进入强制昵称设置
    var needsNicknameSetup = false
    var pendingOnboardingToken: String?

    private var sessionObserver: NSObjectProtocol?

    init() {
        // 统一处理认证失效：任何接口最终 401（含刷新失败）都会触发登出
        // 观察者随 App 生命周期存在，无需显式移除
        sessionObserver = NotificationCenter.default.addObserver(
            forName: .tallySessionExpired,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.logout() }
        }
    }

    func bootstrap() async {
        // 登录成功后视图重建可能再次触发 bootstrap，不要在已登录状态上反复拉取/清空
        if isAuthenticated { isLoading = false; return }
        if KeychainStore.loadToken() != nil {
            do {
                user = try await APIService.shared.me()
                isAuthenticated = true
            } catch {
                guard let api = error as? APIError else {
                    // 网络类错误不登出（保留已有会话），避免“刚登录就被踢回登录页”
                    isLoading = false
                    return
                }
                if case .unauthorized = api {
                    KeychainStore.deleteTokens()
                    user = nil
                    isAuthenticated = false
                }
            }
        }
        isLoading = false
    }

    func loginWithCode(phone: String, code: String) async throws {
        let res = try await APIService.shared.loginWithCode(phone: phone, code: code)
        if res.status == "authenticated", let u = res.user, let token = res.token, let refresh = res.refreshToken {
            KeychainStore.saveTokens(token: token, refreshToken: refresh)
            APIClient.resetSessionExpiredState()
            user = u
            needsNicknameSetup = false
            pendingOnboardingToken = nil
            isAuthenticated = true
        } else {
            // 新账号/旧“用户”账号：进入强制昵称设置
            needsNicknameSetup = true
            pendingOnboardingToken = res.onboardingToken
            isAuthenticated = false
        }
    }

    func completeProfile(nickname: String) async throws {
        guard let token = pendingOnboardingToken else {
            throw APIError.invalidResponse
        }
        let res = try await APIService.shared.completeProfile(onboardingToken: token, nickname: nickname)
        KeychainStore.saveTokens(token: res.token, refreshToken: res.refreshToken)
        APIClient.resetSessionExpiredState()
        user = res.user
        needsNicknameSetup = false
        pendingOnboardingToken = nil
        isAuthenticated = true
    }

    func logout() {
        KeychainStore.deleteTokens()
        user = nil
        needsNicknameSetup = false
        pendingOnboardingToken = nil
        isAuthenticated = false
    }
}
