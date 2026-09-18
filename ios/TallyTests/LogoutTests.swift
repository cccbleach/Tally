import XCTest
@testable import Tally

// 登出与「退出全部设备」回归：
//
// 历史缺陷：`LocalCache.clearAll()` 定义在 APIService.swift 里却**全仓库从未被调用**，
// `AppState.logout()` 只删 Keychain、只切命名空间，用户的账户/流水/统计缓存会长期留在
// Application Support 里（命名空间隔离防止串读，但不满足"退出即清理"的隐私承诺）。
//
// 本文件锁死三条不变量：
//   1) 本地登出必须清掉**当前命名空间**的缓存，且不得误删其他命名空间的缓存；
//   2) 服务端吊销必须在删除本地令牌**之前**发起（否则接口无 access token 可鉴权）；
//   3) 服务端吊销失败不得阻断本地登出，并且必须如实报告失败（不能假装成功）。
@MainActor
final class LogoutTests: XCTestCase {
    private let cacheNamespaceA = "u-logouttestA-l-personal"
    private let cacheNamespaceB = "u-logouttestB-l-personal"

    override func setUp() async throws {
        KeychainStore.deleteTokens()
        clearTestCaches()
    }

    override func tearDown() async throws {
        KeychainStore.deleteTokens()
        clearTestCaches()
    }

    private func clearTestCaches() {
        for ns in [cacheNamespaceA, cacheNamespaceB] {
            LocalCache.setNamespace(ns)
            LocalCache.clearAll()
        }
    }

    // MARK: - 1) 本地登出清缓存（且不越界清别人）

    func testLogoutClearsCurrentNamespaceCacheButKeepsOtherNamespaces() async {
        LocalCache.setNamespace(cacheNamespaceA)
        LocalCache.save(["A 的账户"], forKey: "accounts")
        XCTAssertNotNil(LocalCache.load([String].self, forKey: "accounts"), "前置条件：A 的缓存应已落盘")

        LocalCache.setNamespace(cacheNamespaceB)
        LocalCache.save(["B 的账户"], forKey: "accounts")

        // 回到 A 的命名空间（App 里由 DataStore.setContext 完成），然后登出
        LocalCache.setNamespace(cacheNamespaceA)
        let state = AppState(auth: MockAuthService())
        state.isAuthenticated = true
        state.pendingOnboardingToken = "onboarding-token"
        KeychainStore.saveTokens(token: "access-token", refreshToken: "refresh-token")

        state.logout()

        XCTAssertNil(
            LocalCache.load([String].self, forKey: "accounts"),
            "登出必须清掉当前用户命名空间下的缓存（clearAll 曾经从未被调用）"
        )
        XCTAssertNil(KeychainStore.loadToken(), "登出必须删除本地 access token")
        XCTAssertNil(KeychainStore.loadRefreshToken(), "登出必须删除本地 refresh token")
        XCTAssertFalse(state.isAuthenticated)
        XCTAssertNil(state.pendingOnboardingToken)

        // 其他命名空间不受影响（不能误删别的用户/账本的缓存）
        LocalCache.setNamespace(cacheNamespaceB)
        XCTAssertNotNil(
            LocalCache.load([String].self, forKey: "accounts"),
            "登出只应清理当前命名空间，不得越界删除其他命名空间的缓存"
        )
    }

    // MARK: - 2) 当前设备登出：fire-and-forget，绝不阻塞本地登出

    func testLogoutRevokesServerSessionBestEffortWithoutBlockingLocalLogout() async {
        let mock = MockAuthService()
        await mock.setLogoutAllMode(.success(1))
        KeychainStore.saveTokens(token: "access-token", refreshToken: "refresh-token")

        let state = AppState(auth: mock)
        state.logout()

        // logout() 是同步返回的：本地令牌必须立刻消失（不等待网络）
        XCTAssertNil(KeychainStore.loadToken(), "本地登出不得等待服务端响应")

        await waitUntil { await mock.logoutCallCount > 0 }
        let calls = await mock.logoutCallCount
        XCTAssertEqual(calls, 1, "应发起一次服务端登出")
        let sentToken = await mock.lastLogoutRefreshToken
        XCTAssertEqual(sentToken, "refresh-token", "应把本地 refresh token 提交给服务端吊销")
    }

    func testLogoutWithoutTokenDoesNotCallServer() async {
        let mock = MockAuthService()
        let state = AppState(auth: mock)

        state.logout()
        try? await Task.sleep(nanoseconds: 50_000_000)

        let calls = await mock.logoutCallCount
        XCTAssertEqual(calls, 0, "本地没有令牌时不该发起无意义的服务端登出（会白拿 401）")
        XCTAssertFalse(state.isAuthenticated)
    }

