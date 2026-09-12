import Foundation
import Observation

@MainActor
@Observable
final class DataStore {
    var accounts: [Account] = []
    var categories: [Category] = []
    var transactions: [Transaction] = []
    var summary: StatsSummary?
    var trend: [TrendPoint] = []
    var budgetOverview: BudgetOverview?
    var recurring: [RecurringBill] = []
    var isLoading = false
    var errorMessage: String?
    var isOffline = false

    /// 当前账本本位币（统计/预算/负债等聚合金额的折算目标，服务端 BASE_CURRENCY 口径）。
    /// 由 SharedLedgerStore 在账本快照刷新/切换后同步；展示聚合金额时传给 Money.format。
    var baseCurrencyCode = Money.defaultCurrencyCode

    /// 待同步的离线记账条数（断网入队、联网重放后清零），供 UI 展示角标/提示
    var pendingSyncCount = 0

    var selectedYear: Int
    var selectedMonth: Int

    // 当前上下文（用于缓存分区）：登录用户 + 当前账本
    private(set) var userId: String?
    private(set) var ledgerId: String?

    init() {
        let c = Calendar.current
        selectedYear = c.component(.year, from: Date())
        selectedMonth = c.component(.month, from: Date())
        clearState()
    }

    /// 切换上下文（登录/换账号/切账本/退出时调用）：
    /// 先清空内存数据，避免把上一个用户/账本的数据带进新界面，再切换缓存命名空间。
    func setContext(userId: String?, ledgerId: String?) {
        self.userId = userId
        self.ledgerId = ledgerId
        let u = userId ?? "anon"
        let l = ledgerId ?? (userId == nil ? "anon" : "default")
        LocalCache.setNamespace("u-\(u)-l-\(l)")
        clearState()
    }

    /// 由 SharedLedgerStore 在账本快照刷新/切换时同步本位币（统计聚合金额的展示币种）。
    func setBaseCurrency(code: String) {
        baseCurrencyCode = code
    }

    private func clearState() {
        accounts = []
        categories = []
        transactions = []
        summary = nil
        trend = []
        budgetOverview = nil
        recurring = []
        pendingSyncCount = PendingTransactionQueue.count()
    }

    func moveMonth(by delta: Int) {
        var comps = DateComponents()
        comps.year = selectedYear
        comps.month = selectedMonth + delta
        comps.day = 1
        if let d = Calendar.current.date(from: comps) {
            selectedYear = Calendar.current.component(.year, from: d)
            selectedMonth = Calendar.current.component(.month, from: d)
        }
    }

    // 错误分类：真断网→离线；登录过期→明确提示；地址/服务器→各自的提示
    private func classify(_ error: Error) -> (offline: Bool, message: String) {
        if let api = error as? APIError {
            switch api {
            case .unauthorized:
                return (false, "登录已过期，请重新登录")
            case .invalidURL:
                return (false, "服务器配置异常，请稍后重试")
            case .invalidResponse:
                return (false, "服务器响应异常")
            case .http:
                return (false, "服务器暂时不可用，请稍后重试")
            case .server(_, let message):
                return (false, message)
            }
        }
        if error is URLError {
            return (true, "无法连接服务器，请检查网络")
        }
        return (false, error.localizedDescription)
    }

