import SwiftUI
import UIKit

/// 系统分享面板。导出文件是异步生成的（先拉全量流水再写临时文件），
/// ShareLink 需要渲染期就持有 URL，因此这里用 UIActivityViewController 包装。
struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
