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

    var selectedYear: Int
    var selectedMonth: Int

    init() {
        let c = Calendar.current
        selectedYear = c.component(.year, from: Date())
        selectedMonth = c.component(.month, from: Date())
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
        } catch {
            isOffline = true
            errorMessage = "网络不可用，当前展示上次同步的缓存数据"
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
            isOffline = true
            errorMessage = error.localizedDescription
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
            isOffline = true
            errorMessage = error.localizedDescription
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
            isOffline = true
            errorMessage = error.localizedDescription
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
            isOffline = true
            errorMessage = error.localizedDescription
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
            isOffline = true
            errorMessage = error.localizedDescription
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
            isOffline = true
            errorMessage = error.localizedDescription
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
            isOffline = true
            errorMessage = error.localizedDescription
        }
    }
}
