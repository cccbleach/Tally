import Foundation

// 简单文件缓存：把最近一次拉取的数据落盘，供离线时读取。
// 注意：MVP 单用户语义，键不区分用户；多用户场景建议键前缀带 userId。
enum LocalCache {
    private static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let d = base.appendingPathComponent("TallyCache", isDirectory: true)
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        return d
    }

    private static func url(forKey key: String) -> URL {
        dir.appendingPathComponent(key + ".json")
    }

    static func save<T: Encodable>(_ value: T, forKey key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url(forKey: key), options: .atomic)
    }

    static func load<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let data = try? Data(contentsOf: url(forKey: key)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

// MARK: - 请求体

struct CreateAccountBody: Encodable {
    let name: String
    let type: String
    let currency: String
    let initialBalance: Int
    let icon: String?
    let color: String?
}

struct UpdateAccountBody: Encodable {
    var name: String?
    var type: String?
    var initialBalance: Int?
    var icon: String?
    var color: String?
    var isArchived: Bool?
}

struct CreateCategoryBody: Encodable {
    let name: String
    let type: String
    let icon: String?
    let color: String?
}

struct UpdateCategoryBody: Encodable {
    var name: String?
    var icon: String?
    var color: String?
}

struct CreateTransactionBody: Encodable {
    let type: String
    let amount: Int
    let date: String
    let note: String?
    let currency: String
    let accountId: String
    let categoryId: String?
    let transferToAccountId: String?
}

struct UpdateTransactionBody: Encodable {
    var amount: Int?
    var date: String?
    var note: String?
    var accountId: String?
    var categoryId: String?
}

struct UpsertBudgetBody: Encodable {
    let year: Int
    let month: Int
    let categoryId: String?
    let amount: Int
}

struct CreateRecurringBody: Encodable {
    let accountId: String
    let categoryId: String
    let type: String
    let amount: Int
    let note: String?
    let frequency: String
    let interval: Int
    let startDate: String
    let endDate: String?
}

struct UpdateRecurringBody: Encodable {
    var accountId: String?
    var categoryId: String?
    var amount: Int?
    var note: String?
    var frequency: String?
    var interval: Int?
    var startDate: String?
    var endDate: String?
    var isActive: Bool?
}

// MARK: - 服务

struct APIService {
    static let shared = APIService()
    private let client = APIClient.shared

    // 认证
    func register(email: String, password: String, displayName: String) async throws -> AuthResponse {
        struct Body: Encodable { let email: String; let password: String; let displayName: String }
        return try await client.request("POST", "/api/v1/auth/register", body: Body(email: email, password: password, displayName: displayName))
    }

    func login(email: String, password: String) async throws -> AuthResponse {
        struct Body: Encodable { let email: String; let password: String }
        return try await client.request("POST", "/api/v1/auth/login", body: Body(email: email, password: password))
    }

    func me() async throws -> User {
        let res: UserResponse = try await client.request("GET", "/api/v1/auth/me")
        return res.user
    }

    func refresh() async throws -> RefreshResponse {
        struct Body: Encodable { let refreshToken: String }
        let refresh = KeychainStore.loadRefreshToken() ?? ""
        return try await client.request("POST", "/api/v1/auth/refresh", body: Body(refreshToken: refresh))
    }

    func requestLoginCode(phone: String) async throws -> String? {
        struct Body: Encodable { let email: String }
        struct CodeResponse: Decodable { let ok: Bool; let code: String? }
        let res: CodeResponse = try await client.request("POST", "/api/v1/auth/request-code", body: Body(email: phone))
        return res.code
    }

    func loginWithCode(phone: String, code: String) async throws -> AuthResponse {
        struct Body: Encodable { let email: String; let code: String }
        return try await client.request("POST", "/api/v1/auth/login-code", body: Body(email: phone, code: code))
    }

    // 账户
    func accounts() async throws -> [Account] {
        let res: ListResponse<Account> = try await client.request("GET", "/api/v1/accounts")
        return res.items
    }

    func createAccount(name: String, type: String, currency: String, initialBalance: Int, icon: String?, color: String?) async throws -> Account {
        let body = CreateAccountBody(name: name, type: type, currency: currency, initialBalance: initialBalance, icon: icon, color: color)
        let res: ItemResponse<Account> = try await client.request("POST", "/api/v1/accounts", body: body)
        return res.item
    }

    func updateAccount(id: String, name: String?, type: String?, initialBalance: Int?, icon: String?, color: String?) async throws -> Account {
        let body = UpdateAccountBody(name: name, type: type, initialBalance: initialBalance, icon: icon, color: color, isArchived: nil)
        let res: ItemResponse<Account> = try await client.request("PATCH", "/api/v1/accounts/\(id)", body: body)
        return res.item
    }

    func archiveAccount(id: String) async throws {
        let _: OKResponse = try await client.request("DELETE", "/api/v1/accounts/\(id)")
    }

    // 分类
    func categories() async throws -> [Category] {
        let res: ListResponse<Category> = try await client.request("GET", "/api/v1/categories")
        return res.items
    }

    func createCategory(name: String, type: String, icon: String?, color: String?) async throws -> Category {
        let body = CreateCategoryBody(name: name, type: type, icon: icon, color: color)
        let res: ItemResponse<Category> = try await client.request("POST", "/api/v1/categories", body: body)
        return res.item
    }

    func updateCategory(id: String, name: String?, icon: String?, color: String?) async throws -> Category {
        let body = UpdateCategoryBody(name: name, icon: icon, color: color)
        let res: ItemResponse<Category> = try await client.request("PATCH", "/api/v1/categories/\(id)", body: body)
        return res.item
    }

    func deleteCategory(id: String) async throws {
        let _: OKResponse = try await client.request("DELETE", "/api/v1/categories/\(id)")
    }

    // 流水
    func transactions(from: String?, to: String?, accountId: String?, categoryId: String?, type: String?, page: Int = 1, limit: Int = 200) async throws -> TransactionsResponse {
        var query: [URLQueryItem] = [URLQueryItem(name: "page", value: String(page)), URLQueryItem(name: "limit", value: String(limit))]
        if let from { query.append(URLQueryItem(name: "from", value: from)) }
        if let to { query.append(URLQueryItem(name: "to", value: to)) }
        if let accountId { query.append(URLQueryItem(name: "accountId", value: accountId)) }
        if let categoryId { query.append(URLQueryItem(name: "categoryId", value: categoryId)) }
        if let type { query.append(URLQueryItem(name: "type", value: type)) }
        return try await client.request("GET", "/api/v1/transactions", query: query)
    }

    func createTransaction(type: String, amount: Int, date: String, note: String?, currency: String, accountId: String, categoryId: String?, transferToAccountId: String?) async throws -> Transaction {
        let body = CreateTransactionBody(type: type, amount: amount, date: date, note: note, currency: currency, accountId: accountId, categoryId: categoryId, transferToAccountId: transferToAccountId)
        let res: ItemResponse<Transaction> = try await client.request("POST", "/api/v1/transactions", body: body)
        return res.item
    }

    func updateTransaction(id: String, amount: Int?, date: String?, note: String?, accountId: String?, categoryId: String?) async throws -> Transaction {
        let body = UpdateTransactionBody(amount: amount, date: date, note: note, accountId: accountId, categoryId: categoryId)
        let res: ItemResponse<Transaction> = try await client.request("PATCH", "/api/v1/transactions/\(id)", body: body)
        return res.item
    }

    func deleteTransaction(id: String) async throws {
        let _: OKResponse = try await client.request("DELETE", "/api/v1/transactions/\(id)")
    }

    // 账单导入（微信/支付宝导出的文件原始字节，后端自动识别编码并解析）
    func importBill(source: String, data: Data, force: Bool = false) async throws -> ImportResult {
        struct Body: Encodable { let mode: String; let source: String; let contentBase64: String; let force: Bool }
        return try await client.request(
            "POST",
            "/api/v1/transactions/import",
            body: Body(mode: "raw", source: source, contentBase64: data.base64EncodedString(), force: force)
        )
    }

    // 统计
    func summary(year: Int, month: Int) async throws -> StatsSummary {
        let query = [URLQueryItem(name: "year", value: String(year)), URLQueryItem(name: "month", value: String(month))]
        return try await client.request("GET", "/api/v1/stats/summary", query: query)
    }

    func trend(months: Int) async throws -> [TrendPoint] {
        let res: TrendResponse = try await client.request("GET", "/api/v1/stats/trend", query: [URLQueryItem(name: "months", value: String(months))])
        return res.months
    }

    // 预算
    func budgets(year: Int, month: Int) async throws -> BudgetsResponse {
        let query = [URLQueryItem(name: "year", value: String(year)), URLQueryItem(name: "month", value: String(month))]
        return try await client.request("GET", "/api/v1/budgets", query: query)
    }

    func budgetOverview(year: Int, month: Int) async throws -> BudgetOverview {
        let query = [URLQueryItem(name: "year", value: String(year)), URLQueryItem(name: "month", value: String(month))]
        return try await client.request("GET", "/api/v1/budgets/overview", query: query)
    }

    func upsertBudget(year: Int, month: Int, categoryId: String?, amount: Int) async throws {
        let body = UpsertBudgetBody(year: year, month: month, categoryId: categoryId, amount: amount)
        let _: ItemResponse<Budget> = try await client.request("POST", "/api/v1/budgets", body: body)
    }

    // 周期账单
    func recurring() async throws -> [RecurringBill] {
        let res: ListResponse<RecurringBill> = try await client.request("GET", "/api/v1/recurring")
        return res.items
    }

    func createRecurring(accountId: String, categoryId: String, type: String, amount: Int, note: String?, frequency: String, interval: Int, startDate: String, endDate: String?) async throws -> RecurringBill {
        let body = CreateRecurringBody(accountId: accountId, categoryId: categoryId, type: type, amount: amount, note: note, frequency: frequency, interval: interval, startDate: startDate, endDate: endDate)
        let res: ItemResponse<RecurringBill> = try await client.request("POST", "/api/v1/recurring", body: body)
        return res.item
    }

    func updateRecurring(id: String, body: UpdateRecurringBody) async throws -> RecurringBill {
        let res: ItemResponse<RecurringBill> = try await client.request("PATCH", "/api/v1/recurring/\(id)", body: body)
        return res.item
    }

    func deleteRecurring(id: String) async throws {
        let _: OKResponse = try await client.request("DELETE", "/api/v1/recurring/\(id)")
    }

    // 家庭 / 账本
    func families() async throws -> [Family] {
        let res: ListResponse<Family> = try await client.request("GET", "/api/v1/families")
        return res.items
    }

    func createFamily(name: String) async throws -> FamilyCreateItem {
        struct Body: Encodable { let name: String }
        let res: FamilyCreateResponse = try await client.request("POST", "/api/v1/families", body: Body(name: name))
        return res.item
    }

    func addFamilyMember(familyId: String, account: String) async throws {
        struct Body: Encodable { let account: String }
        let _: OKResponse = try await client.request("POST", "/api/v1/families/\(familyId)/members", body: Body(account: account))
    }

    func ledgers() async throws -> [LedgerInfo] {
        let res: ListResponse<LedgerInfo> = try await client.request("GET", "/api/v1/ledgers")
        return res.items
    }

    func switchLedger(id: String) async throws {
        struct Body: Encodable { let ledgerId: String }
        let _: OKResponse = try await client.request("POST", "/api/v1/ledgers/switch", body: Body(ledgerId: id))
    }

    // 负债
    func liabilities() async throws -> LiabilitySummary {
        try await client.request("GET", "/api/v1/liabilities")
    }

    func loans() async throws -> [LoanItem] {
        let res: ListResponse<LoanItem> = try await client.request("GET", "/api/v1/loans")
        return res.items
    }

    // 信用卡账单
    func creditCardBills() async throws -> [CreditCardBillItem] {
        struct Res: Decodable { let items: [CreditCardBillItem] }
        let res: Res = try await client.request("GET", "/api/v1/credit-card-bills")
        return res.items
    }

    func createCreditCardBill(accountId: String, period: String, statementBalance: Int, minimumPayment: Int?, dueDate: String?) async throws {
        struct Body: Encodable {
            let period: String
            let statementBalance: Int
            let minimumPayment: Int?
            let dueDate: String?
        }
        let _: ItemResponse<CreditCardBillItem> = try await client.request(
            "POST",
            "/api/v1/credit-cards/\(accountId)/bills",
            body: Body(period: period, statementBalance: statementBalance, minimumPayment: minimumPayment, dueDate: dueDate)
        )
    }

    func markCreditCardBillPaid(id: String, paid: Bool) async throws {
        struct Body: Encodable { let paid: Bool }
        let _: OKResponse = try await client.request("PATCH", "/api/v1/credit-card-bills/\(id)", body: Body(paid: paid))
    }
}
