//
//  Money.swift
//  Tally
//
//  A value-type money wrapper. The integer is always expressed in the
//  currency's minor units (e.g. cents for CNY). All arithmetic is integer
//  based and therefore predictable.
//

import Foundation

public struct Money: Equatable, Hashable, Sendable, Comparable {
    public let minorUnits: Int64
    public let currencyCode: String

    public init(minorUnits: Int64, currencyCode: String) {
        self.minorUnits = minorUnits
        self.currencyCode = currencyCode
    }

    public var info: CurrencyInfo { Currencies.info(forCode: currencyCode) }
    public var amount: Decimal { Decimal(minorUnits) / Decimal(info.scale) }
    public var isNegative: Bool { minorUnits < 0 }

    public static func < (lhs: Money, rhs: Money) -> Bool {
        precondition(lhs.currencyCode == rhs.currencyCode, "Cannot compare different currencies")
        return lhs.minorUnits < rhs.minorUnits
    }

    public static func + (lhs: Money, rhs: Money) -> Money {
        precondition(lhs.currencyCode == rhs.currencyCode, "Cannot add different currencies")
        return Money(minorUnits: lhs.minorUnits + rhs.minorUnits, currencyCode: lhs.currencyCode)
    }

    public static func - (lhs: Money, rhs: Money) -> Money {
        precondition(lhs.currencyCode == rhs.currencyCode, "Cannot subtract different currencies")
        return Money(minorUnits: lhs.minorUnits - rhs.minorUnits, currencyCode: lhs.currencyCode)
    }

    public static prefix func - (value: Money) -> Money {
        Money(minorUnits: -value.minorUnits, currencyCode: value.currencyCode)
    }

    public var formatted: String { info.formatted(fromMinorUnits: minorUnits) }
    public var decimalString: String { info.string(fromMinorUnits: minorUnits) }
}