    // 先读本地缓存（离线可用），再尝试网络；成功则刷新缓存，失败则保留缓存并标记离线
    func loadAll() async {
        isLoading = true
        defer { isLoading = false }
        if let a: [Account] = LocalCache.load([Account].self, forKey: "accounts") { accounts = a }
        if let c: [Category] = LocalCache.load([Category].self, forKey: "categories") { categories = c }
        if let t: [Transaction] = LocalCache.load([Transaction].self, forKey: "transactions") { transactions = t }
        if let s: StatsSummary = LocalCache.load(StatsSummary.self, forKey: "summary") { summary = s }
        if let r: [RecurringBill] = LocalCache.load([RecurringBill].self, forKey: "recurring") { recurring = r }
        if let o: BudgetOverview = LocalCache.load(BudgetOverview.self, forKey: "budgetOverview") { budgetOverview = o }
        if let tr: [TrendPoint] = LocalCache.load([TrendPoint].self, forKey: "trend") { trend = tr }

        let range = TallyDate.monthRange(year: selectedYear, month: selectedMonth)
        do {
            async let a = APIService.shared.accounts()
            async let c = APIService.shared.categories()
            async let t = APIService.shared.transactions(from: range.from, to: range.to, accountId: nil, categoryId: nil, type: nil)
            async let s = APIService.shared.summary(year: selectedYear, month: selectedMonth)
            async let r = APIService.shared.recurring()
            async let bo = APIService.shared.budgetOverview(year: selectedYear, month: selectedMonth)
            async let tr = APIService.shared.trend(months: 6)
            let (accounts, categories, tx, summary, recurring, overview, trend) = try await (a, c, t, s, r, bo, tr)
            self.accounts = accounts
            self.categories = categories
            self.transactions = tx.items
            self.summary = summary
            self.recurring = recurring
            self.budgetOverview = overview
            self.trend = trend
            LocalCache.save(accounts, forKey: "accounts")
            LocalCache.save(categories, forKey: "categories")
            LocalCache.save(tx.items, forKey: "transactions")
            LocalCache.save(summary, forKey: "summary")
            LocalCache.save(recurring, forKey: "recurring")
            LocalCache.save(overview, forKey: "budgetOverview")
            LocalCache.save(trend, forKey: "trend")
            isOffline = false
            errorMessage = nil
            // 网络已恢复：重放离线期间入队的记账（带幂等键，不会重复入账）。
            // 重放可能改变流水/汇总 → 成功后重拉一次列表与统计。
            let syncOutcome = await OfflineTransactionSyncer.sync()
            pendingSyncCount = syncOutcome.remaining
            if syncOutcome.synced > 0 || syncOutcome.dropped > 0 {
                async let t = APIService.shared.transactions(from: range.from, to: range.to, accountId: nil, categoryId: nil, type: nil)
                async let s = APIService.shared.summary(year: selectedYear, month: selectedMonth)
                if let refreshed = try? await (t, s) {
                    transactions = refreshed.0.items
                    self.summary = refreshed.1
                    LocalCache.save(refreshed.0.items, forKey: "transactions")
                    LocalCache.save(refreshed.1, forKey: "summary")
                }
            }
            if syncOutcome.dropped > 0 {
                errorMessage = "\(syncOutcome.dropped) 笔离线记录被服务器拒绝：\(syncOutcome.firstDropReason ?? "未知原因")"
            }
        } catch {
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
            pendingSyncCount = PendingTransactionQueue.count()
        }
    }

    func refreshAccounts() async {
        do {
            let value = try await APIService.shared.accounts()
            accounts = value
            LocalCache.save(value, forKey: "accounts")
            isOffline = false
        } catch {
            if let value: [Account] = LocalCache.load([Account].self, forKey: "accounts") { accounts = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }

    func refreshCategories() async {
        do {
            let value = try await APIService.shared.categories()
            categories = value
            LocalCache.save(value, forKey: "categories")
            isOffline = false
        } catch {
            if let value: [Category] = LocalCache.load([Category].self, forKey: "categories") { categories = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }

    func refreshTransactions() async {
        let range = TallyDate.monthRange(year: selectedYear, month: selectedMonth)
        do {
            let tx = try await APIService.shared.transactions(from: range.from, to: range.to, accountId: nil, categoryId: nil, type: nil)
            transactions = tx.items
            LocalCache.save(tx.items, forKey: "transactions")
            isOffline = false
        } catch {
            if let value: [Transaction] = LocalCache.load([Transaction].self, forKey: "transactions") { transactions = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }

    func refreshSummary() async {
        do {
            let value = try await APIService.shared.summary(year: selectedYear, month: selectedMonth)
            summary = value
            LocalCache.save(value, forKey: "summary")
            isOffline = false
        } catch {
            if let value: StatsSummary = LocalCache.load(StatsSummary.self, forKey: "summary") { summary = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }

    func refreshBudgetOverview() async {
        do {
            let value = try await APIService.shared.budgetOverview(year: selectedYear, month: selectedMonth)
            budgetOverview = value
            LocalCache.save(value, forKey: "budgetOverview")
            isOffline = false
        } catch {
            if let value: BudgetOverview = LocalCache.load(BudgetOverview.self, forKey: "budgetOverview") { budgetOverview = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }

    func refreshRecurring() async {
        do {
            let value = try await APIService.shared.recurring()
            recurring = value
            LocalCache.save(value, forKey: "recurring")
            isOffline = false
        } catch {
            if let value: [RecurringBill] = LocalCache.load([RecurringBill].self, forKey: "recurring") { recurring = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }

    func refreshTrend() async {
        do {
            let value = try await APIService.shared.trend(months: 6)
            trend = value
            LocalCache.save(value, forKey: "trend")
            isOffline = false
        } catch {
            if let value: [TrendPoint] = LocalCache.load([TrendPoint].self, forKey: "trend") { trend = value }
            let r = classify(error)
            isOffline = r.offline
            errorMessage = r.message
        }
    }
}
