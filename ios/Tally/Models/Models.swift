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

// MARK: - 账户

struct Account: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var type: String
    var currency: String
    var initialBalance: Int
    var icon: String?
    var color: String?
    var isArchived: Bool
    var isLiability: Bool?
    var balance: Int
    var debt: Int?  // 负债账户当前欠款（本币正数），非负债账户为 0
    let createdAt: String
}

// MARK: - 分类

struct Category: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var type: String
    var icon: String?
    var color: String?
    var sortOrder: Int
}

// MARK: - 流水

struct Transaction: Codable, Identifiable, Hashable {
    let id: String
    var accountId: String
    var categoryId: String?
    var type: String
    var amount: Int
    var currency: String
    var note: String?
    var date: String
    var transferToAccountId: String?
    let createdAt: String
    var updatedAt: String
    var accountName: String?
    var categoryName: String?
    var categoryIcon: String?
    var categoryColor: String?
    var transferToAccountName: String?
    var sourceType: String?
    // 一次还款拆分的本金/利息流水共用同一分组 ID，用于追溯
    var paymentGroupId: String?
}

struct TransactionsResponse: Codable {
    let items: [Transaction]
    let total: Int
    let page: Int
    let limit: Int
}

// MARK: - 预算

struct Budget: Codable, Identifiable, Hashable {
    let id: String
    let year: Int
    let month: Int
    let categoryId: String?
    let amount: Int
    let spent: Int
    let percent: Double
}

struct BudgetsResponse: Codable {
    let year: Int
    let month: Int
    let items: [Budget]
}

struct BudgetOverview: Codable {
    let year: Int
    let month: Int
    let totalBudget: Int
    let totalSpent: Int
    let totalPercent: Double
    let items: [BudgetOverviewItem]
}

struct BudgetOverviewItem: Codable, Identifiable, Hashable {
    let budgetId: String
    let categoryId: String?
    let categoryName: String
    let budget: Int
    let spent: Int
    let percent: Double
    var id: String { budgetId }
}

// MARK: - 周期账单

struct RecurringBill: Codable, Identifiable, Hashable {
    let id: String
    var accountId: String
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
    var accountName: String?
    var categoryName: String?
}

// MARK: - 统计

struct StatsSummary: Codable {
    let year: Int
    let month: Int
    let income: Int
    let expense: Int
    let net: Int
    let balance: Int
    let totalAssets: Int?
    let totalDebt: Int?
    let byCategory: [CategoryStat]
    let byAccount: [AccountStat]
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

struct AccountStat: Codable, Hashable {
    let accountId: String
    let name: String
    let amount: Int
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
    let currency: String
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
    let currency: String
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

struct LiabilitySummary: Codable {
    let totalDebt: Int
    let creditCards: [CreditCardLiability]
    let loans: [LoanItem]
    let creditCardBills: [CreditCardBillItem]
}

struct CreditCardLiability: Codable, Identifiable, Hashable {
    let accountId: String
    let name: String
    let debt: Int
    let creditLimit: Int?
    let billingDay: Int?
    let repaymentDay: Int?
    var id: String { accountId }
}

struct LoanItem: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let type: String
    var currency: String?
    let remainingPrincipal: Int
    let monthlyPayment: Int
    let nextPaymentDate: String?
    var accountId: String?
    // 贷款负债账户（type=loan），其负余额 = 剩余本金
    var liabilityAccountId: String?
    var status: String?
}

struct CreditCardBillItem: Codable, Identifiable, Hashable {
    let id: String
    let accountId: String
    let period: String
    let statementBalance: Int
    let minimumPayment: Int
    let dueDate: String?
    let paid: Bool
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
    let currency: String
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
