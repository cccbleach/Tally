import SwiftUI

@main
struct TallyApp: App {
    @State private var appState = AppState()
    @State private var dataStore = DataStore()
    @State private var sharedLedgerStore = SharedLedgerStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .environment(dataStore)
                .environment(sharedLedgerStore)
                .task { await appState.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    // 首版不接 APNs：回到前台时统一刷新账本、成员关系和邀请角标。
                    if phase == .active, appState.isAuthenticated {
                        Task { @MainActor in await sharedLedgerStore.refresh() }
                    }
                }
        }
    }
}
