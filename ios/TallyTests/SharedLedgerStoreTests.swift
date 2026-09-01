import XCTest
@testable import Tally

@MainActor
final class SharedLedgerStoreTests: XCTestCase {
    func testDefaultNameUsesNicknameAndHasSafeFallback() {
        XCTAssertEqual(SharedLedgerStore.defaultSharedLedgerName(nickname: "小明"), "小明的共享账本")
        XCTAssertEqual(SharedLedgerStore.defaultSharedLedgerName(nickname: "  "), "我的共享账本")
        XCTAssertEqual(SharedLedgerStore.defaultSharedLedgerName(nickname: nil), "我的共享账本")
    }

    func testRefreshBuildsPersonalInvitationAndOwnerStates() async {
        let service = MockSharedLedgerService()
        let data = MockLedgerDataManager(ledgerId: "personal")
        service.ledgerItems = [.personal(current: true)]
        service.invitationItems = [.sample(id: "invite-1"), .sample(id: "invite-2")]
        let store = SharedLedgerStore(service: service)
        store.bind(userId: "me", dataManager: data)

        let reloaded = await store.refresh()

        XCTAssertFalse(reloaded)
        XCTAssertEqual(store.currentLedger?.id, "personal")
        XCTAssertEqual(store.currentLedgerName, "个人账本")
        XCTAssertEqual(store.invitationCount, 2)
        XCTAssertNil(store.activeFamily)
        XCTAssertFalse(store.isOwner)

        service.family = .sample(ownerUserId: "me")
        service.detail = .sample(ownerUserId: "me")
        service.ledgerItems = [.personal(current: false), .shared(current: true)]
        _ = await store.refresh()

        XCTAssertEqual(store.currentLedgerName, "我们的共享账本")
        XCTAssertTrue(store.isOwner)
        XCTAssertEqual(data.ledgerId, "shared")
        XCTAssertEqual(data.reloadCount, 1)
    }

    func testOneTapCreateRevokesInvitationsAndReloadsSharedLedger() async {
        let service = MockSharedLedgerService()
        let data = MockLedgerDataManager(ledgerId: "personal")
        service.ledgerItems = [.personal(current: true)]
        service.invitationItems = [.sample(id: "invite-1"), .sample(id: "invite-2")]
        let store = SharedLedgerStore(service: service)
        store.bind(userId: "me", dataManager: data)

        let succeeded = await store.createSharedLedger(nickname: "小明")

        XCTAssertTrue(succeeded)
        XCTAssertEqual(service.createdName, "小明的共享账本")
        XCTAssertTrue(store.invitations.isEmpty)
        XCTAssertEqual(store.currentLedger?.id, "shared")
        XCTAssertEqual(data.ledgerId, "shared")
        XCTAssertEqual(data.reloadCount, 1)
    }

    func testAcceptAndDeclineUpdateBadgeAndOnlyJoinReloadsData() async {
        let service = MockSharedLedgerService()
        let data = MockLedgerDataManager(ledgerId: "personal")
        service.ledgerItems = [.personal(current: true)]
        let accepted = PendingInvitation.sample(id: "accept-me")
        let declined = PendingInvitation.sample(id: "decline-me")
        service.invitationItems = [accepted, declined]
        let store = SharedLedgerStore(service: service)
        store.bind(userId: "me", dataManager: data)

        let declinedSuccessfully = await store.declineInvitation(declined)
        XCTAssertTrue(declinedSuccessfully)
        XCTAssertEqual(store.invitationCount, 1)
        XCTAssertEqual(data.reloadCount, 0)

        let acceptedSuccessfully = await store.acceptInvitation(accepted)
        XCTAssertTrue(acceptedSuccessfully)
        XCTAssertEqual(store.invitationCount, 0)
        XCTAssertEqual(store.currentLedger?.id, "shared")
        XCTAssertEqual(data.ledgerId, "shared")
        XCTAssertEqual(data.reloadCount, 1)
    }

