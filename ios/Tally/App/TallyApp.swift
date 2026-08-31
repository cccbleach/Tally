import SwiftUI

@main
struct TallyApp: App {
    @State private var appState = AppState()
    @State private var dataStore = DataStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .environment(dataStore)
                .task { await appState.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    // 回到前台 / 启动完成时拉取邀请箱（首版不接 APNs）
                    if phase == .active {
                        Task { @MainActor in await appState.refreshPendingInvitations() }
                    }
                }
        }
    }
}
