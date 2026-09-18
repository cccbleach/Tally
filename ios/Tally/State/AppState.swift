import Foundation
import Observation

/// AppState 需要的认证侧能力。
/// 抽成协议的唯一目的是可测：登出/全端登出必须能在单元测试里注入替身，
/// 而不是直接依赖 `APIService.shared`（与 `SharedLedgerServing` 同一套路子）。
protocol AuthServicing: Sendable {
    /// 吊销当前设备的会话（幂等）。返回是否真的吊销了。
    func logout(refreshToken: String?) async throws -> Bool
    /// 吊销该用户全部会话，返回被吊销数量。
    func logoutAllDevices() async throws -> Int
}

/// AppState.bootstrap 需要的「拉取本人资料」能力。
/// 抽成协议的唯一目的是可测：断网冷启动的离线恢复路径必须能在测试里注入失败，
/// 而不是打真网络（与 AuthServicing 同一套路子）。
protocol SessionProfileServing: Sendable {
    func me() async throws -> User
}

extension APIService: SessionProfileServing {}

@MainActor
@Observable
final class AppState {
    var user: User?
    var isAuthenticated = false
    var isLoading = true
    /// 离线冷启动时从本地身份缓存恢复出的用户 id（在线时保持 nil）
    private(set) var offlineUserId: String?

    /// 当前用户 id：在线来自 `user`，离线冷启动来自本地身份缓存。
    /// 缓存分区与账本绑定都必须用它，否则离线启动会退化成「匿名用户」（读不到自己的缓存）。
    var currentUserId: String? { user?.id ?? offlineUserId }
    // 新账号/旧“用户”账号：验证码通过后进入强制昵称设置
    var needsNicknameSetup = false
    var pendingOnboardingToken: String?

    private var sessionObserver: NSObjectProtocol?

    /// 认证依赖（默认走真实 APIService；测试注入替身）
    private let auth: any AuthServicing
    /// 资料拉取依赖（同上，便于测试离线/失败路径）
    private let profile: any SessionProfileServing

    init(auth: any AuthServicing = APIService.shared, profile: any SessionProfileServing = APIService.shared) {
        self.auth = auth
        self.profile = profile
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
                let me = try await profile.me()
                user = me
                offlineUserId = nil
                SessionIdentityCache.save(user: me)
                isAuthenticated = true
            } catch {
                guard let api = error as? APIError else {
                    // 网络类错误不登出（保留已有会话），避免“刚登录就被踢回登录页”。
                    // 同时尽最大努力进入离线态：断网冷启动必须能进主界面，
                    // 否则本地缓存与离线队列全用不上（详见 SessionIdentityCache 注释）。
                    restoreOfflineSession()
                    isLoading = false
                    return
                }
                if case .unauthorized = api {
                    KeychainStore.deleteTokens()
                    SessionIdentityCache.clear()
                    offlineUserId = nil
                    user = nil
                    isAuthenticated = false
                }
            }
        }
        isLoading = false
    }

    /// 断网启动：用本地身份缓存恢复「已登录但无资料」的会话。
    /// 只有确实登录过（缓存存在）才恢复；恢复后若令牌已失效，全局会话失效监听会统一登出。
    private func restoreOfflineSession() {
        guard let cached = SessionIdentityCache.load() else { return }
        offlineUserId = cached.userId
        isAuthenticated = true
    }

    func loginWithCode(phone: String, code: String) async throws {
        let res = try await APIService.shared.loginWithCode(phone: phone, code: code)
        if res.status == "authenticated", let u = res.user, let token = res.token, let refresh = res.refreshToken {
            KeychainStore.saveTokens(token: token, refreshToken: refresh)
            APIClient.resetSessionExpiredState()
            user = u
            offlineUserId = nil
            SessionIdentityCache.save(user: u)
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
        offlineUserId = nil
        SessionIdentityCache.save(user: res.user)
        needsNicknameSetup = false
        pendingOnboardingToken = nil
        isAuthenticated = true
    }

    /// 退出登录（当前设备）：
    /// 1) 先取到 refresh token 并调用服务端登出吊销会话（best-effort：网络失败也必须完成本地登出）；
    /// 2) 清空本地文件缓存——必须在命名空间仍是当前用户时清理，否则会清错命名空间、
    ///    把该用户的账户/流水/统计缓存长期留在 Application Support 里；
    /// 3) 最后删除 Keychain 令牌并重置内存状态。
    /// 顺序很关键：令牌要先于删除被读到，缓存要先于任何命名空间切换被清掉。
    func logout() {
        let refreshToken = KeychainStore.loadRefreshToken()
        let hadToken = KeychainStore.loadToken() != nil

        if hadToken {
            // 不等待结果、不因失败回滚本地登出：服务端吊销是"尽力而为"的加固手段
            Task { [auth] in
                _ = try? await auth.logout(refreshToken: refreshToken)
            }
        }

        clearLocalSession()
    }

    /// 退出全部设备：吊销该用户在所有设备上的会话（令牌可能在别处泄漏时的兜底手段）。
    /// 返回值表示**服务端是否吊销成功**：
    /// - true  → 其他设备的 refresh token 已失效；
    /// - false → 服务端吊销失败（网络不可用等），但本地登出已完成，其他设备会话仍然有效，
    ///           调用方应提示用户稍后重试（可先改密码类兜底不存在，本项目无密码）。
    /// 注意：必须在删除本地 Keychain 令牌**之前**调用服务端（需要 access token 鉴权），
    /// 因此这里先 await 网络调用，再清本地状态。
    @discardableResult
    func logoutAllDevices() async -> Bool {
        var revoked = false
        if KeychainStore.loadToken() != nil {
            do {
                _ = try await auth.logoutAllDevices()
                revoked = true
            } catch {
                revoked = false
            }
        }
        clearLocalSession()
        return revoked
    }

    /// 本地登出清理：缓存 → 导出临时文件 → 令牌 → 内存状态（顺序不可调换，见 logout 注释）
    private func clearLocalSession() {
        LocalCache.clearAll()
        // 导出的全量流水 CSV 是隐私数据，登出时一并清掉（tmp 不依赖系统清理）
        TransactionCSVExport.clearTemporaryFiles()
        KeychainStore.deleteTokens()
        // 身份缓存必须一起清：否则登出后断网启动会“复活”上一个账号的离线界面
        SessionIdentityCache.clear()
        offlineUserId = nil
        user = nil
        needsNicknameSetup = false
        pendingOnboardingToken = nil
        isAuthenticated = false
    }
}

