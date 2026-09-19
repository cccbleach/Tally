import Foundation

// 离线写队列（local-first 第一步）：
//
// 断网时记一笔不再直接失败——先落本地队列（按用户+账本命名空间隔离，
// 登出随 LocalCache.clearAll 一并清除），网络恢复后由 DataStore.loadAll
// 成功路径触发重放。重放带 clientRequestId 幂等键，服务端按
// (ledger_id, client_request_id) 唯一索引保证「请求已到达但响应丢失」
// 的重试不会重复入账。
//
// 队列语义：
// - 服务端 2xx/4xx → 出队（4xx 是业务拒绝，如账户已删/金额不合法，重放永远
//   不会成功，保留只会无限堆积；结果如实上报给用户）；
// - 网络错误 → 保留在队列，停止本轮重放（网络又断了），下次再试。

/// 一条待重放的记账请求（与 CreateTransactionBody 一一对应）
struct QueuedTransaction: Codable, Identifiable, Hashable {
    /// clientRequestId：既是队列条目 ID，也是服务端幂等键
    let id: String
    let type: String
    let amount: Int
    let date: String
    let note: String?
    let accountId: String
    let categoryId: String?
    let transferToAccountId: String?
    let queuedAt: Date
}

// 队列走 LocalCache（@MainActor），所有访问方（DataStore/视图/测试）也都在主线程
@MainActor
enum PendingTransactionQueue {
    private static let key = "pendingTransactions"

    static func load() -> [QueuedTransaction] {
        LocalCache.load([QueuedTransaction].self, forKey: key) ?? []
    }

    static func save(_ items: [QueuedTransaction]) {
        LocalCache.save(items, forKey: key)
    }

    static func enqueue(_ item: QueuedTransaction) {
        var items = load()
        items.append(item)
        save(items)
    }

    static func remove(id: String) {
        save(load().filter { $0.id != id })
    }

    static func count() -> Int {
        load().count
    }

    /// 判断错误是否为「网络不可达」类（可重放），区别于服务端业务拒绝（不可重放）
    static func isRetryableTransportError(_ error: Error) -> Bool {
        if error is URLError { return true }
        // APIError.server/http/unauthorized 都是服务端已应答的业务结论，重放无意义
        return !(error is APIError)
    }
}

/// 重放器：依赖注入（生产传 APIService，测试传替身）
protocol QueuedTransactionCreating: Sendable {
    func createTransaction(type: String, amount: Int, date: String, note: String?, accountId: String, categoryId: String?, transferToAccountId: String?, clientRequestId: String?) async throws -> Transaction
}

extension APIService: QueuedTransactionCreating {}

@MainActor
enum OfflineTransactionSyncer {
    struct Outcome: Equatable {
        var synced = 0
        /// 被服务端拒绝而出队的条数（结果已上报，不会静默丢失）
        var dropped = 0
        var firstDropReason: String?
        /// 因网络再次失败而留在队列里的条数
        var remaining = 0
    }

    /// 按入队顺序重放。命中网络错误即停（后面的也没必要再试）。
    /// 队列本身走 LocalCache（按用户+账本命名空间隔离），测试用独立命名空间覆盖。
    static func sync(service: any QueuedTransactionCreating = APIService.shared) async -> Outcome {
        var outcome = Outcome()
        for item in PendingTransactionQueue.load() {
            do {
                _ = try await service.createTransaction(
                    type: item.type,
                    amount: item.amount,
                    date: item.date,
                    note: item.note,
                    accountId: item.accountId,
                    categoryId: item.categoryId,
                    transferToAccountId: item.transferToAccountId,
                    clientRequestId: item.id
                )
                PendingTransactionQueue.remove(id: item.id)
                outcome.synced += 1
            } catch {
                if PendingTransactionQueue.isRetryableTransportError(error) {
                    break // 网络又断了：保留当前及后续条目，下次再试
                }
                // 服务端业务拒绝（4xx）：重放永远不会成功，出队并如实上报
                PendingTransactionQueue.remove(id: item.id)
                outcome.dropped += 1
                if outcome.firstDropReason == nil {
                    outcome.firstDropReason = error.localizedDescription
                }
            }
        }
        outcome.remaining = PendingTransactionQueue.count()
        return outcome
    }
}
