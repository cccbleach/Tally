//
//  Currency.swift
//  Tally
//
//  Currency metadata and formatting. Amounts are always stored as integer
//  "minor units" (e.g. cents for CNY). We never use Double to represent money.
//

import Foundation

/// Describes the decimal rules of a currency.
public struct CurrencyInfo: Equatable, Sendable {
    public let code: String          // ISO 4217, e.g. "CNY"
    public let symbol: String        // e.g. "¥"
    public let minorUnits: Int       // how many decimal places (0, 2, 3...)
    public let locale: Locale

    public init(code: String, symbol: String, minorUnits: Int, locale: Locale) {
        self.code = code
        self.symbol = symbol
        self.minorUnits = minorUnits
        self.locale = locale
    }

    /// Number of minor units in one major unit (10^minorUnits).
    public var scale: Int64 {
        var result: Int64 = 1
        for _ in 0..<minorUnits { result *= 10 }
        return result
    }

    /// Parse a signed decimal string into minor units without using floating
    /// point arithmetic. A single comma is accepted as a decimal separator;
    /// when both comma and period are present, the rightmost separator is the
    /// decimal separator and the other is treated as grouping.
    public func minorUnits(fromString string: String) -> Int64? {
        var cleaned = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        cleaned = cleaned.replacingOccurrences(of: symbol, with: "")
        cleaned = cleaned.replacingOccurrences(of: code, with: "", options: [.caseInsensitive])
        cleaned = cleaned.replacingOccurrences(of: "，", with: ",")
        cleaned.removeAll { $0.isWhitespace || $0 == "'" || $0 == "_" }

        var isNegative = false
        if cleaned.first == "-" || cleaned.first == "+" {
            isNegative = cleaned.first == "-"
            cleaned.removeFirst()
        }
        guard !cleaned.isEmpty, !cleaned.contains("+") && !cleaned.contains("-") else { return nil }

        let dotCount = cleaned.filter { $0 == "." }.count
        let commaCount = cleaned.filter { $0 == "," }.count
        guard dotCount <= 1, commaCount <= 1 else { return nil }

        let decimalSeparator: Character?
        if let dot = cleaned.lastIndex(of: "."), let comma = cleaned.lastIndex(of: ",") {
            decimalSeparator = dot > comma ? "." : ","
            let groupingSeparator: Character = decimalSeparator == "." ? "," : "."
            cleaned.removeAll { $0 == groupingSeparator }
        } else if dotCount == 1 {
            decimalSeparator = "."
        } else if commaCount == 1 {
            decimalSeparator = ","
        } else {
            decimalSeparator = nil
        }

        let parts: [Substring]
        if let decimalSeparator {
            parts = cleaned.split(separator: decimalSeparator, omittingEmptySubsequences: false)
        } else {
            parts = [Substring(cleaned)]
        }
        guard parts.count == 1 || parts.count == 2 else { return nil }

        let majorText = parts[0].isEmpty ? "0" : String(parts[0])
        var fractionText = parts.count == 2 ? String(parts[1]) : ""
        guard majorText.allSatisfy(\.isNumber), fractionText.allSatisfy(\.isNumber) else { return nil }
        guard fractionText.count <= minorUnits else { return nil }
        while fractionText.count < minorUnits { fractionText.append("0") }

        guard let major = UInt64(majorText) else { return nil }
        let fraction = fractionText.isEmpty ? UInt64(0) : UInt64(fractionText)
        guard let fraction else { return nil }
        let unsignedScale = UInt64(scale)
        let (scaledMajor, multiplyOverflow) = major.multipliedReportingOverflow(by: unsignedScale)
        guard !multiplyOverflow else { return nil }
        let (magnitude, addOverflow) = scaledMajor.addingReportingOverflow(fraction)
        guard !addOverflow else { return nil }

        let negativeLimit = UInt64(Int64.max) + 1
        guard magnitude <= (isNegative ? negativeLimit : UInt64(Int64.max)) else { return nil }
        if isNegative {
            if magnitude == negativeLimit { return Int64.min }
            return -Int64(magnitude)
        }
        return Int64(magnitude)
    }