    func testSwitchFailureKeepsOldLedgerAndSuccessfulRetryReloadsExactlyOnce() async {
        let service = MockSharedLedgerService()
        let data = MockLedgerDataManager(ledgerId: "personal")
        service.family = .sample(ownerUserId: "owner")
        service.detail = .sample(ownerUserId: "owner")
        service.ledgerItems = [.personal(current: true), .shared(current: false)]
        let store = SharedLedgerStore(service: service)
        store.bind(userId: "me", dataManager: data)
        _ = await store.refresh()

        service.switchError = MockFailure.expected
        let failedSwitch = await store.switchToLedger(.shared(current: false))
        XCTAssertFalse(failedSwitch)
        XCTAssertEqual(store.currentLedger?.id, "personal")
        XCTAssertEqual(data.ledgerId, "personal")
        XCTAssertEqual(data.reloadCount, 0)

        service.switchError = nil
        let successfulSwitch = await store.switchToLedger(.shared(current: false))
        XCTAssertTrue(successfulSwitch)
        XCTAssertEqual(store.currentLedger?.id, "shared")
        XCTAssertEqual(data.ledgerId, "shared")
        XCTAssertEqual(data.reloadCount, 1)
    }

    func testMemberExitAndOwnerDeleteReturnToPersonalLedger() async {
        do {
            let service = MockSharedLedgerService()
            let data = MockLedgerDataManager(ledgerId: "shared")
            service.family = .sample(ownerUserId: "owner")
            service.detail = .sample(ownerUserId: "owner")
            service.ledgerItems = [.personal(current: false), .shared(current: true)]
            let store = SharedLedgerStore(service: service)
            store.bind(userId: "me", dataManager: data)
            _ = await store.refresh()

            XCTAssertFalse(store.isOwner)
            let left = await store.leaveSharedLedger()
            XCTAssertTrue(left)
            XCTAssertNil(store.activeFamily)
            XCTAssertEqual(store.currentLedger?.id, "personal")
            XCTAssertEqual(data.ledgerId, "personal")
            XCTAssertEqual(data.reloadCount, 1)
        }

        do {
            let service = MockSharedLedgerService()
            let data = MockLedgerDataManager(ledgerId: "shared")
            service.family = .sample(ownerUserId: "me")
            service.detail = .sample(ownerUserId: "me")
            service.ledgerItems = [.personal(current: false), .shared(current: true)]
            let store = SharedLedgerStore(service: service)
            store.bind(userId: "me", dataManager: data)
            _ = await store.refresh()

            XCTAssertTrue(store.isOwner)
            let deleted = await store.deleteSharedLedger()
            XCTAssertTrue(deleted)
            XCTAssertNil(store.activeFamily)
            XCTAssertEqual(store.currentLedger?.id, "personal")
            XCTAssertEqual(data.ledgerId, "personal")
            XCTAssertEqual(data.reloadCount, 1)
        }
    }
}

private enum MockFailure: Error {
    case expected
}

@MainActor
private final class MockLedgerDataManager: LedgerDataManaging {
    private(set) var ledgerId: String?
    private(set) var reloadCount = 0

    init(ledgerId: String?) {
        self.ledgerId = ledgerId
    }

    func setContext(userId: String?, ledgerId: String?) {
        self.ledgerId = ledgerId
    }

    func loadAll() async {
        reloadCount += 1
    }
}

@MainActor
private final class MockSharedLedgerService: SharedLedgerServing {
    var ledgerItems: [LedgerInfo] = []
    var family: Family?
    var detail: FamilyDetail?
    var invitationItems: [PendingInvitation] = []
    var createdName: String?
    var switchError: Error?

    func families() async throws -> [Family] { family.map { [$0] } ?? [] }
    func ledgers() async throws -> [LedgerInfo] { ledgerItems }
    func pendingInvitations() async throws -> [PendingInvitation] { invitationItems }
    func familyDetail(id: String) async throws -> FamilyDetail {
        guard let detail else { throw MockFailure.expected }
        return detail
    }

    func createFamily(name: String) async throws -> FamilyCreateItem {
        createdName = name
        joinSharedLedger(name: name, ownerUserId: "me")
        invitationItems = []
        return FamilyCreateItem(
            id: "family",
            name: name,
            ownerUserId: "me",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            ledgerId: "shared"
        )
    }

    func acceptInvitation(id: String) async throws {
        invitationItems = []
        joinSharedLedger(name: "我们的共享账本", ownerUserId: "owner")
    }

    func declineInvitation(id: String) async throws {
        invitationItems.removeAll { $0.id == id }
    }

    func switchLedger(id: String) async throws {
        if let switchError { throw switchError }
        ledgerItems = ledgerItems.map {
            LedgerInfo(
                id: $0.id,
                name: $0.name,
                currency: $0.currency,
                isDefault: $0.isDefault,
                familyId: $0.familyId,
                isCurrent: $0.id == id
            )
        }
    }

