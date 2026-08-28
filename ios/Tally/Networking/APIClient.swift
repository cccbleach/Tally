import Foundation

extension Notification.Name {
    static let tallySessionExpired = Notification.Name("TallySessionExpired")
}

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case http(status: Int)
    case server(code: String, message: String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "地址无效"
        case .invalidResponse: return "服务器响应异常"
        case .http(let s): return "请求失败（\(s)）"
        case .server(_, let message): return message
        case .unauthorized: return "登录已过期，请重新登录"
        }
    }
}

actor APIClient {
    static let shared = APIClient()
    private static var didNotifySessionExpired = false

    // 单飞刷新：同一时刻只允许一个刷新任务，其余并发请求等待同一个结果，
    // 避免首页多个请求同时遇到 401 时并发刷新 token。
    private var refreshTask: Task<Void, Error>?

    // API 地址由构建配置（TALLY_API_BASE_URL → Info.plist 的 TallyAPIBaseURL）注入，
    // 源码不写死任何地址。Debug 允许本地 HTTP 联调；Release 强制 HTTPS，否则直接拒绝启动。
    nonisolated var baseURL: String {
        let resolved: String
        if let configured = Bundle.main.object(forInfoDictionaryKey: "TallyAPIBaseURL") as? String,
           !configured.isEmpty {
            resolved = configured
        } else {
            resolved = "https://api.example.com"
        }
        #if DEBUG
        return resolved
        #else
        // Release 构建必须使用 HTTPS，杜绝明文生产流量
        if !resolved.hasPrefix("https://") {
            fatalError("Release 构建必须使用 HTTPS API 地址（当前: \(resolved)）。请在构建配置 TALLY_API_BASE_URL 中设置 https:// 地址。")
        }
        return resolved
        #endif
    }

    nonisolated var token: String? {
        KeychainStore.loadToken()
    }

    // 认证彻底失效：清理令牌并广播一次，让 AppState 统一登出
    private static func expireSession() {
        KeychainStore.deleteTokens()
        if !didNotifySessionExpired {
            didNotifySessionExpired = true
            NotificationCenter.default.post(name: .tallySessionExpired, object: nil)
        }
    }

    // 新登录时重置“已通知会话过期”状态，避免旧会话的过期通知影响新会话
    nonisolated static func resetSessionExpiredState() {
        didNotifySessionExpired = false
    }

    // 无请求体
    func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = []) async throws -> T {
        try await perform(method, path, bodyData: nil, query: query)
    }

    // 有请求体
    func request<T: Decodable>(_ method: String, _ path: String, body: some Encodable, query: [URLQueryItem] = []) async throws -> T {
        try await perform(method, path, bodyData: try JSONEncoder().encode(body), query: query)
    }

    @discardableResult
    private func refreshTokens() async throws {
        if let refreshTask { return try await refreshTask.value }
        let task = Task { try await self.performRefresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    // 真正的刷新逻辑：换一组新令牌并落库；失败则清理会话。
    private func performRefresh() async throws {
        guard let refresh = KeychainStore.loadRefreshToken() else {
            APIClient.expireSession()
            throw APIError.unauthorized
        }
        var req = URLRequest(url: URL(string: baseURL + "/api/v1/auth/refresh")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(["refreshToken": refresh])
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            APIClient.expireSession()
            throw APIError.unauthorized
        }
        let res = try JSONDecoder().decode(RefreshResponse.self, from: data)
        KeychainStore.saveTokens(token: res.token, refreshToken: res.refreshToken)
        APIClient.didNotifySessionExpired = false
    }

    private func makeRequest(_ method: String, _ path: String, bodyData: Data?, query: [URLQueryItem]) throws -> URLRequest {
        guard var components = URLComponents(string: baseURL + path) else {
            throw APIError.invalidURL
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else { throw APIError.invalidURL }

        var req = URLRequest(url: url)
        req.httpMethod = method
        // 仅当存在 body 时才设置 JSON Content-Type；
        // 无 body 的 POST（如 /auth/logout /ledgers/switch 等）不发送空 JSON 头，避免服务端按空 body 解析。
        if bodyData != nil {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = bodyData
        return req
    }

    private func perform<T: Decodable>(_ method: String, _ path: String, bodyData: Data?, query: [URLQueryItem]) async throws -> T {
        let (data, code) = try await execute(makeRequest(method, path, bodyData: bodyData, query: query))
        if (200..<300).contains(code) {
            return try JSONDecoder().decode(T.self, from: data)
        }
        // 401 时单飞刷新后重试一次
        if code == 401 {
            try await refreshTokens()
            let retry = try await execute(makeRequest(method, path, bodyData: bodyData, query: query))
            if (200..<300).contains(retry.1) {
                return try JSONDecoder().decode(T.self, from: retry.0)
            }
            APIClient.expireSession()
            return try decodeError(retry.0, status: retry.1)
        }
        return try decodeError(data, status: code)
    }

    private func execute(_ req: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        return (data, http.statusCode)
    }

    private func decodeError<T: Decodable>(_ data: Data, status: Int) throws -> T {
        if let parsed = try? JSONDecoder().decode(APIErrorResponse.self, from: data) {
            if status == 401 { throw APIError.unauthorized }
            throw APIError.server(code: parsed.error.code, message: parsed.error.message)
        }
        throw APIError.http(status: status)
    }
}