    // MARK: - 3) 退出全部设备

    func testLogoutAllDevicesRevokesBeforeDeletingTokensAndReportsSuccess() async {
        let mock = MockAuthService()
        await mock.setLogoutAllMode(.success(3))
        KeychainStore.saveTokens(token: "access-token", refreshToken: "refresh-token")
        LocalCache.setNamespace(cacheNamespaceA)
        LocalCache.save(["A 的账户"], forKey: "accounts")

        let state = AppState(auth: mock)
        state.isAuthenticated = true

        let revokedOnServer = await state.logoutAllDevices()

        XCTAssertTrue(revokedOnServer, "服务端吊销成功时应返回 true")
        let calls = await mock.logoutAllCallCount
        XCTAssertEqual(calls, 1, "应调用一次「退出全部设备」接口")
        let hadTokenAtCall = await mock.tokenPresentAtLogoutAllCall
        XCTAssertEqual(
            hadTokenAtCall, true,
            "服务端调用必须发生在删除本地令牌之前——否则请求没有 access token 会被 401"
        )
        XCTAssertNil(KeychainStore.loadToken())
        XCTAssertNil(
            LocalCache.load([String].self, forKey: "accounts"),
            "退出全部设备同样要完成本地缓存清理"
        )
        XCTAssertFalse(state.isAuthenticated)
    }

    func testLogoutAllDevicesFailureStillClearsLocalSessionAndReportsFalse() async {
        let mock = MockAuthService()
        await mock.setLogoutAllMode(.failure)
        KeychainStore.saveTokens(token: "access-token", refreshToken: "refresh-token")
        LocalCache.setNamespace(cacheNamespaceA)
        LocalCache.save(["A 的账户"], forKey: "accounts")

        let state = AppState(auth: mock)
        state.isAuthenticated = true

        let revokedOnServer = await state.logoutAllDevices()

        XCTAssertFalse(revokedOnServer, "服务端吊销失败必须如实返回 false（其他设备仍然有效）")
        XCTAssertNil(KeychainStore.loadToken(), "服务端失败不得阻断本地登出")
        XCTAssertNil(LocalCache.load([String].self, forKey: "accounts"))
        XCTAssertFalse(state.isAuthenticated)
    }

    // MARK: - 工具

    /// 等待条件成立（上限 2s）。用于断言 fire-and-forget 的后台任务最终确实执行了。
    private func waitUntil(timeout: TimeInterval = 2, _ condition: () async -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }
}

/// AuthServicing 替身：记录调用次数、提交的 refresh token，以及"调用时本地是否还有令牌"。
/// 用 actor 是因为 AuthServicing 是 Sendable，actor 天然满足且不需要 @unchecked。
private actor MockAuthService: AuthServicing {
    enum LogoutAllMode: Sendable {
        case success(Int)
        case failure
    }

    private(set) var logoutCallCount = 0
    private(set) var lastLogoutRefreshToken: String?
    private(set) var logoutAllCallCount = 0
    private(set) var tokenPresentAtLogoutAllCall: Bool?

    private var logoutAllMode: LogoutAllMode = .success(0)

    func setLogoutAllMode(_ mode: LogoutAllMode) {
        logoutAllMode = mode
    }

    func logout(refreshToken: String?) async throws -> Bool {
        logoutCallCount += 1
        lastLogoutRefreshToken = refreshToken
        return true
    }

    func logoutAllDevices() async throws -> Int {
        logoutAllCallCount += 1
        tokenPresentAtLogoutAllCall = KeychainStore.loadToken() != nil
        switch logoutAllMode {
        case .success(let count):
            return count
        case .failure:
            throw URLError(.notConnectedToInternet)
        }
    }
}

// MARK: - 离线冷启动（断网时不得掉回登录页）

/// 资料拉取替身：按需返回用户或抛网络错误。
private struct StubProfileService: SessionProfileServing {
    enum Mode: Sendable {
        case user(User)
        case transportFailure
        case unauthorized
    }
    let mode: Mode

    func me() async throws -> User {
        switch mode {
        case .user(let u): return u
        case .transportFailure: throw URLError(.notConnectedToInternet)
        case .unauthorized: throw APIError.unauthorized
        }
    }
}

/// 历史缺陷：/auth/me 遇网络错误时只 return，`isAuthenticated` 保持 false，
/// RootView 于是渲染 LoginView —— 断网启动进不了主界面，本地缓存与离线队列全用不上，
/// 与「离线记账」的承诺矛盾。这里锁死离线恢复的三条不变量。
@MainActor
final class OfflineSessionTests: XCTestCase {
    private let testUser = User(
        id: "offline-user-1", phone: "+8613800000001", nickname: "离线用户",
        nicknameChangeAvailableAt: nil, createdAt: "2026-01-01T00:00:00Z", phoneMasked: nil
    )

