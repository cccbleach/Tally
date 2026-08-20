import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var appState
    @Environment(DataStore.self) private var dataStore

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
        .onChange(of: appState.user?.id) { _, newUser in
            // 换账号/退出登录时：清空内存并切换缓存命名空间，避免串数据
            if appState.isAuthenticated {
                dataStore.setContext(userId: newUser, ledgerId: dataStore.ledgerId)
            } else {
                dataStore.setContext(userId: nil, ledgerId: nil)
            }
        }
    }
}
