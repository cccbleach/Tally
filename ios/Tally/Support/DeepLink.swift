import Foundation

/// 深链路由：目前支持 tally://add（小组件/快捷指令一键记账）。
/// 纯函数解析，可单测；未知链接返回 nil（不响应，不崩溃）。
enum DeepLink {
    enum Route: String, Identifiable {
        case add

        var id: String { rawValue }
    }

    /// 解析 tally:// 链接：host 即路由名（tally://add → .add）。
    /// 大小写不敏感；带路径/查询参数也接受（tally://add?amount=25 预留扩展）。
    static func route(for url: URL) -> Route? {
        guard url.scheme?.lowercased() == "tally" else { return nil }
        guard let host = url.host?.lowercased() else { return nil }
        return Route(rawValue: host)
    }
}