    override func setUp() async throws {
        KeychainStore.deleteTokens()
        SessionIdentityCache.clear()
    }

    override func tearDown() async throws {
        KeychainStore.deleteTokens()
        SessionIdentityCache.clear()
    }

    func testTransportFailureKeepsSessionAndEntersOfflineMode() async {
        KeychainStore.saveTokens(token: "access", refreshToken: "refresh")
        SessionIdentityCache.save(user: testUser)

        let state = AppState(auth: MockAuthService(), profile: StubProfileService(mode: .transportFailure))
        await state.bootstrap()

        XCTAssertTrue(state.isAuthenticated, "断网启动必须保留会话（否则掉回登录页，离线缓存读不到）")
        XCTAssertEqual(state.currentUserId, "offline-user-1", "离线也要能给出用户 id，缓存分区依赖它")
        XCTAssertNil(state.user, "离线时资料拉不到，user 保持 nil（界面按占位展示）")
        XCTAssertNotNil(KeychainStore.loadToken(), "网络错误不得删除令牌")
    }

    func testOfflineRestoreRequiresCachedIdentity() async {
        // 只有令牌、没有身份缓存（例如换过设备/清过数据）→ 不能凭令牌假装已登录
        KeychainStore.saveTokens(token: "access", refreshToken: "refresh")

        let state = AppState(auth: MockAuthService(), profile: StubProfileService(mode: .transportFailure))
        await state.bootstrap()

        XCTAssertFalse(state.isAuthenticated, "没有本地身份缓存时应回到登录页")
        XCTAssertNil(state.currentUserId)
    }

    func testUnauthorizedClearsIdentityCache() async {
        KeychainStore.saveTokens(token: "access", refreshToken: "refresh")
        SessionIdentityCache.save(user: testUser)

        let state = AppState(auth: MockAuthService(), profile: StubProfileService(mode: .unauthorized))
        await state.bootstrap()

        XCTAssertFalse(state.isAuthenticated, "401 必须登出")
        XCTAssertNil(KeychainStore.loadToken(), "401 必须删除令牌")
        XCTAssertNil(SessionIdentityCache.load(), "401 必须清掉身份缓存，否则下次断网启动会复活会话")
    }

    func testLogoutClearsCachedIdentityAndLedgerContext() async {
        SessionIdentityCache.save(user: testUser)
        SessionIdentityCache.rememberLedger(userId: testUser.id, ledgerId: "ledger-1")
        XCTAssertNotNil(SessionIdentityCache.lastLedgerId(forUser: testUser.id), "前置条件")

        let state = AppState(auth: MockAuthService())
        state.isAuthenticated = true
        state.logout()

        XCTAssertNil(SessionIdentityCache.load(), "登出必须清身份缓存")
        XCTAssertNil(SessionIdentityCache.lastLedgerId(forUser: testUser.id), "登出必须清账本上下文")
    }

    func testLedgerContextIsScopedToUser() {
        SessionIdentityCache.rememberLedger(userId: "user-A", ledgerId: "ledger-A")
        XCTAssertEqual(SessionIdentityCache.lastLedgerId(forUser: "user-A"), "ledger-A")
        XCTAssertNil(SessionIdentityCache.lastLedgerId(forUser: "user-B"), "换账号不得复用别人的账本上下文")
    }

    func testSetContextFallsBackToRememberedLedgerSoCacheNamespaceMatches() {
        let store = DataStore()
        SessionIdentityCache.rememberLedger(userId: "user-A", ledgerId: "ledger-A")

        // 冷启动：ledgerId 还是 nil，命名空间必须回落到上次的 ledger-A（否则读 "default" 分区扑空）
        store.setContext(userId: "user-A", ledgerId: nil)
        XCTAssertEqual(store.ledgerId, "ledger-A", "冷启动应回落到上次账本")
        LocalCache.save(["缓存的账户"], forKey: "accounts")
        XCTAssertNotNil(LocalCache.load([String].self, forKey: "accounts"))

        // 模拟下次启动再进一次：同样的 setContext 必须落在同一命名空间，缓存才读得到
        let store2 = DataStore()
        store2.setContext(userId: "user-A", ledgerId: nil)
        XCTAssertEqual(
            LocalCache.load([String].self, forKey: "accounts"), ["缓存的账户"],
            "同名空间必须能读到上次写的缓存（离线冷启动可见数据的前提）"
        )
        LocalCache.clearAll()
    }
}
