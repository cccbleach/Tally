import XCTest
@testable import Tally

// 离线写队列回归：
//   1) 队列按 LocalCache 命名空间隔离（用户/账本不串队列，登出清理）；
//   2) 重放语义：成功/服务端拒绝 → 出队；网络错误 → 保留并停止本轮；
//   3) 每次重放都携带入队时的 clientRequestId（服务端幂等键）。
@MainActor
final class PendingTransactionQueueTests: XCTestCase {
    private let namespace = "u-queuetest-l-personal"
    private let otherNamespace = "u-queuetest-other-l-shared"

    override func setUp() async throws {
        clearBoth()
    }

    override func tearDown() async throws {
        clearBoth()
    }

    private func clearBoth() {
        for ns in [namespace, otherNamespace] {
            LocalCache.setNamespace(ns)
            LocalCache.clearAll()
        }
        LocalCache.setNamespace(namespace)
    }

    private func makeQueued(id: String, amount: Int = 1000) -> QueuedTransaction {
        QueuedTransaction(
            id: id, type: "expense", amount: amount, date: "2026-09-12",
            note: nil, currency: "CNY", accountId: "acc-1", categoryId: "cat-1",
            transferToAccountId: nil, queuedAt: Date()
        )
    }

    // MARK: - 队列存储

    func testEnqueueLoadRemoveRoundTrip() {
        XCTAssertTrue(PendingTransactionQueue.load().isEmpty)
        PendingTransactionQueue.enqueue(makeQueued(id: "q-1"))
        PendingTransactionQueue.enqueue(makeQueued(id: "q-2", amount: 2000))
        XCTAssertEqual(PendingTransactionQueue.count(), 2)

        PendingTransactionQueue.remove(id: "q-1")
        let remaining = PendingTransactionQueue.load()
        XCTAssertEqual(remaining.map(\.id), ["q-2"], "按入队顺序保留")
        XCTAssertEqual(remaining.first?.amount, 2000)
    }

    func testQueueIsNamespacedPerUserAndLedger() {
        PendingTransactionQueue.enqueue(makeQueued(id: "q-1"))
        XCTAssertEqual(PendingTransactionQueue.count(), 1)

        LocalCache.setNamespace(otherNamespace)
        XCTAssertTrue(PendingTransactionQueue.load().isEmpty, "其他命名空间不得看到本账本的待同步队列")
        PendingTransactionQueue.enqueue(makeQueued(id: "q-other"))

        LocalCache.setNamespace(namespace)
        XCTAssertEqual(PendingTransactionQueue.count(), 1, "切回来后队列还在")
    }

    // MARK: - 错误分类

    func testTransportErrorClassification() {
        XCTAssertTrue(PendingTransactionQueue.isRetryableTransportError(URLError(.notConnectedToInternet)))
        XCTAssertTrue(PendingTransactionQueue.isRetryableTransportError(URLError(.timedOut)))
        XCTAssertFalse(PendingTransactionQueue.isRetryableTransportError(APIError.server(code: "CURRENCY_MISMATCH", message: "x")))
        XCTAssertFalse(PendingTransactionQueue.isRetryableTransportError(APIError.http(status: 500)), "服务端已应答的错误重放无意义")
        XCTAssertFalse(PendingTransactionQueue.isRetryableTransportError(APIError.unauthorized))
    }

    // MARK: - 重放语义

    func testSyncSuccessRemovesItemsAndSendsClientRequestId() async {
        PendingTransactionQueue.enqueue(makeQueued(id: "q-1", amount: 2500))
        let mock = MockQueueService()
        mock.result = .success

        let outcome = await OfflineTransactionSyncer.sync(service: mock)

        XCTAssertEqual(outcome, .init(synced: 1, dropped: 0, firstDropReason: nil, remaining: 0))
        XCTAssertEqual(mock.capturedIds, ["q-1"], "重放必须携带入队时的幂等键")
        XCTAssertEqual(mock.capturedAmounts, [2500])
        XCTAssertTrue(PendingTransactionQueue.load().isEmpty)
    }

