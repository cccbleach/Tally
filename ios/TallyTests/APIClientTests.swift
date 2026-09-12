import Foundation
import XCTest
@testable import Tally

// APIClient 认证与错误处理回归（此前 DataStore/APIClient 层零测试覆盖）：
//
//   1) 401 → 单飞刷新 token → 用新令牌重试一次 → 成功返回；
//   2) 刷新失败（refresh token 也失效）→ 清空令牌 → 广播一次 tallySessionExpired
//      （重复 401 不得重复广播，否则触发重复登出流程）；
//   3) 服务端错误体 {"error":{"code","message"}} → APIError.server（保留业务错误码）；
//   4) 并发多个请求同时 401 时只发起**一次**刷新请求（单飞）。
final class APIClientTests: XCTestCase {
    private var session: URLSession!
    private var tokenStore: InMemoryTokenStore!
    private var client: APIClient!

    override func setUp() async throws {
        // didNotifySessionExpired 是跨请求的静态状态，必须逐测试复位
        APIClient.resetSessionExpiredState()
        MockURLProtocol.reset()

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: configuration)
        tokenStore = InMemoryTokenStore()
        client = APIClient(
            session: session,
            tokenStore: tokenStore,
            baseURLOverride: "https://unit-test.internal"
        )
    }

    override func tearDown() async throws {
        APIClient.resetSessionExpiredState()
        MockURLProtocol.reset()
    }

    private let userJSON = #"{"user":{"id":"u1","phone":"+8613800000000","nickname":"小明","nicknameChangeAvailableAt":null,"createdAt":"2026-01-01T00:00:00Z"}}"#
    private let refreshJSON = #"{"token":"new-access","refreshToken":"new-refresh"}"#

    // MARK: - 1) 401 → 刷新 → 重试

    func test401TriggersRefreshAndRetriesWithNewToken() async throws {
        tokenStore.saveTokens(token: "old-access", refreshToken: "old-refresh")
        MockURLProtocol.route("/api/v1/users/me", respond: (401, Data("{}".utf8)), (200, Data(userJSON.utf8)))
        MockURLProtocol.route("/api/v1/auth/refresh", respond: (200, Data(refreshJSON.utf8)))

        let response: UserResponse = try await client.request("GET", "/api/v1/users/me")

        XCTAssertEqual(response.user.id, "u1")
        XCTAssertEqual(tokenStore.loadToken(), "new-access", "刷新后必须保存新 access token")
        XCTAssertEqual(tokenStore.loadRefreshToken(), "new-refresh")

        let refreshRequests = MockURLProtocol.recordedRequests(path: "/api/v1/auth/refresh")
        XCTAssertEqual(refreshRequests.count, 1)
        let refreshBody = String(data: refreshRequests[0].body ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(refreshBody.contains("old-refresh"), "刷新请求必须携带旧 refresh token")

        let meRequests = MockURLProtocol.recordedRequests(path: "/api/v1/users/me")
        XCTAssertEqual(meRequests.count, 2, "401 后应重试一次")
        XCTAssertEqual(meRequests[0].authorization, "Bearer old-access")
        XCTAssertEqual(meRequests[1].authorization, "Bearer new-access", "重试必须携带刷新后的新令牌")
    }

    // MARK: - 2) 刷新失败 → 会话过期只广播一次

    func testRefreshFailureClearsTokensAndNotifiesSessionExpiredOnce() async throws {
        tokenStore.saveTokens(token: "old-access", refreshToken: "expired-refresh")
        MockURLProtocol.route("/api/v1/users/me", respond: (401, Data("{}".utf8)))
        MockURLProtocol.route("/api/v1/auth/refresh", respond: (401, Data("{}".utf8)))

        var notified = 0
        let observer = NotificationCenter.default.addObserver(
            forName: .tallySessionExpired, object: nil, queue: nil
        ) { _ in notified += 1 }
        defer { NotificationCenter.default.removeObserver(observer) }

        do {
            let _: UserResponse = try await client.request("GET", "/api/v1/users/me")
            XCTFail("刷新失败应抛出 unauthorized")
        } catch let error as APIError {
            guard case .unauthorized = error else {
                XCTFail("应映射为 unauthorized，实际 \(error)")
                return
            }
        }

        // 再来一次失败请求：令牌已被清理，不得重复广播过期通知
        do {
            let _: UserResponse = try await client.request("GET", "/api/v1/users/me")
            XCTFail("无令牌时应继续抛出 unauthorized")
        } catch { /* 预期失败 */ }

        XCTAssertNil(tokenStore.loadToken(), "会话过期必须清理本地令牌")
        XCTAssertNil(tokenStore.loadRefreshToken())
        XCTAssertEqual(notified, 1, "过期通知只能广播一次（重复广播会触发重复登出）")
    }

    // MARK: - 3) 服务端错误体映射

    func testServerErrorBodyMapsToAPIErrorServer() async throws {
        tokenStore.saveTokens(token: "ok-access", refreshToken: "ok-refresh")
        let body = #"{"error":{"code":"CURRENCY_MISMATCH","message":"跨币种操作暂不支持"}}"#
        MockURLProtocol.route("/api/v1/transactions", respond: (400, Data(body.utf8)))

        do {
            let _: TransactionsResponse = try await client.request("GET", "/api/v1/transactions")
            XCTFail("400 应抛错")
        } catch let error as APIError {
            guard case .server(let code, let message) = error else {
                XCTFail("应映射为 .server，实际 \(error)")
                return
            }
            XCTAssertEqual(code, "CURRENCY_MISMATCH")
            XCTAssertTrue(message.contains("跨币种"))
        }
    }

    // MARK: - 4) 并发 401 → 单飞刷新

    func testConcurrent401SharesSingleRefreshRequest() async throws {
        tokenStore.saveTokens(token: "old-access", refreshToken: "old-refresh")
        // 两个业务请求都先 401 再成功；刷新只准备一份成功响应——若发生并发刷新会取出空响应而失败
        MockURLProtocol.route(
            "/api/v1/users/me",
            respond: (401, Data("{}".utf8)), (401, Data("{}".utf8)),
            (200, Data(userJSON.utf8)), (200, Data(userJSON.utf8))
        )
        MockURLProtocol.route("/api/v1/auth/refresh", respond: (200, Data(refreshJSON.utf8)))

        async let first: UserResponse = client.request("GET", "/api/v1/users/me")
        async let second: UserResponse = client.request("GET", "/api/v1/users/me")
        _ = try await (first, second)

        XCTAssertEqual(
            MockURLProtocol.recordedRequests(path: "/api/v1/auth/refresh").count, 1,
            "并发 401 必须共享同一次刷新（单飞），否则会互相作废对方的 refresh token"
        )
    }
}

