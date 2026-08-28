//
//  RootView.swift
//  Tally
//
//  Top-level gate: onboarding → privacy lock → main tabs.
//

import SwiftUI
import SwiftData

public struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Query private var settingsList: [AppSettings]
    @State private var appState = AppState()

    private var settings: AppSettings? { settingsList.first }

    /// Pure first-frame decision, computed so it can be regression-tested.
    private var resolvedRoute: RootRoute {
        RootRouteResolver.route(
            settingsLoaded: settings != nil,
            hasCompletedOnboarding: settings?.hasCompletedOnboarding ?? false,
            biometricLockEnabled: settings?.biometricLockEnabled ?? false,
            isLocked: appState.isLocked
        )
    }

    public init() {}

    public var body: some View {
        Group {
            switch resolvedRoute {
            case .loading:
                // Settings have not loaded yet. Stay on a neutral blank so no
                // account content can flash before the onboarding/privacy gate
                // decides what to show.
                ZStack {
                    Color(.systemBackground)
                    ProgressView()
                }
                .ignoresSafeArea()
            case .onboarding:
                OnboardingView()
            case .locked:
                LockView { authenticated in
                    withAnimation { appState.handleAuthenticationResult(authenticated) }
                }
            case .main:
                MainTabView()
                    .environment(appState)
            }
        }
        .task {
            // Apply persisted appearance.
            applyAppearance(settings)
            // Read selected ledger into app state.
            if let settings, appState.selectedLedgerID == nil {
                appState.selectedLedgerID = settings.defaultLedgerID
            }
            appState.lockIfNeeded(isEnabled: settings?.biometricLockEnabled == true)
        }
        .task(id: settingsList.map(\.appearanceRaw)) {
            applyAppearance(settingsList.first)
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .inactive || newPhase == .background {
                appState.lockIfNeeded(isEnabled: settings?.biometricLockEnabled == true)
            }
        }
    }

    private func applyAppearance(_ settings: AppSettings?) {
        guard let settings else { return }
        switch settings.appearance {
        case .system:
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                scene.windows.forEach { $0.overrideUserInterfaceStyle = .unspecified }
            }
        case .light:
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                scene.windows.forEach { $0.overrideUserInterfaceStyle = .light }
            }
        case .dark:
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                scene.windows.forEach { $0.overrideUserInterfaceStyle = .dark }
            }
        }
    }
}
