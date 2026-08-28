//
//  LockView.swift
//  Tally
//
//  Privacy lock overlay shown at launch when biometric lock is enabled.
//

import SwiftUI
import SwiftData

public struct LockView: View {
    @Environment(\.modelContext) private var context
    @Query private var settingsList: [AppSettings]
    public let onResult: (Bool) -> Void

    @State private var isAuthenticating = false

    public init(onResult: @escaping (Bool) -> Void) {
        self.onResult = onResult
    }

    public var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: lockIcon)
                .font(.system(size: 60))
                .foregroundStyle(Color.accentColor)
            Text("Tally 已锁定")
                .font(.title2.bold())
            Text("你的账目仅保存在本机，使用 \(LockService.biometryKind.displayName) 解锁")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                authenticate()
            } label: {
                if isAuthenticating {
                    ProgressView()
                } else {
                    Label("立即解锁", systemImage: lockIcon)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isAuthenticating)
            .padding(.top, 8)
            Spacer()
            Spacer()
        }
        .padding(32)
        .task {
            authenticate()
        }
    }

    private var lockIcon: String {
        switch LockService.biometryKind {
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        default: return "lock.fill"
        }
    }

    private func authenticate() {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        Task {
            let ok = await LockService.authenticate(reason: "解锁 Tally")
            await MainActor.run {
                isAuthenticating = false
                onResult(ok)
            }
        }
    }
}
