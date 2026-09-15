//
//  BiometricToggleTests.swift
//  TallyTests
//
//  Deterministic tests for the biometric-lock toggle race guard. A stale
//  authentication result from an earlier toggle must never override a newer
//  toggle intent.
//

import Testing
import Foundation
@testable import Tally

@Suite("Biometric Toggle Race")
@MainActor
struct BiometricToggleRaceTests {

    /// Test double that lets the test control exactly when each authentication
    /// prompt returns, so the race is exercised deterministically.
    private final class AuthGate {
        private var continuations: [CheckedContinuation<Bool, Never>] = []
        private(set) var pendingCount = 0

        func makeAuthenticator() -> (String) async -> Bool {
            { [self] _ in
                pendingCount += 1
                return await withCheckedContinuation { continuation in
                    continuations.append(continuation)
                }
            }
        }

        func completePending(with result: Bool) {
            let pending = continuations
            continuations.removeAll()
            for continuation in pending {
                continuation.resume(returning: result)
            }
        }
    }

    /// 轮询等待条件成立；返回是否在超时前成立。
    ///
    /// 为什么不再用 `Task.yield()` 自旋（原实现）：`yield()` 是纯协作式让出，可能在**微秒级**
    /// 跑完数百次，而被 `CheckedContinuation.resume` 唤醒的后续任务还没被调度到——
    /// CI runner 负载高时必然踩到（本地通过、CI 失败就是这个原因）。
    /// 更糟的是原实现超时后**静默返回**，测试继续跑到 `array[0]` 越界，
    /// 直接让整个测试进程崩溃（表现为 job 硬失败 exit 65，而不是一条普通断言失败）。
    /// 现在改为「真实时间等待 + 轮询」，并把超时结果交给调用方显式断言。
    @discardableResult
    private func waitUntil(timeout: TimeInterval = 10, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline { return false }
            // 真实让出执行权（1ms），确保其它任务有机会推进
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return true
    }

    /// 让调度器再真实地跑一小段，用于断言"不会再有第二次 apply"这类稳定态。
    private func settle(_ milliseconds: UInt64 = 50) async {
        try? await Task.sleep(nanoseconds: milliseconds * 1_000_000)
    }

    @Test("A stale enable-authentication result never overrides a newer disable")
    func staleEnableCannotOverrideNewerDisable() async {
        let coordinator = BiometricToggleCoordinator()
        let gate = AuthGate()
        var applied: [(Bool, Bool, Bool)] = []

        // User toggles ON; the prompt stays pending.
        coordinator.run(previouslyEnabled: false, desired: true, authenticate: gate.makeAuthenticator()) { w, e, d in
            applied.append((w, e, d))
        }
        // Before the prompt returns the user turns it OFF.
        coordinator.run(previouslyEnabled: false, desired: false, authenticate: gate.makeAuthenticator()) { w, e, d in
            applied.append((w, e, d))
        }

        // Let the OFF transition (which needs no auth) apply.
        let offApplied = await waitUntil { !applied.isEmpty }
        #expect(offApplied, "OFF 无需认证，应被应用；实际 applied=\(applied)")
        #expect(applied.count == 1, "此时应恰好应用一次；实际 applied=\(applied)")

        // Now the stale ON prompt finally succeeds — it must be discarded.
        gate.completePending(with: true)
        // 让过期的 ON 任务有机会（正确地）丢弃自己
        await settle()

        #expect(applied.count == 1, "过期 ON 结果不得覆盖较新的 OFF；实际 applied=\(applied)")
        let onlyApplied = applied.first
        #expect(onlyApplied?.0 == false) // wasEnabled
        #expect(onlyApplied?.1 == false) // effective: OFF wins
        #expect(onlyApplied?.2 == false) // desired: OFF
    }

