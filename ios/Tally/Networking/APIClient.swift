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
    // 源码不写死任何“看起来像生产”的地址（曾经的示例域名兜底已删除：
    // 它会让占位域名被打进 Release 产物并静默联网失败）。
    // Debug 未配置时回落本机 127.0.0.1（仅开发用）；Release 必须是非占位 HTTPS 域名，否则拒绝启动。
    nonisolated var baseURL: String {
        let configured = (Bundle.main.object(forInfoDictionaryKey: "TallyAPIBaseURL") as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        #if DEBUG
        if configured.isEmpty { return "http://127.0.0.1:8080" }
        return configured
        #else
        // 构建期已有 scripts/validate-api-url.sh 拦截；这里再兜一层，
        // 防止有人绕过脚本（旧工程、手改 plist）把明文/占位地址带到线上包。
        if configured.isEmpty {
            fatalError("Release 构建缺少 API 地址：请在构建时注入 TALLY_API_BASE_URL=https://你的域名")
        }
        if !configured.hasPrefix("https://") {
            fatalError("Release 构建必须使用 HTTPS API 地址（当前: \(configured)）")
        }
        if APIClient.isPlaceholderOrLocalHost(URL(string: configured)?.host ?? "") {
            fatalError("Release 构建的 API 地址是本机/内网/示例/占位域名：\(configured)")
        }
        return configured
        #endif
    }

    // Release 产物里不允许出现的 API 主机：本机、环回、私网、单标签（容器名）、示例域与常见占位词。
    nonisolated static func isPlaceholderOrLocalHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased()
        if host.isEmpty { return true }
        if host == "localhost" || host.hasSuffix(".localhost") { return true }
        if host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") || host.hasPrefix("169.254.") {
            return true
        }
        if host.hasPrefix("172.") {
            let second = Int(host.split(separator: ".").dropFirst().first.flatMap { Int($0) } ?? -1)
            if (16...31).contains(second) { return true }
        }
        // 纯 IP：无法签发公网证书，视为内网/调试地址
        if !host.contains(where: { $0.isLetter }) { return true }
        // 单标签主机名（tally-backend、backend 等 Docker 服务名）
        if !host.contains(".") { return true }
        // RFC 保留域与示例域
        let reservedSuffixes = [".example.com", ".example.org", ".example.net", ".example", ".test", ".invalid", ".local", ".internal", ".docker"]
        if reservedSuffixes.contains(where: { host == String($0.dropFirst()) || host.hasSuffix($0) }) { return true }
        let tld = host.components(separatedBy: ".").last ?? ""
        if tld.count < 2 || !tld.allSatisfy({ $0.isLetter }) { return true }
        // 常见占位词
        let placeholders = ["yourdomain", "your-domain", "yourcompany", "your-production-domain", "production-domain",
                            "placeholder", "changeme", "change-me", "please-change", "replace-me", "your-server",
                            "fixme", "todo", "tbd", "dummy", "sample", "template", "my-domain", "mydomain"]
        return placeholders.contains { host.contains($0) }
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
