//
//  HomeView.swift
//  Tally
//
//  Home tab: this period's income/expense/balance, recent transactions,
//  and a prominent quick-add entry.
//

import SwiftUI
import SwiftData

public struct HomeView: View {
    @Environment(\.modelContext) private var context
    @Environment(AppState.self) private var appState
    @Query private var settingsList: [AppSettings]
    @Query private var ledgers: [Ledger]
    @Query(sort: \Transaction.date, order: .reverse) private var allTransactions: [Transaction]
    @Query private var accounts: [Account]
    @Query private var categories: [Category]

    @State private var showingAdd = false

    private var settings: AppSettings? { settingsList.first }
    private var ledger: Ledger? {
        if let id = appState.selectedLedgerID {
            return ledgers.first { $0.id == id } ?? ledgers.first(where: \.isDefault)
        }
        return ledgers.first(where: \.isDefault) ?? ledgers.first
    }

    private var ledgerTransactions: [Transaction] {
        guard let ledger else { return [] }
        return allTransactions.filter { $0.ledger?.id == ledger.id && !$0.isDeleted }
    }

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    summaryCard
                    recentSection
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(ledger?.name ?? "Tally")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingAdd = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.title2)
                    }
                    .accessibilityLabel("快速记账")
                    .accessibilityIdentifier("quickAddButton")
                }
            }
            .sheet(isPresented: $showingAdd) {
                AddTransactionView()
            }
        }
    }

    private var period: MonthPeriod {
        MonthPeriod.containing(Date(), dayStartsOn: settings?.monthStartsOn ?? 1)
    }

    private var summary: MonthSummary {
        StatsService.summary(
            in: period,
            transactions: ledgerTransactions,
            dayStartsOn: settings?.monthStartsOn ?? 1,
            currencyCode: currencyCode
        )
    }

    private var currencyCode: String {
        ledger?.currencyCode ?? settings?.defaultCurrencyCode ?? "CNY"
    }

    private var summaryCard: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(period.displayTitle) 结余")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(Money(minorUnits: summary.netMinorUnits, currencyCode: currencyCode).formatted)
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                }
                Spacer()
            }

            HStack(spacing: 0) {
                SummaryItem(label: "收入",
                            value: Money(minorUnits: summary.incomeMinorUnits, currencyCode: currencyCode).formatted,
                            color: .green)
                Divider().frame(height: 36)
                SummaryItem(label: "支出",
                            value: Money(minorUnits: summary.expenseMinorUnits, currencyCode: currencyCode).formatted,
                            color: .red)
            }
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("本月收入\(Money(minorUnits: summary.incomeMinorUnits, currencyCode: currencyCode).formatted)，支出\(Money(minorUnits: summary.expenseMinorUnits, currencyCode: currencyCode).formatted)，结余\(Money(minorUnits: summary.netMinorUnits, currencyCode: currencyCode).formatted)")
        .accessibilityIdentifier("summaryCard")
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("最近交易").font(.headline)
                Spacer()
                NavigationLink("查看全部") { TransactionListView() }
                    .font(.subheadline)
            }
            let recent = ledgerTransactions.sorted { $0.date > $1.date }.prefix(8)
            if recent.isEmpty {
                EmptyStateView(
                    icon: "tray",
                    title: "还没有记账",
                    message: "点击右上角 + 记下你的第一笔支出"
                )
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(recent.enumerated()), id: \.element.id) { index, t in
                        TransactionRow(transaction: t)
                        if index < recent.count - 1 {
                            Divider()
                        }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
    }
}

public struct SummaryItem: View {
    public let label: String
    public let value: String
    public let color: Color

    public var body: some View {
        VStack(spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(.body.bold())
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

/// A reusable single-transaction row.
public struct TransactionRow: View {
    public let transaction: Transaction

    public init(transaction: Transaction) {
        self.transaction = transaction
    }

    public var body: some View {
        HStack(spacing: 12) {
            IconBadge(icon: iconName, colorHex: colorHex, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(amountText)
                .font(.body.bold())
                .foregroundStyle(amountColor)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var iconName: String {
        switch transaction.kind {
        case .transfer: return "arrow.left.arrow.right"
        case .refund: return "arrow.uturn.backward"
        default: return transaction.category?.icon ?? "tag"
        }
    }

    private var colorHex: String {
        switch transaction.kind {
        case .transfer: return "0A84FF"
        case .refund: return "32D74B"
        default: return transaction.category?.colorHex ?? "8E8E93"
        }
    }

    private var title: String {
        switch transaction.kind {
        case .transfer:
            return "\(transaction.fromAccount?.name ?? "?") → \(transaction.toAccount?.name ?? "?")"
        case .refund:
            return "退款 · \(transaction.category?.name ?? "")"
        default:
            return transaction.payee.isEmpty
                ? (transaction.category?.name ?? "未分类")
                : transaction.payee
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if let account = transaction.isTransfer ? transaction.fromAccount : transaction.account {
            parts.append(account.name)
        }
        if !transaction.note.isEmpty { parts.append(transaction.note) }
        parts.append(TransactionDateFormatter.string(from: transaction.date))
        return parts.joined(separator: " · ")
    }

    private var amountText: String {
        switch transaction.kind {
        case .expense: return "-" + transaction.money.formatted
        case .income: return "+" + transaction.money.formatted
        case .refund: return "+" + transaction.money.formatted
        case .transfer: return transaction.money.formatted
        }
    }

    private var amountColor: Color {
        switch transaction.kind {
        case .expense: return .primary
        case .income, .refund: return .green
        case .transfer: return .secondary
        }
    }
}

public enum TransactionDateFormatter {
    public static let shared: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM月dd日 HH:mm"
        f.locale = Locale(identifier: "zh_CN")
        return f
    }()

    public static func string(from date: Date) -> String {
        shared.string(from: date)
    }
}