    @Test("The latest enable wins when toggling ON→OFF→ON rapidly")
    func latestEnableWinsAfterRapidToggles() async {
        let coordinator = BiometricToggleCoordinator()
        let gate = AuthGate()
        var applied: [(Bool, Bool, Bool)] = []

        // Three rapid toggles: ON (pending), OFF, ON (pending). Every `run`
        // bumps the generation synchronously, so the intermediate OFF is already
        // stale (a newer ON fired) and must never be applied; only the final,
        // newest ON may win.
        coordinator.run(previouslyEnabled: false, desired: true, authenticate: gate.makeAuthenticator()) { w, e, d in applied.append((w, e, d)) }
        coordinator.run(previouslyEnabled: false, desired: false, authenticate: gate.makeAuthenticator()) { w, e, d in applied.append((w, e, d)) }
        coordinator.run(previouslyEnabled: false, desired: true, authenticate: gate.makeAuthenticator()) { w, e, d in applied.append((w, e, d)) }

        // No apply has happened yet (nothing has run).
        #expect(applied.isEmpty)

        // Wait for the two ON prompts (first and last toggle) to reach their
        // pending continuation. The intermediate OFF needs no auth and would be
        // discarded as stale, so nothing is applied before the prompts resolve.
        let promptsPending = await waitUntil { gate.pendingCount == 2 }
        #expect(promptsPending, "两个 ON 的认证提示都应进入 pending；实际 pendingCount=\(gate.pendingCount)")
        #expect(applied.isEmpty, "认证返回前不应有任何 apply；实际 applied=\(applied)")

        // Both pending prompts succeed. The first (oldest) ON and the
        // intermediate OFF are both stale; only the final ON may be applied.
        gate.completePending(with: true)
        let newestApplied = await waitUntil { !applied.isEmpty }
        #expect(newestApplied, "最新的 ON 应被应用；实际 applied=\(applied)")
        // 再等一小段真实时间，确认不会出现第二次 apply
        await settle()

        let enables = applied.filter { $0.2 }
        #expect(enables.count == 1, "应恰好应用一次开启；实际 applied=\(applied)")
        #expect(enables.first?.1 == true, "应用结果应为开启；实际 applied=\(applied)")
        // Final state — exactly one apply: the newest ON.
        #expect(applied.count == 1, "应恰好 apply 一次（只有最新的 ON 胜出）；实际 applied=\(applied)")
        #expect(applied.last?.1 == true, "最终状态应为开启；实际 applied=\(applied)")
    }

    @Test("Initial true→OFF→ON re-locks after successful authentication")
    func initialTrueOffOnRelocksAfterAuthentication() async {
        let coordinator = BiometricToggleCoordinator()
        let gate = AuthGate()
        var biometricLockEnabled = true
        let appState = AppState(isLocked: false)
        var lastWasEnabled: Bool?
        var appliedCount = 0

        // The app was unlocked earlier in this session but the biometric
        // setting is still enabled. The user turns OFF ...
        coordinator.run(
            previouslyEnabled: biometricLockEnabled,
            desired: false,
            authenticate: gate.makeAuthenticator()
        ) { wasEnabled, effective, _ in
            biometricLockEnabled = effective
            appState.handleBiometricSettingChange(
                wasEnabled: wasEnabled,
                isEnabled: biometricLockEnabled
            )
            lastWasEnabled = wasEnabled
            appliedCount += 1
        }

        // ... and, before the deferred OFF task runs, taps ON again. The
        // persisted value is still `true`, which is exactly the race that used
        // to produce a `true → true` apply and leave the app unlocked.
        coordinator.run(
            previouslyEnabled: biometricLockEnabled,
            desired: true,
            authenticate: gate.makeAuthenticator()
        ) { wasEnabled, effective, _ in
            biometricLockEnabled = effective
            appState.handleBiometricSettingChange(
                wasEnabled: wasEnabled,
                isEnabled: biometricLockEnabled
            )
            lastWasEnabled = wasEnabled
            appliedCount += 1
        }

        // The ON prompt is pending; the superseded OFF task must be dropped, so
        // nothing has been persisted or applied yet.
        let onPromptPending = await waitUntil { gate.pendingCount == 1 }
        #expect(onPromptPending, "ON 的认证提示应进入 pending；实际 pendingCount=\(gate.pendingCount)")
        #expect(biometricLockEnabled == true)
        #expect(appState.isLocked == false)

        // Successful authentication must be treated as a re-enable (false →
        // true) and immediately re-lock the app.
        gate.completePending(with: true)
        let appliedOnce = await waitUntil { appliedCount == 1 }
        #expect(appliedOnce, "认证成功后应恰好应用一次；实际 appliedCount=\(appliedCount)")
        await settle()

        #expect(appliedCount == 1, "应恰好应用一次；实际 appliedCount=\(appliedCount)")
        #expect(lastWasEnabled == false)
        #expect(biometricLockEnabled == true)
        #expect(appState.isLocked == true)
        #expect(RootRouteResolver.route(
            settingsLoaded: true,
            hasCompletedOnboarding: true,
            biometricLockEnabled: biometricLockEnabled,
            isLocked: appState.isLocked
        ) == .locked)
    }
}
