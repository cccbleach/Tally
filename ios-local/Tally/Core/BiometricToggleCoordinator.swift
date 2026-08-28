//
//  BiometricToggleCoordinator.swift
//  Tally
//
//  Serializes the asynchronous "enable biometric lock" flow so a stale
//  authentication result can never overwrite a newer toggle intent.
//
//  Every toggle bumps a generation counter synchronously. When the (only)
//  async step — the system authentication prompt — eventually returns, the
//  result is applied only if this toggle is still the most recent one. Rapid
//  ON → OFF → ON therefore cannot let an older prompt result re-enable the
//  lock after the user has already turned it off, nor lose the final ON.
//
//  The coordinator also tracks the *logical* enabled state synchronously, so a
//  disable that is later superseded (and therefore never persisted) is still
//  visible to the next enable as a `false → true` re-enable. This matters for
//  a rapid OFF → ON from an initially-enabled state: the persisted value is
//  still `true` when the second tap fires, and without this bookkeeping the
//  final ON would be seen as `true → true` and never re-lock.
//

import Foundation

/// Runs on the main actor because it both reads/writes the generation counter
/// and hands back results to SwiftUI's `@MainActor` views.
@MainActor
final class BiometricToggleCoordinator {
    private var generation = 0

    /// The logically-current enabled state of the biometric lock as derived
    /// from this session's toggle sequence. `nil` until the first toggle, at
    /// which point the persisted `previouslyEnabled` value is used as the seed.
    private var logicalEnabled: Bool?

    init() {}

    /// Starts one toggle transition.
    ///
    /// - Parameters:
    ///   - previouslyEnabled: the persisted value captured when the toggle fired.
    ///   - desired: the value the user just tapped.
    ///   - authenticate: prompts the user (injectable so the race is testable).
    ///   - apply: receives `(wasEnabled, effective, desired)` and is called at
    ///     most once, only when this turn is still the latest intent.
    func run(
        previouslyEnabled: Bool,
        desired: Bool,
        authenticate: @escaping (String) async -> Bool,
        apply: @escaping (Bool, Bool, Bool) -> Void
    ) {
        generation += 1
        let currentGeneration = generation
        // Derive the previous state from the logically-tracked value, falling
        // back to the persisted snapshot for the very first toggle. A disable
        // is recorded synchronously below so a rapid OFF → ON is seen as a
        // re-enable even if this OFF task is later superseded and never
        // persisted.
        let wasEnabled = logicalEnabled ?? previouslyEnabled
        if !desired {
            logicalEnabled = false
        }
        Task { @MainActor in
            var effective = desired
            if desired {
                let ok = await authenticate("启用生物识别锁定")
                // A newer toggle has fired while the prompt was showing; this
                // result is stale and must be discarded.
                guard currentGeneration == generation else { return }
                effective = ok
            }
            guard currentGeneration == generation else { return }
            logicalEnabled = effective
            apply(wasEnabled, effective, desired)
        }
    }
}