    func renameFamily(id: String, name: String) async throws {
        guard let current = family else { return }
        family = Family(
            id: current.id,
            name: name,
            ownerUserId: current.ownerUserId,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt
        )
        if let currentDetail = detail {
            detail = FamilyDetail(
                id: currentDetail.id,
                name: name,
                ownerUserId: currentDetail.ownerUserId,
                createdAt: currentDetail.createdAt,
                updatedAt: currentDetail.updatedAt,
                members: currentDetail.members,
                ledgers: currentDetail.ledgers,
                invitations: currentDetail.invitations
            )
        }
    }

    func inviteByNickname(familyId: String, nickname: String) async throws -> InvitationCreateItem {
        InvitationCreateItem(
            id: "new-invite",
            targetUserId: "target",
            targetNickname: nickname,
            expiresAt: "2026-01-08T00:00:00Z",
            status: "pending"
        )
    }

    func removeMember(familyId: String, memberUserId: String) async throws {
        guard let current = detail else { return }
        detail = FamilyDetail(
            id: current.id,
            name: current.name,
            ownerUserId: current.ownerUserId,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
            members: current.members.filter { $0.userId != memberUserId },
            ledgers: current.ledgers,
            invitations: current.invitations
        )
    }

    func transferOwnership(familyId: String, toMemberUserId: String) async throws {
        guard let current = detail else { return }
        detail = FamilyDetail(
            id: current.id,
            name: current.name,
            ownerUserId: toMemberUserId,
            createdAt: current.createdAt,
            updatedAt: current.updatedAt,
            members: current.members.map {
                FamilyMember(
                    userId: $0.userId,
                    nickname: $0.nickname,
                    role: $0.userId == toMemberUserId ? "owner" : "member",
                    joinedAt: $0.joinedAt
                )
            },
            ledgers: current.ledgers,
            invitations: current.invitations
        )
    }

    func exitFamily(id: String) async throws { leaveSharedLedger() }
    func deleteFamily(id: String) async throws { leaveSharedLedger() }

    private func joinSharedLedger(name: String, ownerUserId: String) {
        family = .sample(name: name, ownerUserId: ownerUserId)
        detail = .sample(name: name, ownerUserId: ownerUserId)
        ledgerItems = [.personal(current: false), .shared(current: true)]
    }

    private func leaveSharedLedger() {
        family = nil
        detail = nil
        ledgerItems = [.personal(current: true)]
    }
}

private extension LedgerInfo {
    static func personal(current: Bool) -> LedgerInfo {
        LedgerInfo(id: "personal", name: "个人账本", currency: "CNY", isDefault: true, familyId: nil, isCurrent: current)
    }

    static func shared(current: Bool) -> LedgerInfo {
        LedgerInfo(id: "shared", name: "旧内部名称", currency: "CNY", isDefault: false, familyId: "family", isCurrent: current)
    }
}

private extension Family {
    static func sample(name: String = "我们的共享账本", ownerUserId: String) -> Family {
        Family(
            id: "family",
            name: name,
            ownerUserId: ownerUserId,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z"
        )
    }
}

private extension FamilyDetail {
    static func sample(name: String = "我们的共享账本", ownerUserId: String) -> FamilyDetail {
        let members = ownerUserId == "me"
            ? [FamilyMember(userId: "me", nickname: "我", role: "owner", joinedAt: "2026-01-01T00:00:00Z")]
            : [
                FamilyMember(userId: ownerUserId, nickname: "所有者", role: "owner", joinedAt: "2026-01-01T00:00:00Z"),
                FamilyMember(userId: "me", nickname: "我", role: "member", joinedAt: "2026-01-01T00:00:00Z")
            ]

        return FamilyDetail(
            id: "family",
            name: name,
            ownerUserId: ownerUserId,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            members: members,
            ledgers: [FamilyLedgerInfo(id: "shared", name: name, currency: "CNY")],
            invitations: []
        )
    }
}

private extension PendingInvitation {
    static func sample(id: String) -> PendingInvitation {
        PendingInvitation(
            id: id,
            familyId: "inviting-family",
            familyName: "邀请来的共享账本",
            inviterNickname: "邀请人",
            createdAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-08T00:00:00Z"
        )
    }
}
