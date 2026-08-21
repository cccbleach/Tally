import SwiftUI
import UniformTypeIdentifiers

/// 暂存导入（阶段 3）：上传 → 预览明细 → 逐项 accept/skip → 批量提交
struct StagedImportView: View {
    @Environment(DataStore.self) private var store
    @State private var source: BillSource = .wechat
    @State private var showPicker = false
    @State private var job: ImportJob?
    @State private var items: [ImportItem] = []
    @State private var isLoading = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("账单来源") {
                Picker("来源", selection: $source) {
                    ForEach(BillSource.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(isLoading || job != nil)
            }

            if job == nil {
                Section("上传文件") {
                    Button {
                        showPicker = true
                    } label: {
                        if isLoading {
                            ProgressView()
                        } else {
                            Label("选择账单文件（txt / csv / xlsx / pdf）", systemImage: "square.and.arrow.up")
                        }
                    }
                    .disabled(isLoading)
                    Text("微信：我 → 服务 → 钱包 → 账单 → 导出账单\n支付宝：我的 → 账单 → … → 开具交易流水\n银行：App 导出交易流水")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            if let job {
                Section("任务 \(job.id.prefix(8)) · \(job.status)") {
                    LabeledContent("来源", value: job.source)
                    LabeledContent("文件", value: job.filename ?? "-")
                    LabeledContent("明细", value: "\(items.count) 条")
                }

                Section("预览与确认") {
                    ForEach(items) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(item.rawDescription ?? item.merchant ?? "-").font(.headline)
                                Spacer()
                                Text(typeLabel(item.type)).font(.caption).foregroundColor(.secondary)
                            }
                            HStack {
                                Text(item.occurredAt).font(.caption).foregroundColor(.secondary)
                                Spacer()
                                Text(Money.format(item.amount)).font(.subheadline)
                            }
                            HStack {
                                if item.duplicateStatus == "duplicate" {
                                    Text("疑似重复").font(.caption).foregroundColor(.orange)
                                }
                                Spacer()
                                Picker("", selection: Binding(
                                    get: { item.decision },
                                    set: { new in Task { await decide(item.id, decision: new) } }
                                )) {
                                    Text("导入").tag("accept")
                                    Text("跳过").tag("skip")
                                }
                                .pickerStyle(.segmented)
                                .frame(width: 160)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .disabled(job.status != "staged")

                Section {
                    Button {
                        Task { await commit() }
                    } label: {
                        if isLoading {
                            ProgressView()
                        } else {
                            Text("提交 \(acceptedCount) 条为正式流水")
                        }
                    }
                    .disabled(isLoading || job.status != "staged" || acceptedCount == 0)
                }
            }

            if let message {
                Section { Text(message).foregroundColor(.green) }
            }
        }
        .navigationTitle("暂存导入")
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url):
                Task { await upload(url) }
            case .failure(let error):
                errorMessage = error.localizedDescription
            }
        }
        .errorAlert($errorMessage)
    }

    private var acceptedCount: Int {
        items.filter { $0.decision == "accept" }.count
    }

    private func typeLabel(_ t: String) -> String {
        t == "income" ? "收入" : "支出"
    }

    private func upload(_ url: URL) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let created = try await APIService.shared.uploadImportFile(source: source.apiValue, fileURL: url)
            job = created
            await loadDetail(created.id)
            message = "已解析并暂存，请确认明细后提交"
        } catch {
            errorMessage = "上传失败：" + error.localizedDescription
        }
    }

    private func loadDetail(_ id: String) async {
        do {
            let detail = try await APIService.shared.importJob(id: id)
            job = detail.job
            items = detail.items
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func decide(_ id: String, decision: String) async {
        do {
            try await APIService.shared.decideImportItem(id: id, decision: decision)
            items = items.map { $0.id == id ? ImportItem(id: $0.id, jobId: $0.jobId, externalId: $0.externalId, occurredAt: $0.occurredAt, type: $0.type, amount: $0.amount, currency: $0.currency, merchant: $0.merchant, rawDescription: $0.rawDescription, duplicateStatus: $0.duplicateStatus, matchedTransactionId: $0.matchedTransactionId, decision: decision) : $0 }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func commit() async {
        isLoading = true
        defer { isLoading = false }
        guard let job else { return }
        do {
            let res = try await APIService.shared.commitImportJob(id: job.id)
            message = "导入成功 \(res.imported) 条，跳过 \(res.skipped) 条"
            await store.loadAll()
            await loadDetail(job.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
