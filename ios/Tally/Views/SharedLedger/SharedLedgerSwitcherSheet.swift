import SwiftUI

/// 明细页唯一的账本入口：处理邀请、切换账本和进入成员管理。
struct SharedLedgerSwitcherSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    @Environment(SharedLedgerStore.self) private var ledgerStore
    @Binding var selectedDetent: PresentationDetent

    @State private var invitationToAccept: PendingInvitation?
    @State private var confirmOwnCreation = false

    var body: some View {
        @Bindable var ledgerStore = ledgerStore

        NavigationStack {
            List {
                if !ledgerStore.invitations.isEmpty {
                    invitationSection
                }

                Section("切换账本") {
                    if ledgerStore.ledgers.isEmpty, ledgerStore.isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    } else if ledgerStore.ledgers.isEmpty {
                        ContentUnavailableView("暂时无法读取账本", systemImage: "books.vertical")
                    } else {
                        ForEach(ledgerStore.ledgers) { ledger in
                            ledgerRow(ledger)
                        }
                    }
                }

                if ledgerStore.activeFamily == nil {
                    Section {
                        Button {
                            if ledgerStore.invitations.isEmpty {
                                Task { await createSharedLedger() }
                            } else {
                                confirmOwnCreation = true
                            }
                        } label: {
                            Label("一键创建共享账本", systemImage: "person.2.badge.plus")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .disabled(ledgerStore.isBusy)

                        Text("和家人共同记账，个人账本仍会保留，可随时切回。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        NavigationLink {
                            SharedLedgerSettingsView {
                                dismiss()
                            }
                            .onAppear { selectedDetent = .large }
                            .onDisappear { selectedDetent = .medium }
                        } label: {
                            Label("共享账本设置", systemImage: "person.2.circle")
                        }
                    }
                }
            }
            .navigationTitle("当前账本")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
            .disabled(ledgerStore.isBusy)
            .overlay {
                if ledgerStore.isMutating {
                    ProgressView()
                        .padding(18)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
        .task { await ledgerStore.refresh() }
        .confirmationDialog(
            "加入共享账本",
            isPresented: Binding(
                get: { invitationToAccept != nil },
                set: { if !$0 { invitationToAccept = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let invitationToAccept {
                Button("加入 \(invitationToAccept.familyName)") {
                    Task { await accept(invitationToAccept) }
                }
                Button("取消", role: .cancel) { self.invitationToAccept = nil }
            }
        } message: {
            Text("加入后会自动进入该共享账本，个人账本仍会保留。")
        }
        .confirmationDialog(
            "创建自己的共享账本？",
            isPresented: $confirmOwnCreation,
            titleVisibility: .visible
        ) {
            Button("创建并作废现有邀请", role: .destructive) {
                Task { await createSharedLedger() }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("现有 \(ledgerStore.invitationCount) 条待处理邀请将自动作废，此操作不可撤销。")
        }
        .errorAlert($ledgerStore.errorMessage)
    }

    private var invitationSection: some View {
        Section("待处理邀请") {
            ForEach(ledgerStore.invitations) { invitation in
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(invitation.familyName)
                            .font(.headline)
                        Text("\(invitation.inviterNickname) 邀请你共同记账")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        Button("接受") { invitationToAccept = invitation }
                            .buttonStyle(.borderedProminent)
                        Button("拒绝", role: .destructive) {
                            Task { _ = await ledgerStore.declineInvitation(invitation) }
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func ledgerRow(_ ledger: LedgerInfo) -> some View {
        Button {
            if ledger.isCurrent {
                dismiss()
            } else {
                Task {
                    if await ledgerStore.switchToLedger(ledger) {
                        dismiss()
                    }
                }
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: ledger.familyId == nil ? "person.fill" : "person.2.fill")
                    .foregroundStyle(ledger.familyId == nil ? Color.secondary : Color.accentColor)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName(for: ledger))
                        .foregroundStyle(.primary)
                    Text(ledger.familyId == nil ? "个人账本" : "共享账本")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if ledger.isCurrent {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityLabel("当前使用")
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func displayName(for ledger: LedgerInfo) -> String {
        ledger.familyId == nil ? ledger.name : (ledgerStore.activeFamily?.name ?? ledger.name)
    }

    private func createSharedLedger() async {
        confirmOwnCreation = false
        if await ledgerStore.createSharedLedger(nickname: appState.user?.nickname) {
            dismiss()
        }
    }

    private func accept(_ invitation: PendingInvitation) async {
        invitationToAccept = nil
        if await ledgerStore.acceptInvitation(invitation) {
            dismiss()
        }
    }
}
