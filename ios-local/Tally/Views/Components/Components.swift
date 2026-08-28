//
//  Components.swift
//  Tally
//
//  Small reusable UI pieces.
//

import SwiftUI

/// A circle bearing an SF Symbol, used for categories/accounts.
public struct IconBadge: View {
    public let icon: String
    public let colorHex: String
    public var size: CGFloat = 40

    public var body: some View {
        let color = Color(hex: colorHex)
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(color.opacity(0.16))
            Image(systemName: icon)
                .font(.system(size: size * 0.46, weight: .medium))
                .foregroundStyle(color)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

public extension Color {
    init(hex: String) {
        var value: UInt64 = 0
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        cleaned = cleaned.replacingOccurrences(of: "#", with: "")
        Scanner(string: cleaned).scanHexInt64(&value)
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

/// Amount input that collects a decimal string and exposes minor units.
public struct AmountField: View {
    @Binding public var text: String
    public var currencyCode: String
    public var prompt: String = "0.00"
    public var font: Font = .system(size: 40, weight: .bold, design: .rounded)

    public var body: some View {
        TextField(prompt, text: $text)
            .keyboardType(.decimalPad)
            .multilineTextAlignment(.center)
            .font(font)
            .accessibilityLabel("金额")
    }
}

/// Helpers for parsing amount text.
public enum AmountParser {
    /// Returns minor units or nil if the text cannot be parsed.
    public static func parse(_ text: String, currencyCode: String) -> Int64? {
        let info = Currencies.info(forCode: currencyCode)
        return info.minorUnits(fromString: text)
    }

    /// Format a value back into an editable string.
    public static func makeText(minorUnits: Int64, currencyCode: String) -> String {
        Currencies.info(forCode: currencyCode).string(fromMinorUnits: minorUnits)
    }
}

public struct EmptyStateView: View {
    public let icon: String
    public let title: String
    public let message: String

    public var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(32)
        .accessibilityElement(children: .combine)
    }
}

/// A labelled progress bar with a colour that shifts when over budget.
public struct ProgressBarView: View {
    public let ratio: Double
    public let color: Color

    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(.systemFill))
                Capsule()
                    .fill(color)
                    .frame(width: max(0, min(1, ratio)) * proxy.size.width)
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }
}

public struct AmountText: View {
    public let money: Money
    public var color: Color?
    public var font: Font = .body.bold()

    public var body: some View {
        Text(money.formatted)
            .font(font)
            .foregroundStyle(color ?? (money.minorUnits < 0 ? Color.red : Color.primary))
            .accessibilityLabel(money.formatted)
    }
}
