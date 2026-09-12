import XCTest
@testable import Tally

// 深链路由解析回归：小组件/快捷指令/Safari 入口的解析必须严格（未知链接不响应不崩溃）
final class DeepLinkTests: XCTestCase {
    private func url(_ s: String) -> URL { URL(string: s)! }

    func testAddRouteParsing() {
        XCTAssertEqual(DeepLink.route(for: url("tally://add")), .add)
        XCTAssertEqual(DeepLink.route(for: url("TALLY://ADD")), .add, "scheme/host 大小写不敏感")
        XCTAssertEqual(DeepLink.route(for: url("tally://add?amount=25")), .add, "查询参数不影响路由")
        XCTAssertEqual(DeepLink.route(for: url("tally://add/extra")), .add, "路径后缀不影响路由")
    }

    func testUnknownLinksReturnNil() {
        XCTAssertNil(DeepLink.route(for: url("tally://home")), "未定义的路由不响应")
        XCTAssertNil(DeepLink.route(for: url("tally://unknown")))
        XCTAssertNil(DeepLink.route(for: url("https://add")), "非 tally scheme 不处理")
        XCTAssertNil(DeepLink.route(for: url("tally://")), "缺 host 不崩溃")
        XCTAssertNil(DeepLink.route(for: url("weixin://add")))
    }
}
