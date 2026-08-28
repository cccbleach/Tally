//
//  OnboardingView.swift
//  Tally
//
//  First-launch intro. Kept deliberately short: no account, no sign-up,
//  everything stays on the device.
//

import SwiftUI
import SwiftData

public struct OnboardingView: View {
    @Environment(\.modelContext) private var context
    @Query private var settingsList: [AppSettings]
    @State private var errorMessage: String?

    public init() {}

    public var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "chart.pie.fill")
                .font(.system(size: 64))
                .foregroundStyle(Color.accentColor)
            Text("欢迎使用 Tally")
                .font(.largeTitle.bold())
            Text("简单、快速、隐私优先的记账本")
                .font(.headline)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 14) {
                FeatureRow(icon: "checkmark.shield.fill", title: "数据只保存在本机", detail: "无需注册账号，默认离线可用")
                FeatureRow(icon: "bolt.fill", title: "快速记账", detail: "几秒钟记下每一笔")
                FeatureRow(icon: "chart.bar.xaxis", title: "清晰的统计与预算", detail: "了解钱花在哪里")
                FeatureRow(icon: "square.and.arrow.up", title: "数据由你掌控", detail: "随时导出 CSV 或完整备份")
            }
            .padding(.horizontal, 8)

            Spacer()

            Button {
                completeOnboarding()
            } label: {
                Text("开始记账")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .accessibilityIdentifier("completeOnboardingButton")
            .padding(.bottom, 20)
        }
        .padding(24)
        .alert("无法完成设置", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("好") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "未知错误")
        }
    }

    private func completeOnboarding() {
        guard let settings = settingsList.first else { return }
        settings.hasCompletedOnboarding = true
        do {
            try context.save()
        } catch {
            context.rollback()
            errorMessage = "本地数据保存失败：\(error.localizedDescription)"
        }
    }
}

private struct FeatureRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(Color.accentColor)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.bold())
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
