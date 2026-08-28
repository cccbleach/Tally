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

    private func yieldUntil(timeoutTicks: Int = 500, _ condition: () -> Bool) async {
        for _ in 0..<timeoutTicks where !condition() {
            await Task.yield()
        }
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
        await yieldUntil { !applied.isEmpty }
        #expect(applied.count == 1)

        // Now the stale ON prompt finally succeeds — it must be discarded.
        gate.completePending(with: true)
        await yieldUntil { applied.count >= 1 }
        // Allow the stale task to (correctly) drop itself.
        for _ in 0..<20 { await Task.yield() }

        #expect(applied.count == 1)
        let onlyApplied = applied[0]
        #expect(onlyApplied.0 == false) // wasEnabled
        #expect(onlyApplied.1 == false) // effective: OFF wins
        #expect(onlyApplied.2 == false) // desired: OFF
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
        await yieldUntil { gate.pendingCount == 2 }
        #expect(gate.pendingCount == 2)
        #expect(applied.isEmpty)

        // Both pending prompts succeed. The first (oldest) ON and the
        // intermediate OFF are both stale; only the final ON may be applied.
        gate.completePending(with: true)
        await yieldUntil { !applied.isEmpty }
        for _ in 0..<30 { await Task.yield() }

        let enables = applied.filter { $0.2 }
        #expect(enables.count == 1)
        #expect(enables[0].1 == true)
        // Final state — exactly one apply: the newest ON.
        #expect(applied.count == 1)
        #expect(applied.last?.1 == true)
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
        await yieldUntil { gate.pendingCount == 1 }
        #expect(biometricLockEnabled == true)
        #expect(appState.isLocked == false)

        // Successful authentication must be treated as a re-enable (false →
        // true) and immediately re-lock the app.
        gate.completePending(with: true)
        await yieldUntil { appliedCount == 1 }
        for _ in 0..<30 { await Task.yield() }

        #expect(appliedCount == 1)
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
