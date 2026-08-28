//
//  TallyApp.swift
//  Tally
//
//  Application entry point. Sets up the local SwiftData store.
//

import SwiftUI
import SwiftData

@main
struct TallyApp: App {
    let container: ModelContainer?
    let startupError: String?

    @MainActor
    init() {
        do {
            let isUITesting = ProcessInfo.processInfo.arguments.contains("-uiTesting")
            container = try PersistenceController.makeContainer(isStoredInMemoryOnly: isUITesting)
            startupError = nil
        } catch {
            container = nil
            startupError = error.localizedDescription
        }
    }

    var body: some Scene {
        WindowGroup {
            if let container {
                RootView()
                    .modelContainer(container)
            } else {
                StartupFailureView(message: startupError ?? "未知错误")
            }
        }
    }
}

private struct StartupFailureView: View {
    let message: String

    var body: some View {
        ContentUnavailableView {
            Label("无法打开本地账本", systemImage: "externaldrive.badge.exclamationmark")
        } description: {
            Text("Tally 没有清除或重建你的数据。请重新启动 App；若问题持续，请先保留 App 数据并联系支持。\n\n\(message)")
        }
        .padding()
    }
}

/// Builds the SwiftData container and seeds first-launch data.
public enum PersistenceController {

    public static let modelTypes: [any PersistentModel.Type] = [
        Ledger.self,
        Account.self,
        Category.self,
        Transaction.self,
        Budget.self,
        AppSettings.self,
    ]

    public static let schema = Schema(versionedSchema: TallySchemaV1.self)

    @MainActor
    public static func makeContainer(isStoredInMemoryOnly: Bool = false) throws -> ModelContainer {
        if !isStoredInMemoryOnly {
            // On a truly fresh install the Application Support directory that
            // holds `default.store` may not exist yet. Creating it up front
            // avoids a noisy CoreData "Failed to create file" error on first
            // launch (CoreData would otherwise auto-recover after logging).
            let fileManager = FileManager.default
            let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first!
                    .appendingPathComponent("Application Support", isDirectory: true)
            try fileManager.createDirectory(at: base, withIntermediateDirectories: true)
        }
        let configuration = ModelConfiguration(
            schema: schema,
            isStoredInMemoryOnly: isStoredInMemoryOnly,
            cloudKitDatabase: .none
        )
        let container = try ModelContainer(
            for: schema,
            migrationPlan: TallyMigrationPlan.self,
            configurations: [configuration]
        )
        try seedIfNeeded(context: container.mainContext)
        return container
    }

    /// Seed a default ledger, categories, accounts and settings on first run.
    @MainActor
    public static func seedIfNeeded(context: ModelContext, save: Bool = true) throws {
        let settingsFetch = FetchDescriptor<AppSettings>()
        let existing = try context.fetch(settingsFetch)
        if let first = existing.first {
            // Already initialised; keep settings.
            _ = first
            return
        }

        let settings = AppSettings()
        settings.hasCompletedOnboarding = false
        settings.defaultCurrencyCode = "CNY"
        settings.monthStartsOn = 1
        context.insert(settings)

        let ledger = Ledger(name: "个人账本", icon: "book", colorHex: "0A84FF", currencyCode: "CNY", isDefault: true)
        context.insert(ledger)

        let categories = SeedData.makeDefaultCategories()
        for category in categories {
            category.ledger = ledger
            context.insert(category)
        }

        for account in SeedData.makeDefaultAccounts(currencyCode: ledger.currencyCode) {
            account.ledger = ledger
            context.insert(account)
        }

        settings.defaultLedgerID = ledger.id
        if save {
            try context.save()
        }
    }

    @MainActor
    public static func resetAllData(context: ModelContext) throws {
        let previousAutosave = context.autosaveEnabled
        context.autosaveEnabled = false
        defer { context.autosaveEnabled = previousAutosave }
        do {
            try context.transaction {
                for ledger in try context.fetch(FetchDescriptor<Ledger>()) { context.delete(ledger) }
                for settings in try context.fetch(FetchDescriptor<AppSettings>()) { context.delete(settings) }
                try seedIfNeeded(context: context, save: false)
            }
        } catch {
            context.rollback()
            throw error
        }
    }
}

/// Version 1 is the explicit baseline for all future model evolution. New
/// releases that alter stored properties must add a new VersionedSchema and a
/// migration stage instead of relying on an implicit, untracked schema change.
public enum TallySchemaV1: VersionedSchema {
    public static let versionIdentifier = Schema.Version(1, 0, 0)
    public static var models: [any PersistentModel.Type] { PersistenceController.modelTypes }
}

public enum TallyMigrationPlan: SchemaMigrationPlan {
    public static var schemas: [any VersionedSchema.Type] { [TallySchemaV1.self] }
    public static var stages: [MigrationStage] { [] }
}