    func testSyncStopsOnNetworkErrorAndKeepsRest() async {
        PendingTransactionQueue.enqueue(makeQueued(id: "q-1"))
        PendingTransactionQueue.enqueue(makeQueued(id: "q-2"))
        let mock = MockQueueService()
        mock.result = .networkFailure

        let outcome = await OfflineTransactionSyncer.sync(service: mock)

        XCTAssertEqual(outcome.synced, 0)
        XCTAssertEqual(outcome.remaining, 2, "网络失败：全部保留，下次再试")
        XCTAssertEqual(mock.capturedIds, ["q-1"], "第一条失败后应停止，不试第二条")
    }

    func testSyncServerRejectionDropsItemAndReportsReason() async {
        PendingTransactionQueue.enqueue(makeQueued(id: "q-reject"))
        let mock = MockQueueService()
        mock.result = .serverReject

        let outcome = await OfflineTransactionSyncer.sync(service: mock)

        XCTAssertEqual(outcome.synced, 0)
        XCTAssertEqual(outcome.dropped, 1)
        XCTAssertEqual(outcome.firstDropReason, APIError.server(code: "ACCOUNT_NOT_FOUND", message: "账户不存在").localizedDescription)
        XCTAssertEqual(outcome.remaining, 0, "业务拒绝的条目必须出队，否则无限堆积")
        XCTAssertTrue(PendingTransactionQueue.load().isEmpty)
    }

    func testSyncPartialSuccessThenNetworkFailure() async {
        PendingTransactionQueue.enqueue(makeQueued(id: "q-1"))
        PendingTransactionQueue.enqueue(makeQueued(id: "q-2"))
        PendingTransactionQueue.enqueue(makeQueued(id: "q-3"))
        let mock = MockQueueService()
        mock.plan = [.success, .networkFailure, .success]

        let outcome = await OfflineTransactionSyncer.sync(service: mock)

        XCTAssertEqual(outcome.synced, 1)
        XCTAssertEqual(outcome.remaining, 2, "q-2 网络失败停止本轮；q-3 未尝试")
        XCTAssertEqual(mock.capturedIds, ["q-1", "q-2"])
        XCTAssertEqual(PendingTransactionQueue.load().map(\.id), ["q-2", "q-3"], "保留顺序不变")
    }

    func testSyncEmptyQueueIsNoop() async {
        let mock = MockQueueService()
        let outcome = await OfflineTransactionSyncer.sync(service: mock)
        XCTAssertEqual(outcome, .init(synced: 0, dropped: 0, firstDropReason: nil, remaining: 0))
        XCTAssertTrue(mock.capturedIds.isEmpty)
    }
}

/// QueuedTransactionCreating 替身：按 plan 顺序返回结果（耗尽后重复最后一个）
private final class MockQueueService: QueuedTransactionCreating, @unchecked Sendable {
    enum Result {
        case success
        case networkFailure
        case serverReject
    }

    var plan: [Result] = []
    var result: Result = .success
    private let lock = NSLock()
    private var capturedIdsStorage: [String] = []
    private var capturedAmountsStorage: [Int] = []
    private var calls = 0

    var capturedIds: [String] { lock.lock(); defer { lock.unlock() }; return capturedIdsStorage }
    var capturedAmounts: [Int] { lock.lock(); defer { lock.unlock() }; return capturedAmountsStorage }

    func createTransaction(type: String, amount: Int, date: String, note: String?, currency: String, accountId: String, categoryId: String?, transferToAccountId: String?, clientRequestId: String?) async throws -> Transaction {
        lock.lock()
        let index = calls
        calls += 1
        capturedIdsStorage.append(clientRequestId ?? "")
        capturedAmountsStorage.append(amount)
        let outcome = index < plan.count ? plan[index] : result
        lock.unlock()

        switch outcome {
        case .success:
            return Transaction(
                id: "server-\(clientRequestId ?? UUID().uuidString)", accountId: accountId, categoryId: categoryId,
                type: type, amount: amount, currency: currency, note: note, date: date,
                transferToAccountId: transferToAccountId,
                createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z",
                accountName: nil, categoryName: nil, categoryIcon: nil, categoryColor: nil,
                transferToAccountName: nil, sourceType: "manual", paymentGroupId: nil
            )
        case .networkFailure:
            throw URLError(.notConnectedToInternet)
        case .serverReject:
            throw APIError.server(code: "ACCOUNT_NOT_FOUND", message: "账户不存在")
        }
    }
}
