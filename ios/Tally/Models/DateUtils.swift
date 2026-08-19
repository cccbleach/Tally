import Foundation

enum TallyDate {
    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    static func todayString() -> String {
        dayFormatter.string(from: Date())
    }

    static func currentYearMonth() -> (year: Int, month: Int) {
        let c = Calendar.current
        return (c.component(.year, from: Date()), c.component(.month, from: Date()))
    }

    static func monthRange(year: Int, month: Int) -> (from: String, to: String) {
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        guard let start = Calendar.current.date(from: comps) else {
            return (todayString(), todayString())
        }
        let end = Calendar.current.date(byAdding: DateComponents(month: 1, day: -1), to: start) ?? start
        return (dayFormatter.string(from: start), dayFormatter.string(from: end))
    }

    static func monthLabel(year: Int, month: Int) -> String {
        "\(year)年\(month)月"
    }

    // "yyyy-MM-dd" -> 展示文案（今天 / 昨天 / M月d日）
    static func display(_ date: String) -> String {
        if date == todayString() { return "今天" }
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date()
        if date == dayFormatter.string(from: yesterday) { return "昨天" }
        let parts = date.split(separator: "-")
        if parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) {
            return "\(m)月\(d)日"
        }
        return date
    }
}
