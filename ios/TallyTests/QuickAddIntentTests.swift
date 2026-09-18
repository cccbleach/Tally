import XCTest
@testable import Tally

// ObjC 运行时也暴露 Category 类型，测试里显式指回 App 的分类模型
private typealias Category = Tally.Category

// 快捷指令记账（App Intents）核心流程回归：
//   1) 默认账户/分类/币种选择正确（币种必须跟随账户，服务端护栏强制）；
//   2) 未登录、无账户、非法金额都返回可读中文提示而不是抛异常（快捷指令环境无 UI 可弹错）；
//   3) Double 金额参数立即转整数分，之后不再经过浮点。
final class QuickAddIntentTests: XCTestCase {

    private func makeAccount(id: String = "acc-1", name: String = "微信钱包", currency: String = "CNY", archived: Bool = false) -> Account {
        Account(id: id, name: name, type: "e-wallet", currency: currency, initialBalance: 0,
                icon: nil, color: nil, isArchived: archived, balance: 0,
                createdAt: "2026-01-01T00:00:00Z")
    }

    private func makeCategory(id: String = "cat-1", name: String = "餐饮", type: String = "expense") -> Category {
        Category(id: id, name: name, type: type, icon: nil, color: nil, sortOrder: 0)
    }

    private func makeTransaction(currency: String = "CNY", amount: Int = 2500) -> Transaction {
        Transaction(id: "tx-new", accountId: "acc-1", categoryId: "cat-1", type: "expense",
                    amount: amount, currency: currency, note: nil, date: "2026-09-12",
                    transferToAccountId: nil, createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
                    accountName: nil, categoryName: nil, categoryIcon: nil, categoryColor: nil,
                    transferToAccountName: nil, sourceType: "shortcut", paymentGroupId: nil)
    }

    func testExpensePicksFirstActiveAccountWithItsCurrency() async {
        let mock = MockQuickAddService()
        mock.accounts = [
            makeAccount(id: "archived", name: "旧账户", archived: true),
            makeAccount(id: "acc-1", name: "微信钱包", currency: "USD"),
        ]
        mock.categories = [makeCategory(id: "income-cat", type: "income"), makeCategory(id: "cat-1", type: "expense")]

        let outcome = await QuickAddService.add(
            amountDouble: 25, kind: .expense, note: "咖啡",
            service: mock, hasSession: { true }
        )

        guard case .success(let message) = outcome else {
            XCTFail("应成功：\(outcome.message)")
            return
        }
        XCTAssertTrue(message.contains("支出"), message)
        XCTAssertTrue(message.contains("$25.00"), "确认弹窗应按账户币种格式化：\(message)")
        XCTAssertTrue(message.contains("微信钱包"), message)

        XCTAssertEqual(mock.capturedAccountId, "acc-1", "应跳过归档账户选第一个活跃账户")
        XCTAssertEqual(mock.capturedCurrency, "USD", "币种必须跟随账户（服务端护栏强制同币种）")
        XCTAssertEqual(mock.capturedCategoryId, "cat-1", "应选支出类型的第一个分类")
        XCTAssertEqual(mock.capturedAmount, 2500)
        XCTAssertEqual(mock.capturedNote, "咖啡")
        XCTAssertEqual(mock.capturedType, "expense")
    }

    func testAmountDoubleIsRoundedToMinorUnitsImmediately() async {
        let mock = MockQuickAddService()
        mock.accounts = [makeAccount()]
        let outcome = await QuickAddService.add(amountDouble: 25.1, kind: .expense, note: nil, service: mock, hasSession: { true })
        guard case .success = outcome else { return XCTFail(outcome.message) }
        XCTAssertEqual(mock.capturedAmount, 2510, "25.1 元应立即转为 2510 分（浮点只出现一次）")
    }

