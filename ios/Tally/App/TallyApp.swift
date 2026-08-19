import SwiftUI

@main
struct TallyApp: App {
    @State private var appState = AppState()
    @State private var dataStore = DataStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .environment(dataStore)
                .task { await appState.bootstrap() }
        }
    }
}
