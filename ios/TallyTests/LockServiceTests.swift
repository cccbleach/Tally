import XCTest
@testable import Tally

// 生物锁状态机回归：
//   1) 只有「开关开启 + 已登录」才会在满足条件时上锁（进后台/冷启动）（登录页自身即门槛，不叠加锁屏）；
//   2) 解锁成功才放行；失败/取消保持锁定；
//   3) 验证面板不重入（并发 unlock 只弹一次系统验证）。
@MainActor
final class LockServiceTests: XCTestCase {

    override func setUp() async throws {
        UserDefaults.standard.removeObject(forKey: LockService.enabledKey)
    }

    override func tearDown() async throws {
        UserDefaults.standard.removeObject(forKey: LockService.enabledKey)
    }

    private func enableLock() {
        UserDefaults.standard.set(true, forKey: LockService.enabledKey)
    }

    func testBackgroundLocksOnlyWhenEnabledAndAuthenticated() {
        // 关闭开关：不上锁
        let service = LockService(authenticator: MockBiometricAuthenticator(canAuthenticate: true, result: true))
        service.isAuthenticated = true
        service.lockIfApplicable()
        XCTAssertFalse(service.isLocked, "开关关闭时进后台不应上锁")

        // 开启但未登录：不上锁
        enableLock()
        service.isAuthenticated = false
        service.lockIfApplicable()
        XCTAssertFalse(service.isLocked, "登录页自身即门槛，不应在未登录时叠加锁屏")

        // 开启且已登录：上锁
        service.isAuthenticated = true
        service.lockIfApplicable()
        XCTAssertTrue(service.isLocked)
    }

    func testUnlockSucceedsAndFails() async {
        enableLock()
        let mock = MockBiometricAuthenticator(canAuthenticate: true, result: false)
        let service = LockService(authenticator: mock)
        service.isAuthenticated = true
        service.lockIfApplicable()

        await service.unlock()
        XCTAssertTrue(service.isLocked, "验证失败/取消必须保持锁定")

        mock.result = true
        await service.unlock()
        XCTAssertFalse(service.isLocked, "验证成功应解锁")
    }

    func testConcurrentUnlockTriggersSingleAuthentication() async {
        enableLock()
        let mock = MockBiometricAuthenticator(canAuthenticate: true, result: true)
        let service = LockService(authenticator: mock)
        service.isAuthenticated = true
        service.lockIfApplicable()

        // 两个并发 unlock（锁屏层 task 触发 + 用户手点）：系统验证面板只能弹一个
        async let first = service.unlock()
        async let second = service.unlock()
        _ = await (first, second)

        XCTAssertFalse(service.isLocked)
        XCTAssertEqual(mock.callCount, 1, "重入保护：并发解锁只发起一次系统验证")
    }

    func testDeviceSupportsLockReflectsAuthenticator() {
        XCTAssertFalse(LockService(authenticator: MockBiometricAuthenticator(canAuthenticate: false, result: false)).deviceSupportsLock)
        XCTAssertTrue(LockService(authenticator: MockBiometricAuthenticator(canAuthenticate: true, result: false)).deviceSupportsLock)
    }
}

/// 生物识别替身：可配置结果，可变（测试中途切换成功/失败）
private final class MockBiometricAuthenticator: BiometricAuthenticating, @unchecked Sendable {
    let canAuthenticate: Bool
    var result: Bool
    private let lock = NSLock()
    private(set) var callCountStorage = 0

    var callCount: Int {
        lock.lock(); defer { lock.unlock() }
        return callCountStorage
    }

    init(canAuthenticate: Bool, result: Bool) {
        self.canAuthenticate = canAuthenticate
        self.result = result
    }

    func authenticate(reason: String) async -> Bool {
        lock.lock()
        callCountStorage += 1
        let value = result
        lock.unlock()
        return value
    }
}
