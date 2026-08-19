import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            if appState.isLoading {
                ProgressView("加载中…")
            } else if appState.isAuthenticated {
                MainTabView()
            } else {
                LoginView()
            }
        }
    }
}
