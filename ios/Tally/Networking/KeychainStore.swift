import Foundation
import Security

// 令牌存取：内存优先 + Keychain 持久化兜底。
// 即使 Keychain 写入失败（模拟器/真机权限等原因），登录态仍可正常使用；
// 重启后如 Keychain 可用则从其中恢复。
enum KeychainStore {
    private static let service = "com.tally.logan"
    private static let tokenAccount = "authToken"
    private static let refreshAccount = "refreshToken"

    // 内存中的令牌（App 生命周期内有效）
    private static var memory: [String: String] = [:]

    private static func set(_ key: String, _ value: String) {
        memory[key] = value // 内存兜底，先保证会话可用
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = data
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            // 仅打日志，不抛错：内存已保住登录态
            NSLog("[Keychain] 写入 %@ 失败 status=%d（已用内存兜底）", key, status)
        }
    }

    private static func get(_ key: String) -> String? {
        if let m = memory[key] { return m }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let v = String(data: data, encoding: .utf8) {
            memory[key] = v
            return v
        }
        return nil
    }

    private static func delete(_ key: String) {
        memory[key] = nil
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func saveTokens(token: String, refreshToken: String) {
        set(tokenAccount, token)
        set(refreshAccount, refreshToken)
    }

    static func saveToken(_ token: String) {
        set(tokenAccount, token)
    }

    static func saveRefreshToken(_ refreshToken: String) {
        set(refreshAccount, refreshToken)
    }

    static func loadToken() -> String? {
        get(tokenAccount)
    }

    static func loadRefreshToken() -> String? {
        get(refreshAccount)
    }

    static func deleteToken() {
        delete(tokenAccount)
    }

    static func deleteTokens() {
        delete(tokenAccount)
        delete(refreshAccount)
    }
}
