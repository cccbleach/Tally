import AppIntents
import Foundation

// 快捷指令自动记账（钱迹 iOS 官方同款路线：App Intents 框架）。
//
// 入口：快捷指令 App / Siri 短语「在 Tally 记一笔」/ 轻点背面 / 锁屏 / 操作按钮，
// 无需打开 App 即可完成记账（openAppWhenRun = false，Intent 在主 App 进程执行）。
//
// 无 UI 环境下的默认值策略：
// - 账户 = 第一个未归档账户；币种 = 该账户币种（服务端强制「流水币种 = 账户币种」）；
// - 分类 = 该类型的第一个分类（分类可空，列表会显示「未分类」）；
// - 日期 = 今天。
struct AddTransactionIntent: AppIntent {
    static var title: LocalizedStringResource = "记一笔"
    static var description = IntentDescription("快速记录一笔支出或收入到当前账本，无需打开 App")
    static var openAppWhenRun = false

    @Parameter(title: "金额")
    var amount: Double

    @Parameter(title: "类型", default: .expense)
    var kind: QuickAddKind

    @Parameter(title: "备注")
    var note: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let outcome = await QuickAddService.add(amountDouble: amount, kind: kind, note: note)
        return .result(dialog: IntentDialog(stringLiteral: outcome.message))
    }
}

enum QuickAddKind: String, AppEnum {
    case expense
    case income

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "收支类型")
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .expense: "支出",
        .income: "收入",
    ]
}

/// 快捷指令入口短语（系统会自动在快捷指令 App / Siri 建议 / 锁屏中列出）
struct TallyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddTransactionIntent(),
            phrases: ["在\(.applicationName)记一笔", "用\(.applicationName)记账"],
            shortTitle: "记一笔",
            systemImageName: "plus.circle.fill"
        )
    }
}

// MARK: - 记账执行（与 AuthServicing 同套路：抽依赖协议，单元测试注入替身）

protocol QuickAddServicing: Sendable {
    func accounts() async throws -> [Account]
    func categories() async throws -> [Category]
    func createTransaction(type: String, amount: Int, date: String, note: String?, accountId: String, categoryId: String?, transferToAccountId: String?, clientRequestId: String?) async throws -> Transaction
}

extension APIService: QuickAddServicing {}

enum QuickAddService {
    enum Outcome {
        case success(message: String)
        case failure(message: String)

        var message: String {
            switch self {
            case .success(let message), .failure(let message): return message
            }
        }
    }

    /// 快捷指令记账主流程。任何失败都转成用户可读的中文提示（快捷指令环境没有 UI 可以弹错误）。
    /// 断网时降级：用本地缓存的账户兜底入离线队列，联网后自动重放（与 App 内记账同一条队列）。
    static func add(
        amountDouble: Double,
        kind: QuickAddKind,
        note: String?,
        service: any QuickAddServicing = APIService.shared,
        hasSession: () -> Bool = { KeychainStore.loadToken() != nil },
        now: Date = Date()
    ) async -> Outcome {
        guard hasSession() else {
            return .failure(message: "尚未登录，请先打开 Tally 登录后再使用快捷记账")
        }
        // 快捷指令的金额参数是 Double：立即换算成整数最小单位，后续不再经过浮点。
        // 人民币是 2 位小数（×100）；这里用 Money 的精度而不是写死数字，避免将来改精度时漏改。
        guard amountDouble.isFinite, amountDouble > 0 else {
            return .failure(message: "金额无效，请输入大于 0 的数字")
        }
        // 空白/空字符串备注统一归一为 nil（快捷指令参数可能传空串）
        let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedNote = (trimmedNote?.isEmpty ?? true) ? nil : trimmedNote
        let clientRequestId = UUID().uuidString
        let dateText = TallyDate.dayFormatter.string(from: now)
        do {
            let accounts = try await service.accounts().filter { !$0.isArchived }
            guard let account = accounts.first else {
                return .failure(message: "当前账本还没有可用账户，请先打开 App 创建")
            }
            let scaled = amountDouble * Double(Money.currency.scale)
            // Double(Int.max) 会精度溢出，用 /2 留出取整与符号的安全余量；
            // 超大金额在快捷指令里可以直接传入，Int(Double) 越界会直接崩溃。
            guard scaled.isFinite, scaled <= Double(Int.max / 2) else {
                return .failure(message: "金额过大，请检查输入")
            }
            let minorUnits = Int(scaled.rounded())
            guard minorUnits > 0 else {
                return .failure(message: "金额过小")
            }
            let categories = try await service.categories()
            let category = categories.first { $0.type == kind.rawValue }

            let transaction = try await service.createTransaction(
                type: kind.rawValue,
                amount: minorUnits,
                date: dateText,
                note: normalizedNote,
                accountId: account.id,
                categoryId: category?.id,
                transferToAccountId: nil,
                clientRequestId: nil
            )
            let describe = Money.formatMagnitude(transaction.amount)
            return .success(message: "已记录\(kind == .expense ? "支出" : "收入") \(describe)（\(account.name)）")
        } catch APIError.unauthorized {
            return .failure(message: "登录已过期，请打开 Tally 重新登录")
        } catch let error as APIError {
            return .failure(message: "记账失败：\(error.localizedDescription)")
        } catch {
            // 网络类错误：尝试离线入队（读本地缓存账户；没有缓存账户才提示失败）。
            return await enqueueOfflineOrFail(
                amountDouble: amountDouble,
                kind: kind,
                note: normalizedNote,
                clientRequestId: clientRequestId,
                dateText: dateText,
                underlying: error
            )
        }
    }

    /// 断网降级：以缓存里的第一个活跃账户入队。
    /// 队列按当前命名空间隔离——快捷指令运行在 App 进程内，命名空间与 App 一致。
    private static func enqueueOfflineOrFail(
        amountDouble: Double,
        kind: QuickAddKind,
        note: String?,
        clientRequestId: String,
        dateText: String,
        underlying: Error
    ) async -> Outcome {
        let fallback: Account? = await MainActor.run {
            (LocalCache.load([Account].self, forKey: "accounts") ?? [])
                .first { !$0.isArchived }
        }
        guard let account = fallback else {
            return .failure(message: "网络不可用，且本地没有可用的账户缓存，请联网后重试（\(underlying.localizedDescription)）")
        }
        let scaled = amountDouble * Double(Money.currency.scale)
        guard scaled.isFinite, scaled <= Double(Int.max / 2) else {
            return .failure(message: "金额过大，请检查输入")
        }
        let minorUnits = Int(scaled.rounded())
        guard minorUnits > 0 else {
            return .failure(message: "金额过小")
        }
        await MainActor.run {
            PendingTransactionQueue.enqueue(QueuedTransaction(
                id: clientRequestId,
                type: kind.rawValue,
                amount: minorUnits,
                date: dateText,
                note: note,
                accountId: account.id,
                categoryId: nil,
                transferToAccountId: nil,
                queuedAt: Date()
            ))
        }
        let describe = Money.formatMagnitude(minorUnits)
        return .success(message: "当前离线：已保存\(kind == .expense ? "支出" : "收入") \(describe)（\(account.name)），联网后自动同步")
    }
}
