import SwiftUI

// MARK: - 颜色与图标

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        var rgb: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgb)
        let r = Double((rgb >> 16) & 0xFF) / 255.0
        let g = Double((rgb >> 8) & 0xFF) / 255.0
        let b = Double(rgb & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

func colorFor(hex: String?) -> Color {
    guard let h = hex, !h.isEmpty else { return .accentColor }
    return Color(hex: h)
}

func typeColor(_ type: String) -> Color {
    switch type {
    case "income": return .green
    case "expense": return .red
    case "transfer": return .blue
    default: return .primary
    }
}

func categoryIcon(_ name: String?) -> String {
    guard let n = name, !n.isEmpty else { return "circle.fill" }
    return n
}

// MARK: - 通用组件

struct CategoryBadge: View {
    let icon: String?
    let color: String?
    var body: some View {
        ZStack {
            Circle().fill(colorFor(hex: color).opacity(0.16))
            Image(systemName: categoryIcon(icon))
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(colorFor(hex: color))
        }
        .frame(width: 34, height: 34)
    }
}

struct AmountLabel: View {
    let amount: Int
    let type: String
    /// 金额所属币种（流水按自身币种展示）；nil = 账本本位币
    var currency: String?

    var body: some View {
        let prefix = type == "income" ? "+" : (type == "expense" ? "-" : "")
        Text(prefix + Money.formatMagnitude(amount, currency: currency))
            .font(.system(.body, design: .rounded).weight(.semibold))
            .foregroundColor(typeColor(type))
            .monospacedDigit()
    }
}

struct MonthSwitcher: View {
    @Environment(DataStore.self) private var store
    var body: some View {
        HStack(spacing: 12) {
            Button {
                store.moveMonth(by: -1)
                Task { await store.loadAll() }
            } label: {
                Image(systemName: "chevron.left")
            }
            Text(TallyDate.monthLabel(year: store.selectedYear, month: store.selectedMonth))
                .font(.headline)
                .frame(minWidth: 120)
            Button {
                store.moveMonth(by: 1)
                Task { await store.loadAll() }
            } label: {
                Image(systemName: "chevron.right")
            }
        }
    }
}

extension View {
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert(
            "提示",
            isPresented: Binding(
                get: { message.wrappedValue != nil },
                set: { if !$0 { message.wrappedValue = nil } }
            ),
            actions: { Button("好", role: .cancel) {} },
            message: { Text(message.wrappedValue ?? "") }
        )
    }
}
