import SwiftUI

/// 共享账本的二级管理页。切换与邀请处理留在半屏入口，这里只保留低频成员/所有权操作。
struct SharedLedgerSettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(SharedLedgerStore.self) private var ledgerStore

    let onLedgerRemoved: () -> Void

    @State private var renameText = ""
    @State private var showInviteMember = false
    @State private var memberToRemove: FamilyMember?
    @State private var ownershipTarget: FamilyMember?
    @State private var confirmDelete = false
    @State private var confirmLeave = false
    @State private var noticeMessage: String?

    private var members: [FamilyMember] {
        ledgerStore.familyDetail?.members ?? []
    }

    private var transferCandidates: [FamilyMember] {
        members.filter { $0.userId != appState.user?.id }
    }

    var body: some View {
        @Bindable var ledgerStore = ledgerStore

        List {
            if let family = ledgerStore.activeFamily {
                Section("共享账本") {
                    LabeledContent("名称", value: family.name)
                    LabeledContent("我的身份", value: ledgerStore.isOwner ? "所有者" : "成员")
                }

                memberSection

                if ledgerStore.isOwner {
                    ownerActions
                } else {
                    Section {
                        Button("退出共享账本", role: .destructive) {
                            confirmLeave = true
                        }
                    } footer: {
                        Text("退出后会自动回到个人账本，共享账本中的历史数据不会被删除。")
                    }
                }

                if let noticeMessage {
                    Section {
                        Label(noticeMessage, systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                }
            } else if ledgerStore.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
            } else {
                ContentUnavailableView("共享账本已不存在", systemImage: "person.2.slash")
            }
        }
        .navigationTitle("共享账本设置")
        .navigationBarTitleDisplayMode(.inline)
        .disabled(ledgerStore.isBusy)
        .overlay {
            if ledgerStore.isMutating {
                ProgressView()
                    .padding(18)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .task {
            if ledgerStore.familyDetail == nil {
                await ledgerStore.refresh()
            }
            renameText = ledgerStore.activeFamily?.name ?? ""
        }
        .onChange(of: ledgerStore.activeFamily?.name) { _, name in
            if let name { renameText = name }
        }
        .sheet(isPresented: $showInviteMember) {
            InviteSharedLedgerMemberView {
                noticeMessage = "邀请已发送"
            }
        }
        .confirmationDialog(
            "移除成员",
            isPresented: Binding(
                get: { memberToRemove != nil },
                set: { if !$0 { memberToRemove = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let memberToRemove {
                Button("移除 \(memberToRemove.nickname)", role: .destructive) {
                    Task { await remove(memberToRemove) }
                }
                Button("取消", role: .cancel) { self.memberToRemove = nil }
            }
        } message: {
            Text("该成员会自动回到个人账本。")
        }
        .confirmationDialog(
            "转让所有权",
            isPresented: Binding(
                get: { ownershipTarget != nil },
                set: { if !$0 { ownershipTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let ownershipTarget {
                Button("转让给 \(ownershipTarget.nickname)") {
                    Task { await transfer(to: ownershipTarget) }
                }
                Button("取消", role: .cancel) { self.ownershipTarget = nil }
            }
        } message: {
            Text("转让后你将成为普通成员。")
        }
        .confirmationDialog("删除共享账本", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("永久删除共享账本", role: .destructive) {
                Task {
                    if await ledgerStore.deleteSharedLedger() {
                        onLedgerRemoved()
                    }
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("所有成员都会回到个人账本，且不能再访问该共享账本。")
        }
        .confirmationDialog("退出共享账本", isPresented: $confirmLeave, titleVisibility: .visible) {
            Button("确认退出", role: .destructive) {
                Task {
                    if await ledgerStore.leaveSharedLedger() {
                        onLedgerRemoved()
                    }
                }
            }
            Button("取消", role: .cancel) {}
        }
        .errorAlert($ledgerStore.errorMessage)
    }

    private var memberSection: some View {
        Section("成员") {
            if members.isEmpty {
                Text("暂无成员").foregroundStyle(.secondary)
            }
            ForEach(members) { member in
                HStack(spacing: 10) {
                    Image(systemName: member.role == "owner" ? "person.crop.circle.badge.checkmark" : "person.crop.circle")
                        .foregroundStyle(member.role == "owner" ? Color.accentColor : Color.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(member.nickname)
                        if member.userId == appState.user?.id {
                            Text("我").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if member.role == "owner" {
                        Text("所有者").font(.caption).foregroundStyle(.secondary)
                    } else if ledgerStore.isOwner {
                        Button(role: .destructive) {
                            memberToRemove = member
                        } label: {
                            Image(systemName: "person.crop.circle.badge.minus")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("移除 \(member.nickname)")
                    }
                }
            }
        }
    }

    private var ownerActions: some View {
        Group {
            Section("成员管理") {
                Button {
                    showInviteMember = true
                } label: {
                    Label("邀请成员", systemImage: "person.badge.plus")
                }

                if !transferCandidates.isEmpty {
                    Menu {
                        ForEach(transferCandidates) { member in
                            Button(member.nickname) { ownershipTarget = member }
                        }
                    } label: {
                        Label("转让所有权", systemImage: "person.2.arrowtriangle.left.arrowtriangle.right")
                    }
                }
            }

            Section("账本名称") {
                TextField("共享账本名称", text: $renameText)
                Button("保存名称") {
                    Task {
                        if await ledgerStore.renameSharedLedger(to: renameText) {
                            noticeMessage = "名称已更新"
                        }
                    }
                }
                .disabled(
                    renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || renameText == ledgerStore.activeFamily?.name
                )
            }

            Section {
                Button("删除共享账本", role: .destructive) {
                    confirmDelete = true
                }
            }
        }
    }

    private func remove(_ member: FamilyMember) async {
        memberToRemove = nil
        if await ledgerStore.removeMember(member) {
            noticeMessage = "已移除 \(member.nickname)"
        }
    }

    private func transfer(to member: FamilyMember) async {
        ownershipTarget = nil
        if await ledgerStore.transferOwnership(to: member) {
            noticeMessage = "所有权已转让给 \(member.nickname)"
        }
    }
}

private struct InviteSharedLedgerMemberView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SharedLedgerStore.self) private var ledgerStore
    let onSent: () -> Void

    @State private var nickname = ""

    var body: some View {
        @Bindable var ledgerStore = ledgerStore

        NavigationStack {
            Form {
                Section {
                    TextField("输入对方的精确昵称", text: $nickname)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("公开昵称")
                } footer: {
                    Text("只会向完全匹配该昵称的用户发送邀请，不会显示手机号。")
                }
            }
            .navigationTitle("邀请成员")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("发送") {
                        Task {
                            if await ledgerStore.inviteMember(nickname: nickname) {
                                onSent()
                                dismiss()
                            }
                        }
                    }
                    .disabled(
                        ledgerStore.isBusy
                            || nickname.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
            }
        }
        .presentationDetents([.medium])
        .errorAlert($ledgerStore.errorMessage)
    }
}
