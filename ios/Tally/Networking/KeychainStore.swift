import Foundation
import Security

enum KeychainStore {
    private static let service = "com.tally.app"
    private static let tokenAccount = "authToken"
    private static let refreshAccount = "refreshToken"

    private static func set(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = data
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(_ key: String) {
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
