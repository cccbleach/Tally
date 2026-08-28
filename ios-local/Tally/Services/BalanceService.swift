//
//  BalanceService.swift
//  Tally
//
//  Account balance and net worth computations.
//
//  Rules:
//  - Expense  : money leaves `account`              -> balance - amount
//  - Income   : money enters `account`              -> balance + amount
//  - Refund   : money comes back into `account`     -> balance + amount
//  - Transfer : leaves `fromAccount`, enters `toAccount` (net zero overall;
//               never counted as income/expense in statistics)
//  - Soft-deleted transactions are excluded.
//

import Foundation

public enum BalanceService {

    /// The current balance of a single account.
    /// `transactions` should be all non-deleted transactions in the same ledger.

    public static func balance(
        for account: Account,
        transactions: [Transaction],
        upTo date: Date? = nil,
        calendar: Calendar = .current
    ) -> Int64 {
        var result = account.initialBalanceMinorUnits
        for t in transactions where !t.isDeleted {
            guard t.currencyCode == account.currencyCode else { continue }
            if let date, t.date > date { continue }
            switch t.kind {
            case .expense:
                if t.account?.id == account.id { result -= t.amountMinorUnits }
            case .income, .refund:
                if t.account?.id == account.id { result += t.amountMinorUnits }
            case .transfer:
                if t.fromAccount?.id == account.id { result -= t.amountMinorUnits }
                if t.toAccount?.id == account.id { result += t.amountMinorUnits }
            }
        }
        return result
    }

    /// Net worth across all accounts grouped by currency.
    public static func netWorth(
        accounts: [Account],
        transactions: [Transaction]
    ) -> [String: Int64] {
        var totals: [String: Int64] = [:]
        for account in accounts where !account.isArchived {
            totals[account.currencyCode, default: 0] += balance(for: account, transactions: transactions)
        }
        return totals
    }

    /// The total effect of a transaction on a given account's balance.
    public static func signedEffect(of t: Transaction, on accountID: UUID) -> Int64 {
        guard !t.isDeleted else { return 0 }
        switch t.kind {
        case .expense:
            return t.account?.id == accountID ? -t.amountMinorUnits : 0
        case .income, .refund:
            return t.account?.id == accountID ? t.amountMinorUnits : 0
        case .transfer:
            var effect: Int64 = 0
            if t.fromAccount?.id == accountID { effect -= t.amountMinorUnits }
            if t.toAccount?.id == accountID { effect += t.amountMinorUnits }
            return effect
        }
    }
}

public enum AccountPolicy {
    public static func canDelete(_ account: Account, transactions: [Transaction]) -> Bool {
        !transactions.contains {
            $0.account?.id == account.id || $0.fromAccount?.id == account.id || $0.toAccount?.id == account.id
        }
    }
}
