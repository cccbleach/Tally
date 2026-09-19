import XCTest
@testable import Tally

// 金额格式化/解析回归（全站人民币）。
//
// 历史缺陷：Money.swift 曾把币种/符号/locale 全部写死 CNY/¥/zh_CN，而模型与后端当时
// 支持多币种，展示层被硬编码掐死：美元账户余额显示成 ¥、向美元账户记账会被服务端 400 拒绝。
// 2026-09 多币种与汇率整体下线，全站只剩人民币，但下面这些不变量仍然要守住：
//   1) 格式化按人民币 2 位小数输出、千分位正确、负数带减号；
//   2) 输入解析纯整数运算（不经过 Double），小数位超精度拒绝而不是静默丢精度；
//   3) 解析溢出返回 nil 而不是崩溃。
final class MoneyCurrencyTests: XCTestCase {

    // MARK: - 格式化

    func testCNYFormattingWithGrouping() {
        XCTAssertEqual(Money.format(123456), "¥1,234.56")
        XCTAssertEqual(Money.format(0), "¥0.00")
        XCTAssertEqual(Money.format(9), "¥0.09")
        XCTAssertEqual(Money.format(-500), "-¥5.00")
        XCTAssertEqual(Money.format(123456789), "¥1,234,567.89")
    }

    func testCurrencyIsCNYOnly() {
        XCTAssertEqual(Money.currency.code, "CNY")
        XCTAssertEqual(Money.currency.symbol, "¥")
        XCTAssertEqual(Money.currency.minorUnits, 2)
        XCTAssertEqual(Money.currency.scale, 100)
        XCTAssertEqual(Currencies.cny.code, "CNY")
    }

    func testSignedAmounts() {
        XCTAssertEqual(Money.signed(-500), "-¥5.00")
        XCTAssertEqual(Money.signed(500), "¥5.00")
        XCTAssertEqual(Money.signed(0), "¥0.00")
    }

    func testDecimalStringHasNoGroupingForInputPrefillAndCSV() {
        XCTAssertEqual(Currencies.cny.decimalString(123456), "1234.56")
        XCTAssertEqual(Currencies.cny.decimalString(-123456), "-1234.56")
        XCTAssertEqual(Currencies.cny.decimalString(9), "0.09")
    }

    // MARK: - 输入解析（纯整数运算）

    func testParseBasicDecimalInput() {
        XCTAssertEqual(Money.minorUnits(fromInput: "19.99"), 1999)
        XCTAssertEqual(Money.minorUnits(fromInput: "0.1"), 10)
        XCTAssertEqual(Money.minorUnits(fromInput: "12.5"), 1250)
        XCTAssertEqual(Money.minorUnits(fromInput: "0"), 0)
        XCTAssertEqual(Money.minorUnits(fromInput: "-12.5"), -1250)
        XCTAssertEqual(Money.minorUnits(fromInput: "+1"), 100)
        XCTAssertEqual(Money.minorUnits(fromInput: "¥12.5"), 1250, "带币种符号应可解析")
        XCTAssertEqual(Money.minorUnits(fromInput: " 12.5 "), 1250)
    }

    func testParseGroupingAndCommaDecimal() {
        XCTAssertEqual(Money.minorUnits(fromInput: "1,234.56"), 123456, "逗号作千分位")
        XCTAssertEqual(Money.minorUnits(fromInput: "1,234,567"), 123456700, "多个同类分隔符视为千分位")
        XCTAssertEqual(Money.minorUnits(fromInput: "1.234.567"), 123456700, "欧式千分位（点分组）")
        XCTAssertEqual(Money.minorUnits(fromInput: "12,5"), 1250, "单个逗号按小数点处理")
        XCTAssertEqual(Money.minorUnits(fromInput: "12，5"), 1250, "全角逗号容错")
    }

    func testParseRejectsInvalidInput() {
        XCTAssertNil(Money.minorUnits(fromInput: ""))
        XCTAssertNil(Money.minorUnits(fromInput: "abc"))
        XCTAssertNil(Money.minorUnits(fromInput: "1.2.3.4"), "畸形分组应拒绝")
        XCTAssertNil(Money.minorUnits(fromInput: "1.2.3"), "分组长度不是 3 应拒绝")
        XCTAssertNil(Money.minorUnits(fromInput: "12-3"), "中缀符号非法")
        XCTAssertNil(Money.minorUnits(fromInput: "--5"), "重复符号非法")
    }

    func testParseRejectsExcessPrecisionInsteadOfSilentlyTruncating() {
        XCTAssertNil(Money.minorUnits(fromInput: "12.345"), "人民币输入 3 位小数必须拒绝")
        XCTAssertNil(Money.minorUnits(fromInput: "0.005"))
    }

    func testParseOverflowReturnsNil() {
        XCTAssertNil(Money.minorUnits(fromInput: "999999999999999999.99"), "超出 Int64 范围必须返回 nil 而不是崩溃")
        XCTAssertEqual(Money.minorUnits(fromInput: "92233720368547758.07"), 9223372036854775807, "Int64 上限金额可解析")
    }
}
