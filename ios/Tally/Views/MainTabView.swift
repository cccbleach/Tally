import SwiftUI

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @Environment(DataStore.self) private var store
    @Environment(SharedLedgerStore.self) private var sharedLedgerStore

    var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("明细", systemImage: "list.bullet.rectangle") }
            StatsView()
                .tabItem { Label("统计", systemImage: "chart.pie.fill") }
            AccountsView()
                .tabItem { Label("账户", systemImage: "creditcard.fill") }
            BudgetsView()
                .tabItem { Label("预算", systemImage: "target") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape.fill") }
        }
        // 用 currentUserId（离线冷启动时为缓存里的用户 id），保证离线也能绑定到正确的缓存分区
        .task(id: appState.currentUserId) {
            sharedLedgerStore.bind(userId: appState.currentUserId, dataManager: store)
            // 先确认服务端当前账本，再加载对应缓存，避免启动时短暂展示另一个账本的数据。
            let didReload = await sharedLedgerStore.refresh()
            if !didReload {
                await store.loadAll()
            }
        }
    }
}
