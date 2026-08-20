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

    nonisolated var baseURL: String {
        "http://120.26.23.15:8080"
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
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
