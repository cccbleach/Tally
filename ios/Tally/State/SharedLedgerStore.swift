import Foundation
import Observation

/// 共享账本相关 API 的最小抽象。生产环境由 APIService 实现，单元测试可注入内存服务。
@MainActor
protocol SharedLedgerServing {
    func families() async throws -> [Family]
    func ledgers() async throws -> [LedgerInfo]
    func pendingInvitations() async throws -> [PendingInvitation]
    func familyDetail(id: String) async throws -> FamilyDetail
    func createFamily(name: String) async throws -> FamilyCreateItem
    func acceptInvitation(id: String) async throws
    func declineInvitation(id: String) async throws
    func switchLedger(id: String) async throws
    func renameFamily(id: String, name: String) async throws
    func inviteByNickname(familyId: String, nickname: String) async throws -> InvitationCreateItem
    func removeMember(familyId: String, memberUserId: String) async throws
    func transferOwnership(familyId: String, toMemberUserId: String) async throws
    func exitFamily(id: String) async throws
    func deleteFamily(id: String) async throws
}

extension APIService: SharedLedgerServing {}

/// 账本切换后需要同步缓存命名空间、本位币并重新加载业务数据。
/// 抽成协议是为了让 SharedLedgerStore 的状态机可以独立测试。
@MainActor
protocol LedgerDataManaging: AnyObject {
    var ledgerId: String? { get }
    func setContext(userId: String?, ledgerId: String?)
    func setBaseCurrency(code: String)
    func loadAll() async
}

extension DataStore: LedgerDataManaging {}

@MainActor
@Observable
final class SharedLedgerStore {
    private struct Snapshot {
        let ledgers: [LedgerInfo]
        let family: Family?
        let familyDetail: FamilyDetail?
        let invitations: [PendingInvitation]
    }

    var ledgers: [LedgerInfo] = []
    var activeFamily: Family?
    var familyDetail: FamilyDetail?
    var invitations: [PendingInvitation] = []
    var isLoading = false
    var isMutating = false
    var errorMessage: String?

    private let service: any SharedLedgerServing
    private var userId: String?
    private var dataManager: (any LedgerDataManaging)?

    init(service: any SharedLedgerServing = APIService.shared) {
        self.service = service
    }

    var currentLedger: LedgerInfo? {
        ledgers.first(where: \.isCurrent) ?? personalLedger
    }

    var personalLedger: LedgerInfo? {
        ledgers.first(where: { $0.familyId == nil && $0.isDefault })
            ?? ledgers.first(where: { $0.familyId == nil })
    }

    var sharedLedger: LedgerInfo? {
        ledgers.first(where: { $0.familyId != nil })
    }

    var currentLedgerName: String {
        guard let currentLedger else { return "当前账本" }
        if currentLedger.familyId != nil {
            return activeFamily?.name ?? currentLedger.name
        }
        return currentLedger.name
    }

    var currentLedgerIcon: String {
        currentLedger?.familyId == nil ? "person.fill" : "person.2.fill"
    }

    var invitationCount: Int { invitations.count }

    var isBusy: Bool { isLoading || isMutating }

    var invitationBadgeText: String {
        invitationCount > 99 ? "99+" : String(invitationCount)
    }

    var isOwner: Bool {
        guard let userId else { return false }
        return familyDetail?.ownerUserId == userId
    }

    static func defaultSharedLedgerName(nickname: String?) -> String {
        let trimmed = nickname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "我的共享账本" : "\(trimmed)的共享账本"
    }

    /// 登录用户变化时绑定业务数据上下文；同一用户重复绑定不会清空现有快照。
    func bind(userId: String?, dataManager: any LedgerDataManaging) {
        if self.userId != userId {
            clearSnapshot()
        }
        self.userId = userId
        self.dataManager = dataManager
    }

    func reset() {
        userId = nil
        dataManager = nil
        clearSnapshot()
        errorMessage = nil
        isLoading = false
        isMutating = false
    }

