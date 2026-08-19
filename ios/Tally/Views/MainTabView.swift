import SwiftUI

struct MainTabView: View {
    @Environment(DataStore.self) private var store

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
        .task { await store.loadAll() }
    }
}
