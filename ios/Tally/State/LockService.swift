import Foundation
import LocalAuthentication
import Observation

// 生物锁（在线版）：进入后台即上锁，回前台用 Face ID / Touch ID / 设备密码解锁。
//
// 依赖抽协议（与 AuthServicing 同套路）：生物识别是系统 IO，单测注入替身；
// 锁的触发条件（开关 + 已登录）全部是纯逻辑，可完全覆盖。

/// 系统生物识别能力（生产实现 + 测试替身）
protocol BiometricAuthenticating: Sendable {
    /// 设备是否支持任何解锁方式（生物识别或设备密码）
    var canAuthenticate: Bool { get }
    /// 弹系统验证。返回 false = 用户取消/失败（不区分，统一留在锁屏）
    func authenticate(reason: String) async -> Bool
}

struct SystemBiometricAuthenticator: BiometricAuthenticating {
    var canAuthenticate: Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
    }

    func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return false
        }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
                continuation.resume(returning: success)
            }
        }
    }
}

@MainActor
@Observable
final class LockService {
    /// 开关持久化在 UserDefaults（AppStorage 同 key）
    static let enabledKey = "biometricLockEnabled"

    var isLocked = false

    /// 未登录时不上锁：登录页本身挡住了数据，避免「锁屏盖在登录页上」的怪异体验
    var isAuthenticated = false

    private let authenticator: any BiometricAuthenticating
    private var isUnlocking = false

    init(authenticator: any BiometricAuthenticating = SystemBiometricAuthenticator()) {
        self.authenticator = authenticator
    }

    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    var deviceSupportsLock: Bool {
        authenticator.canAuthenticate
    }

    /// 上锁条件满足时锁定：进后台、冷启动（有本地会话）时调用。
    /// 条件：开关开启 && 已登录 && 当前未锁。
    func lockIfApplicable() {
        if isEnabled && isAuthenticated && !isLocked {
            isLocked = true
        }
    }

    /// 解锁（重入保护：验证面板只弹一个）
    func unlock() async {
        guard isLocked, !isUnlocking else { return }
        isUnlocking = true
        defer { isUnlocking = false }
        if await authenticator.authenticate(reason: "解锁查看你的账本") {
            isLocked = false
        }
        // 失败/取消：保持锁定，用户可再点按钮重试
    }
}
