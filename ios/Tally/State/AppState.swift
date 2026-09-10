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

    /// 退出登录：
    /// 1) 先调用服务端登出吊销 refresh 会话（best-effort：网络失败也必须完成本地登出）；
    /// 2) 清空本地文件缓存——必须在命名空间仍是当前用户时清理，否则会清错命名空间、
    ///    把该用户的账户/流水/统计缓存长期留在 Application Support 里；
    /// 3) 最后删除 Keychain 令牌并重置内存状态。
    /// 顺序很关键：令牌要先于删除被读到，缓存要先于任何命名空间切换被清掉。
    func logout() {
        let refreshToken = KeychainStore.loadRefreshToken()
        let hadToken = KeychainStore.loadToken() != nil

        if hadToken {
            // 不等待结果、不因失败回滚本地登出：服务端吊销是"尽力而为"的加固手段
            Task {
                do {
                    try await APIService.shared.logout(refreshToken: refreshToken)
                } catch {
                    // 网络不可用/会话已过期都无需打扰用户，本地登出照常完成
                }
            }
        }

        LocalCache.clearAll()
        KeychainStore.deleteTokens()
        user = nil
        needsNicknameSetup = false
        pendingOnboardingToken = nil
        isAuthenticated = false
    }
}
