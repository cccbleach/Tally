import Foundation

// 简单文件缓存：把最近一次拉取的数据落盘，供离线时读取。
// 缓存按用户（+账本）分区：命名空间不同不会读到彼此的缓存，杜绝换账号/换账本串数据。
//
// 并发：namespace 是可变的静态状态，历史上没有同步保护（在 actor/主线程间读写，
// Swift 5 模式下不报错但属数据竞争）。这里整体标注 @MainActor，所有访问都收敛到主线程。
@MainActor
enum LocalCache {
    private static var namespace = "anon"

    // 切换命名空间（登录用户 / 切换账本 / 退出登录时调用）
    static func setNamespace(_ ns: String) {
        let safe = ns.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
        namespace = safe.isEmpty ? "anon" : safe
    }

    // 清空**当前命名空间**下的全部缓存。
    // 注意顺序：必须在切换命名空间之前调用，否则清的是新命名空间的文件，
    // 上一个用户（或当前用户）的缓存会被留在 Application Support 里。
    static func clearAll() {
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
        let prefix = namespace + "_"
        for f in files where f.lastPathComponent.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: f)
        }
    }

    private static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let d = base.appendingPathComponent("TallyCache", isDirectory: true)
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        return d
    }

    private static func url(forKey key: String) -> URL {
        dir.appendingPathComponent(namespace + "_" + key + ".json")
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

    // 认证：手机号 + 短信验证码为唯一登录方式；邮箱/密码登录、密码重置已整体下线（后端统一 410）
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
        struct Body: Encodable { let phone: String }
        struct CodeResponse: Decodable { let ok: Bool; let code: String? }
        let res: CodeResponse = try await client.request("POST", "/api/v1/auth/request-code", body: Body(phone: phone))
        return res.code
    }

    /// 验证码登录：完整账号 → authenticated；新账号/旧“用户”账号 → nickname_required
    func loginWithCode(phone: String, code: String) async throws -> LoginCodeResponse {
        struct Body: Encodable { let phone: String; let code: String }
        return try await client.request("POST", "/api/v1/auth/login-code", body: Body(phone: phone, code: code))
    }

    /// 完成强制昵称设置（一次性 onboarding ticket），成功后返回会话
    func completeProfile(onboardingToken: String, nickname: String) async throws -> AuthResponse {
        struct Body: Encodable { let onboardingToken: String; let nickname: String }
        return try await client.request("POST", "/api/v1/auth/complete-profile", body: Body(onboardingToken: onboardingToken, nickname: nickname))
    }

    /// 服务端登出：吊销当前设备在服务端的会话（幂等）。
    /// 需在删除本地令牌**之前**调用（要携带 access token 与 refreshToken）；
    /// 网络失败不应阻断本地登出，因此由调用方以 best-effort 处理错误。
    @discardableResult
    func logout(refreshToken: String?) async throws -> Bool {
        struct Body: Encodable { let refreshToken: String? }
        struct Response: Decodable { let ok: Bool; let revoked: Bool }
        let res: Response = try await client.request("POST", "/api/v1/auth/logout", body: Body(refreshToken: refreshToken))
        return res.revoked
    }

    /// 退出全部设备：吊销该用户在服务端的所有会话，返回被吊销数量。
    /// 同样必须在删除本地令牌之前调用（接口需要 access token 鉴权）。
    @discardableResult
    func logoutAllDevices() async throws -> Int {
        struct Response: Decodable { let ok: Bool; let revoked: Int }
        let res: Response = try await client.request("POST", "/api/v1/auth/logout-all")
        return res.revoked
    }

    /// 昵称可用性
    func checkNicknameAvailability(_ nickname: String) async throws -> NicknameCheckResponse {
        try await client.request("GET", "/api/v1/users/nickname-availability", query: [URLQueryItem(name: "nickname", value: nickname)])
    }

    /// 修改昵称（30 天冷却）
    func changeNickname(_ nickname: String) async throws -> User {
        struct Body: Encodable { let nickname: String }
        struct Res: Decodable { let user: User }
        let res: Res = try await client.request("PATCH", "/api/v1/users/me/nickname", body: Body(nickname: nickname))
        return res.user
    }

    /// 本人资料（含脱敏手机号）
    func myProfile() async throws -> User {
        let res: UserResponse = try await client.request("GET", "/api/v1/users/me")
        return res.user
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

    /// Owner 按精确昵称邀请成员（单家庭模型）
    func inviteByNickname(familyId: String, nickname: String) async throws -> InvitationCreateItem {
        struct Body: Encodable { let nickname: String }
        let res: InvitationCreateResponse = try await client.request("POST", "/api/v1/families/\(familyId)/invitations", body: Body(nickname: nickname))
        return res.item
    }

    /// 我的待处理邀请箱（App 启动/回前台/手动刷新拉取）
    func pendingInvitations() async throws -> [PendingInvitation] {
        let res: PendingInvitationsResponse = try await client.request("GET", "/api/v1/families/invitations/pending")
        return res.items
    }

    /// 接受邀请（单家庭约束 + 自动撤销其他待处理邀请）
    func acceptInvitation(id: String) async throws {
        let _: OKResponse = try await client.request("POST", "/api/v1/families/invitations/\(id)/accept")
    }

    /// 拒绝邀请
    func declineInvitation(id: String) async throws {
        let _: OKResponse = try await client.request("POST", "/api/v1/families/invitations/\(id)/decline")
    }

    /// 家庭详情（成员昵称、共享账本、邀请）
    func familyDetail(id: String) async throws -> FamilyDetail {
        let res: FamilyDetailResponse = try await client.request("GET", "/api/v1/families/\(id)")
        return res.item
    }

    /// Member 退出家庭（自动切回个人账本）
    func exitFamily(id: String) async throws {
        let _: OKResponse = try await client.request("POST", "/api/v1/families/\(id)/exit")
    }

    /// Owner 删除家庭（软删除共享账本，成员切回个人账本）
    func deleteFamily(id: String) async throws {
        let _: OKResponse = try await client.request("DELETE", "/api/v1/families/\(id)")
    }

    /// Owner 改家庭名
    func renameFamily(id: String, name: String) async throws {
        struct Body: Encodable { let name: String }
        let _: OKResponse = try await client.request("PATCH", "/api/v1/families/\(id)", body: Body(name: name))
    }

    /// Owner 移除成员（被移除者自动切回个人账本）
    func removeMember(familyId: String, memberUserId: String) async throws {
        let _: OKResponse = try await client.request("DELETE", "/api/v1/families/\(familyId)/members/\(memberUserId)")
    }

    /// Owner 转移所有权
    func transferOwnership(familyId: String, toMemberUserId: String) async throws {
        struct Body: Encodable { let memberUserId: String }
        let _: OKResponse = try await client.request("POST", "/api/v1/families/\(familyId)/transfer", body: Body(memberUserId: toMemberUserId))
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

    // 贷款还款：数据库级幂等。
    // - 偿还下一期（installmentId == nil）必须传 idempotencyKey，服务端 400 否则；
    // - 显式还款应传 installmentId（避免不同 key 双击连续偿还下一期）；
    // - 同一 key + 相同请求重放返回完全相同结果（replayed=true）。
    func payLoan(id: String, payFromAccountId: String, ledgerId: String, installmentId: String?, idempotencyKey: String?, date: String?) async throws -> LoanPayResponse {
        struct Body: Encodable {
            let payFromAccountId: String
            let ledgerId: String
            let installmentId: String?
            let idempotencyKey: String?
            let date: String?
        }
        return try await client.request("POST", "/api/v1/loans/\(id)/pay", body: Body(payFromAccountId: payFromAccountId, ledgerId: ledgerId, installmentId: installmentId, idempotencyKey: idempotencyKey, date: date))
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

    func payCreditCardBill(id: String, payFromAccountId: String, payDate: String?) async throws {
        struct Body: Encodable {
            let payFromAccountId: String
            let payDate: String?
        }
        let _: PayResponse = try await client.request("POST", "/api/v1/credit-card-bills/\(id)/pay", body: Body(payFromAccountId: payFromAccountId, payDate: payDate))
    }

    // ---- 暂存导入（阶段 3）----

    // multipart 上传账单文件，返回创建的暂存任务（不直接写流水）
    func uploadImportFile(fileURL: URL, ledgerId: String?) async throws -> ImportJob {
        let file = try await Task.detached(priority: .userInitiated) {
            try BillImportFile.read(fileURL)
        }.value
        let multipart = file.multipart(boundary: "TallyBoundary-\(UUID().uuidString)")
        struct UploadResponse: Decodable { let item: ImportJob }
        let query = ledgerId.map { [URLQueryItem(name: "ledgerId", value: $0)] } ?? []
        let response: UploadResponse = try await client.upload("/api/v1/imports/jobs/upload", bodyData: multipart.data, contentType: multipart.contentType, query: query)
        return response.item
    }

    func importJob(id: String, ledgerId: String) async throws -> ImportJobDetail {
        let res: ImportJobDetail = try await client.request("GET", "/api/v1/imports/jobs/\(id)", query: [URLQueryItem(name: "ledgerId", value: ledgerId)])
        return res
    }

    func decideImportItem(id: String, decision: String, ledgerId: String) async throws {
        struct Body: Encodable { let decision: String }
        let _: OKResponse = try await client.request("PATCH", "/api/v1/imports/items/\(id)", body: Body(decision: decision), query: [URLQueryItem(name: "ledgerId", value: ledgerId)])
    }

    func commitImportJob(id: String, ledgerId: String) async throws -> ImportCommitResult {
        let res: ImportCommitResult = try await client.request("POST", "/api/v1/imports/jobs/\(id)/commit", query: [URLQueryItem(name: "ledgerId", value: ledgerId)])
        return res
    }
}

struct PayResponse: Decodable {
    let ok: Bool
    let transactionId: String?
}

struct LoanPayResponse: Decodable {
    let ok: Bool
    let replayed: Bool
    let paidDate: String
    let installment: Int
    let installmentId: String
    let principalTransactionId: String
    let interestTransactionId: String
    let paymentGroupId: String
}

// AppState 通过 AuthServicing 依赖认证能力（便于测试注入替身）
extension APIService: AuthServicing {}