    func testEmptyNoteIsTreatedAsNil() async {
        let mock = MockQuickAddService()
        mock.accounts = [makeAccount()]
        _ = await QuickAddService.add(amountDouble: 10, kind: .income, note: "", service: mock, hasSession: { true })
        XCTAssertNil(mock.capturedNote, "空字符串备注应归一为 nil")
        XCTAssertEqual(mock.capturedType, "income")
        XCTAssertEqual(mock.capturedCategoryId, nil, "没有收入分类时分类应为空而非崩溃")
    }

    func testNotLoggedInReturnsReadableMessage() async {
        let mock = MockQuickAddService()
        let outcome = await QuickAddService.add(amountDouble: 10, kind: .expense, note: nil, service: mock, hasSession: { false })
        guard case .failure(let message) = outcome else { return XCTFail("未登录应失败") }
        XCTAssertTrue(message.contains("登录"), message)
        XCTAssertEqual(mock.createCallCount, 0, "未登录不应发起任何写请求")
    }

    func testInvalidAmountIsRejectedBeforeAnyRequest() async {
        for bad in [0.0, -5.0, .nan, .infinity] {
            let mock = MockQuickAddService()
            mock.accounts = [makeAccount()]
            let outcome = await QuickAddService.add(amountDouble: bad, kind: .expense, note: nil, service: mock, hasSession: { true })
            guard case .failure = outcome else { XCTFail("非法金额 \(bad) 应被拒绝") ; continue }
            XCTAssertEqual(mock.createCallCount, 0)
        }
    }

    func testNoAccountReturnsReadableMessage() async {
        let mock = MockQuickAddService()
        mock.accounts = []
        let outcome = await QuickAddService.add(amountDouble: 10, kind: .expense, note: nil, service: mock, hasSession: { true })
        guard case .failure(let message) = outcome else { return XCTFail("无账户应失败") }
        XCTAssertTrue(message.contains("账户"), message)
    }

    func testUnauthorizedMapsToReloginMessage() async {
        let mock = MockQuickAddService()
        mock.accounts = [makeAccount()]
        mock.errorToThrow = APIError.unauthorized
        let outcome = await QuickAddService.add(amountDouble: 10, kind: .expense, note: nil, service: mock, hasSession: { true })
        guard case .failure(let message) = outcome else { return XCTFail("401 应失败") }
        XCTAssertTrue(message.contains("重新登录"), message)
    }

    // MARK: - 断网降级：缓存账户兜底入离线队列

