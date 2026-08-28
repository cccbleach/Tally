//
//  SeedData.swift
//  Tally
//
//  Default categories/accounts for a newly created ledger.
//

import Foundation

public enum SeedData {

    public struct CategorySeed {
        public let name: String
        public let icon: String
        public let colorHex: String
        public let kind: CategoryKind
    }

    // 默认支出分类
    public static let expenseCategories: [CategorySeed] = [
        CategorySeed(name: "餐饮", icon: "fork.knife", colorHex: "FF9F0A", kind: .expense),
        CategorySeed(name: "交通", icon: "bus.fill", colorHex: "0A84FF", kind: .expense),
        CategorySeed(name: "购物", icon: "bag.fill", colorHex: "FF375F", kind: .expense),
        CategorySeed(name: "居住", icon: "house.fill", colorHex: "64D2FF", kind: .expense),
        CategorySeed(name: "娱乐", icon: "gamecontroller.fill", colorHex: "AF52DE", kind: .expense),
        CategorySeed(name: "医疗", icon: "cross.case.fill", colorHex: "FF3B30", kind: .expense),
        CategorySeed(name: "教育", icon: "book.fill", colorHex: "5E5CE6", kind: .expense),
        CategorySeed(name: "人情", icon: "gift.fill", colorHex: "FFD60A", kind: .expense),
        CategorySeed(name: "其他", icon: "ellipsis.circle.fill", colorHex: "98989D", kind: .expense),
    ]

    // 默认收入分类
    public static let incomeCategories: [CategorySeed] = [
        CategorySeed(name: "工资", icon: "creditcard.fill", colorHex: "32D74B", kind: .income),
        CategorySeed(name: "奖金", icon: "star.fill", colorHex: "FFD60A", kind: .income),
        CategorySeed(name: "理财", icon: "chart.line.uptrend.xyaxis", colorHex: "64D2FF", kind: .income),
        CategorySeed(name: "其他收入", icon: "plus.circle.fill", colorHex: "98989D", kind: .income),
    ]

    public static func makeDefaultCategories() -> [Category] {
        var result: [Category] = []
        var order = 0
        for seed in expenseCategories + incomeCategories {
            let category = Category(
                name: seed.name,
                icon: seed.icon,
                colorHex: seed.colorHex,
                kind: seed.kind,
                isSystem: true,
                isEnabled: true,
                sortOrder: order
            )
            result.append(category)
            order += 1
        }
        return result
    }

    public static func makeDefaultAccounts(currencyCode: String) -> [Account] {
        [
            Account(name: "现金", kind: .cash, currencyCode: currencyCode, sortOrder: 0),
            Account(name: "银行卡", kind: .debit, currencyCode: currencyCode, sortOrder: 1),
            Account(name: "电子钱包", kind: .ewallet, currencyCode: currencyCode, sortOrder: 2),
        ]
    }
}
