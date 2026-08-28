//
//  MainTabView.swift
//  Tally
//

import SwiftUI

public struct MainTabView: View {
    public init() {}

    public var body: some View {
        TabView {
            HomeView()
                .tabItem { Label("首页", systemImage: "house.fill") }
            TransactionListView()
                .tabItem { Label("明细", systemImage: "list.bullet.rectangle") }
            StatsView()
                .tabItem { Label("统计", systemImage: "chart.pie.fill") }
            BudgetsView()
                .tabItem { Label("预算", systemImage: "target") }
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape.fill") }
        }
    }
}
