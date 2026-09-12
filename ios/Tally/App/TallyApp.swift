import SwiftUI

@main
struct TallyApp: App {
    @State private var appState = AppState()
    @State private var dataStore = DataStore()
    @State private var sharedLedgerStore = SharedLedgerStore()
    @State private var lockService = LockService()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .environment(dataStore)
                .environment(sharedLedgerStore)
                .environment(lockService)
                .task {
                    // 冷启动锁定：开关开启且本地有会话（不等网络引导完成），
                    // 避免杀进程重开时缓存数据在验证前闪现
                    if KeychainStore.loadToken() != nil {
                        lockService.isAuthenticated = true
                        lockService.lockIfApplicable()
                    }
                    await appState.bootstrap()
                }
                .onChange(of: scenePhase) { _, phase in
                    // 首版不接 APNs：回到前台时统一刷新账本、成员关系和邀请角标。
                    if phase == .active, appState.isAuthenticated {
                        Task { @MainActor in
                            await sharedLedgerStore.refresh()
                            // 有待同步的离线记录时，回前台立即重放（loadAll 内含重放逻辑）
                            if dataStore.pendingSyncCount > 0 {
                                await dataStore.loadAll()
                            }
                        }
                    }
                    // 生物锁：进后台上锁，回前台由 RootView 的锁屏层发起验证
                    if phase == .background {
                        lockService.isAuthenticated = appState.isAuthenticated
                        lockService.lockIfApplicable()
                    }
                }
        }
    }
}