    /// 拉取唯一可信快照。若服务端因退出、移除或删除而改变了当前账本，自动同步并刷新明细。
    /// 返回值表示本次是否已经触发 DataStore.loadAll()。
    @discardableResult
    func refresh() async -> Bool {
        guard userId != nil, !isLoading, !isMutating else { return false }
        isLoading = true
        defer { isLoading = false }
        do {
            apply(try await fetchSnapshot())
            errorMessage = nil
            return await synchronizeDataIfNeeded(forceReload: false)
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func switchToLedger(_ ledger: LedgerInfo) async -> Bool {
        guard canStartMutation else { return false }
        if ledger.id == currentLedger?.id { return true }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.switchLedger(id: ledger.id)
            markCurrentLedger(ledger.id)
            _ = await synchronizeDataIfNeeded(forceReload: true)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func createSharedLedger(nickname: String?) async -> Bool {
        guard activeFamily == nil, canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            _ = try await service.createFamily(name: Self.defaultSharedLedgerName(nickname: nickname))
            try await refreshAfterMutation(reloadData: true)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func acceptInvitation(_ invitation: PendingInvitation) async -> Bool {
        guard canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.acceptInvitation(id: invitation.id)
            try await refreshAfterMutation(reloadData: true)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func declineInvitation(_ invitation: PendingInvitation) async -> Bool {
        guard canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.declineInvitation(id: invitation.id)
            try await refreshAfterMutation(reloadData: false)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func renameSharedLedger(to name: String) async -> Bool {
        guard let familyId = activeFamily?.id, canStartMutation else { return false }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.renameFamily(id: familyId, name: trimmed)
            try await refreshAfterMutation(reloadData: false)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func inviteMember(nickname: String) async -> Bool {
        guard let familyId = activeFamily?.id, canStartMutation else { return false }
        let trimmed = nickname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            _ = try await service.inviteByNickname(familyId: familyId, nickname: trimmed)
            try await refreshAfterMutation(reloadData: false)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func removeMember(_ member: FamilyMember) async -> Bool {
        guard let familyId = activeFamily?.id, canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.removeMember(familyId: familyId, memberUserId: member.userId)
            try await refreshAfterMutation(reloadData: false)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func transferOwnership(to member: FamilyMember) async -> Bool {
        guard let familyId = activeFamily?.id, canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.transferOwnership(familyId: familyId, toMemberUserId: member.userId)
            try await refreshAfterMutation(reloadData: false)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func leaveSharedLedger() async -> Bool {
        guard let familyId = activeFamily?.id, canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.exitFamily(id: familyId)
            try await refreshAfterMutation(reloadData: true)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func deleteSharedLedger() async -> Bool {
        guard let familyId = activeFamily?.id, canStartMutation else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.deleteFamily(id: familyId)
            try await refreshAfterMutation(reloadData: true)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func fetchSnapshot() async throws -> Snapshot {
        async let ledgerRequest = service.ledgers()
        async let familyRequest = service.families()
        async let invitationRequest = service.pendingInvitations()
        let (newLedgers, families, newInvitations) = try await (ledgerRequest, familyRequest, invitationRequest)
        let family = families.first
        let detail: FamilyDetail?
        if let family {
            detail = try await service.familyDetail(id: family.id)
        } else {
            detail = nil
        }
        return Snapshot(ledgers: newLedgers, family: family, familyDetail: detail, invitations: newInvitations)
    }

    private var canStartMutation: Bool {
        !isLoading && !isMutating
    }

    private func apply(_ snapshot: Snapshot) {
        ledgers = snapshot.ledgers.sorted {
            if ($0.familyId == nil) != ($1.familyId == nil) { return $0.familyId == nil }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        activeFamily = snapshot.family
        familyDetail = snapshot.familyDetail
        invitations = snapshot.invitations
        syncBaseCurrency()
    }

    private func refreshAfterMutation(reloadData: Bool) async throws {
        apply(try await fetchSnapshot())
        _ = await synchronizeDataIfNeeded(forceReload: reloadData)
    }

    private func markCurrentLedger(_ id: String) {
        ledgers = ledgers.map {
            LedgerInfo(
                id: $0.id,
                name: $0.name,
                currency: $0.currency,
                isDefault: $0.isDefault,
                familyId: $0.familyId,
                isCurrent: $0.id == id
            )
        }
        syncBaseCurrency()
    }

    /// 把当前账本币种同步给 DataStore：统计/预算/负债的聚合金额都由服务端折算到
    /// 本位币返回，展示层必须用同一币种格式化，否则 USD 账本的结余会显示成 ¥。
    private func syncBaseCurrency() {
        dataManager?.setBaseCurrency(code: currentLedger?.currency ?? Money.defaultCurrencyCode)
    }

    private func synchronizeDataIfNeeded(forceReload: Bool) async -> Bool {
        guard let userId, let dataManager, let currentLedger else { return false }
        let changed = dataManager.ledgerId != currentLedger.id
        if changed {
            dataManager.setContext(userId: userId, ledgerId: currentLedger.id)
        }
        if changed || forceReload {
            await dataManager.loadAll()
            return true
        }
        return false
    }

    private func clearSnapshot() {
        ledgers = []
        activeFamily = nil
        familyDetail = nil
        invitations = []
        // 登出/换用户后账本币种未知，回到默认，待下次快照刷新再同步
        dataManager?.setBaseCurrency(code: Money.defaultCurrencyCode)
    }
}
