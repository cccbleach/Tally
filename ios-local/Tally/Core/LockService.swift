//
//  LockService.swift
//  Tally
//
//  Privacy lock using Face ID / Touch ID via LocalAuthentication.
//
//  Security decisions:
//  - Biometric failures fall back to the device passcode (`LAPolicy
//    .deviceOwnerAuthentication`) so users are never locked out of their own
//    local data.
//  - The preference to enable the lock is stored locally. The actual
//    authentication is always handled by the system.
//

import Foundation
import LocalAuthentication

public enum LockService {

    public enum BiometryKind {
        case faceID
        case touchID
        case none
        case unknown

        public var displayName: String {
            switch self {
            case .faceID: return "面容 ID"
            case .touchID: return "触控 ID"
            case .none: return "设备密码"
            case .unknown: return "生物识别"
            }
        }
    }

    public static var biometryKind: BiometryKind {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .none
        }
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        default: return .unknown
        }
    }

    public static var isBiometryAvailable: Bool {
        biometryKind != .none
    }

    /// Prompt the user. Falls back to passcode if biometrics fail.
    public static func authenticate(reason: String) async -> Bool {
        let biometricContext = LAContext()
        biometricContext.localizedReason = reason
        if biometricContext.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) {
            do {
                return try await biometricContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            } catch {
                // Fall through to passcode.
            }
        }
        let fallbackContext = LAContext()
        do {
            return try await fallbackContext.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}
