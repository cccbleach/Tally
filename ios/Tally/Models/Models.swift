import Foundation

// MARK: - 认证

struct User: Codable, Identifiable, Hashable {
    let id: String
    let phone: String
    let nickname: String
    let nicknameChangeAvailableAt: String?
    let createdAt: String
    // 脱敏手机号（+86 138****0001），仅本人资料接口返回
    var phoneMasked: String?
}

struct AuthResponse: Codable {
    let status: String // authenticated
    let user: User
    let token: String
    let refreshToken: String
}

// 验证码登录判别联合：已完整账号直接登录；新账号/旧“用户”账号需先完成强制昵称设置
struct LoginCodeResponse: Codable {
    let status: String // authenticated | nickname_required
    let user: User?
    let token: String?
    let refreshToken: String?
    let onboardingToken: String?
    let expiresAt: String?
}

struct RefreshResponse: Codable {
    let token: String
    let refreshToken: String
}

struct UserResponse: Codable {
    let user: User
}

struct NicknameCheckResponse: Codable {
    let available: Bool
    let reason: String?
}

// MARK: - 分类

struct Category: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var type: String
    var icon: String?
    var color: String?
    var sortOrder: Int
    var updatedAt: String?
}

// MARK: - 流水

struct Transaction: Codable, Identifiable, Hashable {
    let id: String
    var categoryId: String?
    var type: String
    var amount: Int
    var note: String?
    var date: String
    let createdAt: String
    var updatedAt: String
    var categoryName: String?
    var categoryIcon: String?
    var categoryColor: String?
    var sourceType: String?
}

struct TransactionsResponse: Codable {
    let items: [Transaction]
    let total: Int
    let page: Int
    let limit: Int
}

// MARK: - 周期账单

struct RecurringBill: Codable, Identifiable, Hashable {
    let id: String
    var categoryId: String?
    var type: String
    var amount: Int
    var note: String?
    var frequency: String
    var interval: Int
    var startDate: String
    var endDate: String?
    var nextRunDate: String
    var lastGeneratedDate: String?
    var isActive: Bool
    var categoryName: String?
}

// MARK: - 统计

struct StatsSummary: Codable {
    let year: Int
    let month: Int
    let income: Int
    let expense: Int
    let net: Int
    /// 累计结余：该账本历史收入 − 支出（不依赖账户）。
    /// 可选是为了「新 App 还连着旧后端」的窗口期：旧后端不返回该字段，UI 自动隐藏。
    let cumulativeNet: Int?
    let byCategory: [CategoryStat]
    let daily: [DailyStat]
}

struct CategoryStat: Codable, Hashable {
    let categoryId: String?
    let name: String
    let icon: String?
    let color: String?
    let amount: Int
    let percent: Double
}

struct DailyStat: Codable, Hashable {
    let date: String
    let income: Int
    let expense: Int
}

struct TrendPoint: Codable, Hashable {
    let year: Int
    let month: Int
    let income: Int
    let expense: Int
}

struct TrendResponse: Codable {
    let months: [TrendPoint]
}

// MARK: - 通用包装

struct ListResponse<T: Codable>: Codable {
    let items: [T]
}

struct ItemResponse<T: Codable>: Codable {
    let item: T
}

struct OKResponse: Codable {
    let ok: Bool
}

struct ImportResult: Codable {
    let imported: Int
    let skipped: Int
    let total: Int
    let suspectedDuplicates: [SuspectedDuplicate]?
}

struct SuspectedDuplicate: Codable, Hashable {
    let dedupKey: String
    let existingId: String
}

struct APIErrorResponse: Codable {
    let error: APIErrorBody
}

struct APIErrorBody: Codable {
    let code: String
    let message: String
}

// MARK: - 家庭 / 账本 / 负债

struct Family: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let ownerUserId: String
    let createdAt: String
    let updatedAt: String
}

struct FamilyCreateResponse: Codable {
    let item: FamilyCreateItem
}

struct FamilyCreateItem: Codable {
    let id: String
    let name: String
    let ownerUserId: String
    let createdAt: String
    let updatedAt: String
    let ledgerId: String?
}

struct LedgerInfo: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let isDefault: Bool
    let familyId: String?
    let isCurrent: Bool
}

/// 家庭邀请箱条目（GET /families/invitations/pending）
struct PendingInvitation: Codable, Identifiable, Hashable {
    let id: String
    let familyId: String
    let familyName: String
    let inviterNickname: String
    let createdAt: String
    let expiresAt: String
}

struct PendingInvitationsResponse: Codable {
    let items: [PendingInvitation]
}

/// 创建家庭邀请的返回
struct InvitationCreateResponse: Codable {
    let item: InvitationCreateItem
}

struct InvitationCreateItem: Codable, Identifiable, Hashable {
    let id: String
    let targetUserId: String
    let targetNickname: String
    let expiresAt: String
    let status: String
}

/// 家庭成员（仅昵称，不返回手机号）
struct FamilyMember: Codable, Identifiable, Hashable {
    let userId: String
    let nickname: String
    let role: String
    let joinedAt: String
    var id: String { userId }
}

/// 家庭详情
struct FamilyDetail: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let ownerUserId: String
    let createdAt: String
    let updatedAt: String
    let members: [FamilyMember]
    let ledgers: [FamilyLedgerInfo]
    let invitations: [InvitationLine]
}

struct FamilyLedgerInfo: Codable, Identifiable, Hashable {
    let id: String
    let name: String
}

struct InvitationLine: Codable, Identifiable, Hashable {
    let id: String
    let targetUserId: String
    let inviterUserId: String
    let status: String
    let expiresAt: String
    let createdAt: String
}

struct FamilyDetailResponse: Codable {
    let item: FamilyDetail
}

struct ImportJob: Codable, Identifiable, Hashable {
    let id: String
    let ledgerId: String
    let source: String
    let filename: String?
    let fileHash: String?
    let status: String
    let totalCount: Int
    let importedCount: Int
    let skippedCount: Int
}

struct ImportItem: Codable, Identifiable, Hashable {
    let id: String
    let jobId: String
    let externalId: String?
    let occurredAt: String
    let type: String
    let amount: Int
    let merchant: String?
    let rawDescription: String?
    let duplicateStatus: String
    let matchedTransactionId: String?
    let decision: String
}

struct ImportJobDetail: Codable {
    let job: ImportJob
    let items: [ImportItem]
}

struct ImportCommitResult: Codable {
    let ok: Bool
    let imported: Int
    let skipped: Int
    let total: Int
}
