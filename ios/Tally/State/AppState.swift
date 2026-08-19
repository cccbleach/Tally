import Foundation
import Observation

@MainActor
@Observable
final class AppState {
    var user: User?
    var isAuthenticated = false
    var isLoading = true

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
        if KeychainStore.loadToken() != nil {
            do {
                user = try await APIService.shared.me()
                isAuthenticated = true
            } catch {
                KeychainStore.deleteToken()
                user = nil
                isAuthenticated = false
            }
        }
        isLoading = false
    }

    func login(email: String, password: String) async throws {
        let res = try await APIService.shared.login(email: email, password: password)
        KeychainStore.saveTokens(token: res.token, refreshToken: res.refreshToken)
        user = res.user
        isAuthenticated = true
    }

    func register(email: String, password: String, displayName: String) async throws {
        let res = try await APIService.shared.register(email: email, password: password, displayName: displayName)
        KeychainStore.saveTokens(token: res.token, refreshToken: res.refreshToken)
        user = res.user
        isAuthenticated = true
    }

    func logout() {
        KeychainStore.deleteTokens()
        user = nil
        isAuthenticated = false
    }
}
