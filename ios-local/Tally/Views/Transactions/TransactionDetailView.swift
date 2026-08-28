//
//  TransactionDetailView.swift
//  Tally
//
//  Detail sheet for a transaction: view fields, edit, soft-delete (recoverable),
//  duplicate.
//

import SwiftUI
import SwiftData

public struct TransactionDetailView: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Query private var allTransactions: [Transaction]

    public let transaction: Transaction
    @State private var showingEdit = false
    @State private var showingDeleteConfirm = false
    @State private var toast: String?

    public init(transaction: Transaction) {
        self.transaction = transaction
    }

    public var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        IconBadge(icon: iconName, colorHex: colorHex, size: 48)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(titleText).font(.title3.bold())
                            Text(TransactionDateFormatter.string(from: transaction.date))
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(amountText)
                            .font(.title2.bold())
                            .foregroundStyle(amountColor)
                    }
                    .accessibilityElement(children: .combine)
                }

                Section("详情") {
                    detailRow("类型", transaction.kind.displayName)
                    if !transaction.isTransfer {
                        detailRow("分类", transaction.category?.name ?? "—")
                    }
                    detailRow("账户", accountText)
                    if !transaction.payee.isEmpty {
                        detailRow("商家 / 来源", transaction.payee)
                    }
                    if !transaction.note.isEmpty {
                        detailRow("备注", transaction.note)
                    }
                    if let refundOf = transaction.refundOf {
                        detailRow("关联退款", "\(TransactionDateFormatter.string(from: refundOf.date)) \(refundOf.money.formatted)")
                    }
                    if !transaction.refunds.isEmpty {
                        detailRow("退款记录", transaction.refunds.map { $0.money.formatted }.joined(separator: "、"))
                    }
                }

                Section {
                    Button("编辑") { showingEdit = true }
                    Button("复制为新的交易") { duplicate() }
                    Button("删除", role: .destructive) { showingDeleteConfirm = true }
                }
            }
            .navigationTitle("交易详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .sheet(isPresented: $showingEdit) {
                AddTransactionView(mode: .edit(transaction))
            }
            .confirmationDialog("删除这笔交易？", isPresented: $showingDeleteConfirm, titleVisibility: .visible) {
                Button("删除", role: .destructive) { softDelete() }
                Button("取消", role: .cancel) {}
            } message: {
                Text("删除后可在「设置 → 最近删除」中恢复。")
            }
            .overlay(alignment: .bottom) {
                if let toast {
                    Text(toast)
                        .font(.subheadline)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(.ultraThinMaterial, in: Capsule())
                        .transition(.opacity)
                        .padding(.bottom, 16)
                }
            }
        }
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

    private var titleText: String {
        switch transaction.kind {
        case .transfer:
            return "\(transaction.fromAccount?.name ?? "?") → \(transaction.toAccount?.name ?? "?")"
        case .refund:
            return "退款 · \(transaction.category?.name ?? "")"
        default:
            return transaction.payee.isEmpty ? (transaction.category?.name ?? "未分类") : transaction.payee
        }
    }

    private var amountText: String {
        switch transaction.kind {
        case .expense: return "-" + transaction.money.formatted
        case .income, .refund: return "+" + transaction.money.formatted
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

    private var accountText: String {
        switch transaction.kind {
        case .transfer: return "\(transaction.fromAccount?.name ?? "?") → \(transaction.toAccount?.name ?? "?")"
        default: return transaction.account?.name ?? "—"
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .accessibilityElement(children: .combine)
    }

    private func duplicate() {
        let copy = Transaction(
            kind: transaction.kind,
            amountMinorUnits: transaction.amountMinorUnits,
            currencyCode: transaction.currencyCode,
            date: Date(),
            account: transaction.account,
            fromAccount: transaction.fromAccount,
            toAccount: transaction.toAccount,
            category: transaction.category,
            refundOf: transaction.refundOf,
            note: transaction.note,
            payee: transaction.payee
        )
        copy.ledger = transaction.ledger
        context.insert(copy)
        do {
            try context.save()
            showToast("已复制为新的交易")
        } catch {
            context.rollback()
            showToast("复制失败：\(error.localizedDescription)")
        }
    }

    private func softDelete() {
        transaction.isDeleted = true
        transaction.deletedAt = Date()
        do {
            try context.save()
            dismiss()
        } catch {
            context.rollback()
            showToast("删除失败：\(error.localizedDescription)")
        }
    }

    private func showToast(_ message: String) {
        withAnimation { toast = message }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            withAnimation { toast = nil }
        }
    }
}