// MARK: - 内存令牌仓（替代 Keychain）

private final class InMemoryTokenStore: APITokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var accessToken: String?
    private var refreshToken: String?

    func loadToken() -> String? {
        lock.lock(); defer { lock.unlock() }
        return accessToken
    }

    func loadRefreshToken() -> String? {
        lock.lock(); defer { lock.unlock() }
        return refreshToken
    }

    func saveTokens(token: String, refreshToken: String) {
        lock.lock(); defer { lock.unlock() }
        accessToken = token
        self.refreshToken = refreshToken
    }

    func deleteTokens() {
        lock.lock(); defer { lock.unlock() }
        accessToken = nil
        refreshToken = nil
    }
}

// MARK: - URLProtocol 替身

private final class MockURLProtocol: URLProtocol {
    struct RecordedRequest {
        let path: String
        let method: String
        let authorization: String?
        let body: Data?
    }

    private static let lock = NSLock()
    private static var routes: [String: [(status: Int, body: Data)]] = [:]
    private static var recorded: [RecordedRequest] = []

    /// 注册路由：按调用顺序依次返回响应，耗尽后重复最后一个
    static func route(_ path: String, respond responses: (Int, Data)...) {
        lock.lock(); defer { lock.unlock() }
        routes[path] = responses.map { (status: $0.0, body: $0.1) }
    }

    static func recordedRequests(path: String) -> [RecordedRequest] {
        lock.lock(); defer { lock.unlock() }
        return recorded.filter { $0.path == path }
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        routes = [:]
        recorded = []
    }

    private static func nextResponse(for path: String) -> (status: Int, body: Data) {
        lock.lock(); defer { lock.unlock() }
        guard var queue = routes[path], !queue.isEmpty else {
            return (500, Data(#"{"error":{"code":"NO_MOCK","message":"未注册的路径 \#(path)"}}"#.utf8))
        }
        let response = queue.removeFirst()
        if queue.isEmpty { queue.append(response) } // 耗尽后重复最后一个
        routes[path] = queue
        return response
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? "/"
        Self.lock.lock()
        Self.recorded.append(RecordedRequest(
            path: path,
            method: request.httpMethod ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: request.httpBody ?? request.httpBodyStream.map { stream in
                // URLSession 会把 body 转成流；读回 Data 供断言
                stream.open()
                defer { stream.close() }
                var data = Data()
                let bufferSize = 4096
                let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
                defer { buffer.deallocate() }
                while stream.hasBytesAvailable {
                    let read = stream.read(buffer, maxLength: bufferSize)
                    if read <= 0 { break }
                    data.append(buffer, count: read)
                }
                return data
            }
        ))
        Self.lock.unlock()

        let response = Self.nextResponse(for: path)
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