    @MainActor
    func testNetworkErrorEnqueuesOfflineWithCachedAccount() async {
        LocalCache.setNamespace("u-quickadd-offline-l-personal")
        LocalCache.clearAll()
        defer { LocalCache.clearAll() }
        LocalCache.save([
            makeAccount(id: "cached-acc", name: "现金", currency: "CNY"),
        ], forKey: "accounts")

        let mock = MockQuickAddService()
        mock.errorToThrow = URLError(.notConnectedToInternet)

        let outcome = await QuickAddService.add(amountDouble: 12.5, kind: .expense, note: nil, service: mock, hasSession: { true })

        guard case .success(let message) = outcome else { return XCTFail("断网有缓存账户应入队成功：\(outcome.message)") }
        XCTAssertTrue(message.contains("离线"), message)

        let queued = PendingTransactionQueue.load()
        XCTAssertEqual(queued.count, 1)
        XCTAssertEqual(queued.first?.amount, 1250)
        XCTAssertEqual(queued.first?.accountId, "cached-acc", "断网兜底用缓存里的第一个活跃账户")
        XCTAssertEqual(queued.first?.currency, "CNY", "币种跟随兜底账户（服务端护栏要求）")
        XCTAssertNotNil(queued.first?.id.range(of: #"^[0-9A-F-]{36}$"#, options: .regularExpression), "幂等键为 UUID")
    }

    @MainActor
    func testNetworkErrorWithoutCachedAccountFailsWithReadableMessage() async {
        LocalCache.setNamespace("u-quickadd-offline-empty-l-personal")
        LocalCache.clearAll()
        defer { LocalCache.clearAll() }

        let mock = MockQuickAddService()
        mock.errorToThrow = URLError(.notConnectedToInternet)

        let outcome = await QuickAddService.add(amountDouble: 10, kind: .expense, note: nil, service: mock, hasSession: { true })

        guard case .failure(let message) = outcome else { return XCTFail("无缓存账户应失败") }
        XCTAssertTrue(message.contains("网络"), message)
        XCTAssertEqual(PendingTransactionQueue.count(), 0)
    }
}

/// QuickAddServicing 替身：记录捕获参数，可注入错误。
/// 用「锁保护的类」而非 actor：测试需要在 await 边界外直接读写状态。
private final class MockQuickAddService: QuickAddServicing, @unchecked Sendable {
    private let lock = NSLock()

    private var _accounts: [Account] = []
    private var _categories: [Tally.Category] = []
    private var _errorToThrow: Error?

    private var _createCallCount = 0
    private var _capturedAccountId: String?
    private var _capturedCategoryId: String?
    private var _capturedCurrency: String?
    private var _capturedAmount: Int?
    private var _capturedNote: String?
    private var _capturedType: String?

    var accounts: [Account] {
        get { lock.lock(); defer { lock.unlock() }; return _accounts }
        set { lock.lock(); defer { lock.unlock() }; _accounts = newValue }
    }

    var categories: [Tally.Category] {
        get { lock.lock(); defer { lock.unlock() }; return _categories }
        set { lock.lock(); defer { lock.unlock() }; _categories = newValue }
    }

    var errorToThrow: Error? {
        get { lock.lock(); defer { lock.unlock() }; return _errorToThrow }
        set { lock.lock(); defer { lock.unlock() }; _errorToThrow = newValue }
    }

    var createCallCount: Int { lock.lock(); defer { lock.unlock() }; return _createCallCount }
    var capturedAccountId: String? { lock.lock(); defer { lock.unlock() }; return _capturedAccountId }
    var capturedCategoryId: String? { lock.lock(); defer { lock.unlock() }; return _capturedCategoryId }
    var capturedCurrency: String? { lock.lock(); defer { lock.unlock() }; return _capturedCurrency }
    var capturedAmount: Int? { lock.lock(); defer { lock.unlock() }; return _capturedAmount }
    var capturedNote: String? { lock.lock(); defer { lock.unlock() }; return _capturedNote }
    var capturedType: String? { lock.lock(); defer { lock.unlock() }; return _capturedType }

    func accounts() async throws -> [Account] {
        lock.lock()
        let (value, error) = (_accounts, _errorToThrow)
        lock.unlock()
        if let error { throw error }
        return value
    }

    func categories() async throws -> [Tally.Category] {
        lock.lock()
        let (value, error) = (_categories, _errorToThrow)
        lock.unlock()
        if let error { throw error }
        return value
    }

    func createTransaction(type: String, amount: Int, date: String, note: String?, currency: String, accountId: String, categoryId: String?, transferToAccountId: String?, clientRequestId: String?) async throws -> Transaction {
        lock.lock()
        _createCallCount += 1
        _capturedType = type
        _capturedAmount = amount
        _capturedNote = note
        _capturedCurrency = currency
        _capturedAccountId = accountId
        _capturedCategoryId = categoryId
        let error = _errorToThrow
        lock.unlock()
        if let error { throw error }
        return Transaction(
            id: "tx-new", accountId: accountId, categoryId: categoryId, type: type,
            amount: amount, currency: currency, note: note, date: date,
            transferToAccountId: transferToAccountId,
            createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
            accountName: nil, categoryName: nil, categoryIcon: nil, categoryColor: nil,
            transferToAccountName: nil, sourceType: "shortcut", paymentGroupId: nil
        )
    }
}