    /// Format minor units as a decimal string (e.g. "12.50").
    public func string(fromMinorUnits minor: Int64) -> String {
        let negative = minor < 0
        let magnitude = minor == Int64.min ? UInt64(Int64.max) + 1 : UInt64(Swift.abs(minor))
        let unsignedScale = UInt64(scale)
        let major = magnitude / unsignedScale
        let remainder = magnitude % unsignedScale
        var minorStr = String(remainder)
        while minorStr.count < minorUnits { minorStr = "0" + minorStr }
        var out = major.description
        if minorUnits > 0 { out += "." + minorStr }
        return negative ? "-" + out : out
    }

    /// Format minor units for display using the system's number/currency conventions.
    public func formatted(fromMinorUnits minor: Int64) -> String {
        let value = Decimal(minor) / Decimal(scale)
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        formatter.currencySymbol = symbol
        formatter.minimumFractionDigits = minorUnits
        formatter.maximumFractionDigits = minorUnits
        return formatter.string(from: value as NSDecimalNumber) ?? "\(symbol)\(string(fromMinorUnits: minor))"
    }
}

/// Registry of currencies we support in the MVP.
public enum Currencies {
    public static let cny = CurrencyInfo(code: "CNY", symbol: "¥", minorUnits: 2, locale: Locale(identifier: "zh_CN"))
    public static let usd = CurrencyInfo(code: "USD", symbol: "$", minorUnits: 2, locale: Locale(identifier: "en_US"))
    public static let jpy = CurrencyInfo(code: "JPY", symbol: "¥", minorUnits: 0, locale: Locale(identifier: "ja_JP"))
    public static let eur = CurrencyInfo(code: "EUR", symbol: "€", minorUnits: 2, locale: Locale(identifier: "de_DE"))
    public static let hkd = CurrencyInfo(code: "HKD", symbol: "HK$", minorUnits: 2, locale: Locale(identifier: "zh_HK"))
    public static let twd = CurrencyInfo(code: "TWD", symbol: "NT$", minorUnits: 2, locale: Locale(identifier: "zh_TW"))
    public static let gbp = CurrencyInfo(code: "GBP", symbol: "£", minorUnits: 2, locale: Locale(identifier: "en_GB"))

    public static let all: [CurrencyInfo] = [cny, usd, jpy, eur, hkd, twd, gbp]

    public static func supportedInfo(forCode code: String) -> CurrencyInfo? {
        let normalized = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return all.first { $0.code == normalized }
    }

    public static func info(forCode code: String) -> CurrencyInfo {
        if let supported = supportedInfo(forCode: code) { return supported }
        let normalized = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return CurrencyInfo(
            code: normalized.isEmpty ? "XXX" : normalized,
            symbol: normalized.isEmpty ? "¤" : normalized + " ",
            minorUnits: 2,
            locale: .current
        )
    }
}

public enum LedgerCurrencyPolicy {
    public enum CurrencyChangeError: Error, LocalizedError, Equatable {
        case unsupportedCurrency(String)
        case ledgerHasFinancialData

        public var errorDescription: String? {
            switch self {
            case .unsupportedCurrency(let code): return "不支持的币种：\(code)"
            case .ledgerHasFinancialData: return "已有交易、预算或非零余额，不能直接更换账本币种"
            }
        }
    }

    public static func canChangeCurrency(of ledger: Ledger) -> Bool {
        ledger.transactions.isEmpty
            && ledger.budgets.isEmpty
            && !ledger.accounts.contains { $0.initialBalanceMinorUnits != 0 }
    }

    public static func changeCurrency(of ledger: Ledger, to newCode: String) throws {
        guard let currency = Currencies.supportedInfo(forCode: newCode) else {
            throw CurrencyChangeError.unsupportedCurrency(newCode)
        }
        guard canChangeCurrency(of: ledger) else {
            throw CurrencyChangeError.ledgerHasFinancialData
        }
        ledger.currencyCode = currency.code
        for account in ledger.accounts {
            account.currencyCode = currency.code
        }
    }
}
