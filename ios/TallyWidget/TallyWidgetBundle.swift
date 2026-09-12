import SwiftUI
import WidgetKit

// 一键记账小组件（launcher 型）：
//
// 整块点按通过 widgetURL 触发 tally://add 深链，由主 App 的 RootView 弹出记账表单。
// 刻意不做数据展示（余额/统计）——那需要 App Group 共享与密钥访问组签名，
// 在 CI 无签名环境不可验证；纯入口设计让本组件在模拟器构建与真机签名环境行为一致。
// 数据型小组件等签名环境就绪后再演进。

struct QuickAddEntry: TimelineEntry {
    let date: Date
}

struct QuickAddProvider: TimelineProvider {
    func placeholder(in context: Context) -> QuickAddEntry {
        QuickAddEntry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (QuickAddEntry) -> Void) {
        completion(QuickAddEntry(date: .now))
    }

    // 纯入口组件没有随时间变化的内容：一条时间线 + .never 即可，不占刷新预算
    func getTimeline(in context: Context, completion: @escaping (Timeline<QuickAddEntry>) -> Void) {
        completion(Timeline(entries: [QuickAddEntry(date: .now)], policy: .never))
    }
}

struct QuickAddEntryView: View {
    let entry: QuickAddEntry

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.white)
            Text("记一笔")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Text("3 秒完成记账")
                .font(.system(size: 10))
                .foregroundStyle(.white.opacity(0.8))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            LinearGradient(
                colors: [Color(red: 0.22, green: 0.52, blue: 0.96), Color(red: 0.42, green: 0.66, blue: 0.99)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .widgetURL(URL(string: "tally://add"))
        .accessibilityLabel("记一笔：打开记账表单")
    }
}

struct QuickAddWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "TallyQuickAdd", provider: QuickAddProvider()) { entry in
            QuickAddEntryView(entry: entry)
        }
        .configurationDisplayName("一键记账")
        .description("点按直接打开 Tally 的记账表单，配合快捷指令实现快速记账。")
        .supportedFamilies([.systemSmall])
    }
}

@main
struct TallyWidgetBundle: WidgetBundle {
    var body: some Widget {
        QuickAddWidget()
    }
}
