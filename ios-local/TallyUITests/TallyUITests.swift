import XCTest

final class TallyUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uiTesting"]
        app.launch()
    }

    private func completeOnboarding() {
        let button = app.buttons["completeOnboardingButton"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
        XCTAssertTrue(app.navigationBars["个人账本"].waitForExistence(timeout: 5))
    }

    func testOnboardingAndRecordExpenseEndToEnd() {
        completeOnboarding()

        let quickAdd = app.buttons["quickAddButton"]
        XCTAssertTrue(quickAdd.waitForExistence(timeout: 3))
        quickAdd.tap()

        let amount = app.textFields["transactionAmountField"]
        XCTAssertTrue(amount.waitForExistence(timeout: 3))
        amount.tap()
        amount.typeText("12.50")
        app.buttons["saveTransactionButton"].tap()

        let summary = app.descendants(matching: .any)["summaryCard"]
        XCTAssertTrue(summary.waitForExistence(timeout: 5))
        XCTAssertTrue(summary.label.contains("支出¥12.50"), "Unexpected summary: \(summary.label)")
    }

    func testTransactionFiltersAreReachable() {
        completeOnboarding()
        app.tabBars.buttons["明细"].tap()

        let filter = app.buttons["transactionFilterButton"]
        XCTAssertTrue(filter.waitForExistence(timeout: 3))
        filter.tap()
        XCTAssertTrue(app.navigationBars["筛选交易"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.switches["限定日期范围"].exists)
        XCTAssertTrue(app.textFields["最低金额（可选）"].exists)
        XCTAssertTrue(app.textFields["最高金额（可选）"].exists)
    }
}
