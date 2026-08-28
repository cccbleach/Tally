//
//  AppState.swift
//  Tally
//
//  Lightweight, observable app-level state that is not persisted in SwiftData:
//  which ledger is selected, and whether the privacy lock has been satisfied.
//

import Foundation
import Observation

@Observable
public final class AppState {
    /// The currently selected ledger for this app session. The persisted
    /// default remains an explicit user choice in ledger settings.
    public var selectedLedgerID: UUID?

    /// Privacy lock state.
    public var isLocked: Bool

    public init(selectedLedgerID: UUID? = nil, isLocked: Bool = true) {
        self.selectedLedgerID = selectedLedgerID
        self.isLocked = isLocked
    }

    public func handleAuthenticationResult(_ succeeded: Bool) {
        if succeeded { isLocked = false }
    }

    /// Reacts to a change in the persisted biometric-lock setting.
    ///
    /// The privacy boundary that matters is *re-enabling*: if the user turns
    /// the lock back on in the same foreground session after it was unlocked,
    /// we must lock immediately instead of leaving `isLocked == false` (which
    /// would keep showing main until the next background transition). Disabling
    /// never auto-unlocks or auto-locks; the route resolver simply stops
    /// requiring the lock, and a later re-enable will lock again via the
    /// false → true branch below.
    public func handleBiometricSettingChange(wasEnabled: Bool, isEnabled: Bool) {
        if !wasEnabled && isEnabled {
            isLocked = true
        }
    }

    public func lockIfNeeded(isEnabled: Bool) {
        if isEnabled { isLocked = true }
    }
}

/// Top-level first-frame route decision, extracted as a pure state function so
/// the privacy-gate ordering can be regression-tested without a view or
/// ViewInspector. Order matters:
///   1. settings not loaded → loading (never flash main)
///   2. onboarding not completed → onboarding
///   3. biometric enabled + locked → locked
///   4. otherwise → main
public enum RootRoute: Equatable, Sendable {
    case loading
    case onboarding
    case locked
    case main
}

public enum RootRouteResolver {
    public static func route(
        settingsLoaded: Bool,
        hasCompletedOnboarding: Bool,
        biometricLockEnabled: Bool,
        isLocked: Bool
    ) -> RootRoute {
        guard settingsLoaded else { return .loading }
        guard hasCompletedOnboarding else { return .onboarding }
        if biometricLockEnabled && isLocked { return .locked }
        return .main
    }
}