// MARK: - 离线冷启动用的最小会话身份

/// 只缓存 id + 昵称（不含手机号等 PII，令牌仍只在 Keychain）。
///
/// 为什么必须有它：本地缓存与离线队列按 `u-<userId>` 分区，而断网冷启动时 `/auth/me`
/// 拿不到用户；若恢复不出 userId，RootView 会渲染登录页、DataStore 也读不到该用户的缓存，
/// 「离线记账」在冷启动这一最常见的断网场景下等于失效。
struct CachedSessionIdentity: Codable, Equatable {
    let userId: String
    let nickname: String
}

/// 上次使用的「用户 + 账本」上下文。离线冷启动时账本 id 拿不到，
/// 但缓存是按 `u-<userId>-l-<ledgerId>` 分区的——不记住它就会去读 "default" 分区而扑空。
struct CachedLedgerContext: Codable, Equatable {
    let userId: String
    let ledgerId: String
}

enum SessionIdentityCache {
    private static let key = "tally.session.identity"
    private static let ledgerKey = "tally.session.ledger"

    static func save(user: User) {
        let identity = CachedSessionIdentity(userId: user.id, nickname: user.nickname)
        guard let data = try? JSONEncoder().encode(identity) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func load() -> CachedSessionIdentity? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(CachedSessionIdentity.self, from: data)
    }

    /// 记住当前用户正在使用的账本（切换账本时由 DataStore.setContext 调用）
    static func rememberLedger(userId: String, ledgerId: String) {
        let ctx = CachedLedgerContext(userId: userId, ledgerId: ledgerId)
        guard let data = try? JSONEncoder().encode(ctx) else { return }
        UserDefaults.standard.set(data, forKey: ledgerKey)
    }

    /// 该用户上次使用的账本 id（用户不匹配则返回 nil，避免换账号后串命名空间）
    static func lastLedgerId(forUser userId: String) -> String? {
        guard let data = UserDefaults.standard.data(forKey: ledgerKey),
              let ctx = try? JSONDecoder().decode(CachedLedgerContext.self, from: data),
              ctx.userId == userId else { return nil }
        return ctx.ledgerId
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
        UserDefaults.standard.removeObject(forKey: ledgerKey)
    }
}
