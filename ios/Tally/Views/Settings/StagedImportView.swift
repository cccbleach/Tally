import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// 统一账单导入：选择文件 / 截图识别 → 自动识别来源 → 预览确认 → 入账。
struct StagedImportView: View {
    @Environment(DataStore.self) private var store
    @State private var showPicker = false
    @State private var showAddAccount = false
    @State private var screenshotItem: PhotosPickerItem?
    @State private var job: ImportJob?
    @State private var items: [ImportItem] = []
    @State private var isLoading = false
    @State private var isRecognizing = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if job == nil {
                Section("导入账单") {
                    Text("微信、支付宝、银行账单都从这里导入，自动识别来源。预览确认后才会记入账本。")
                        .font(.subheadline)
                    if !hasActiveAccount {
                        Text("当前账本还没有入账账户，请先添加一个账户。")
                            .foregroundStyle(.secondary)
                        Button("添加账户") { showAddAccount = true }
                    }
                    Button {
                        showPicker = true
                    } label: {
                        if isLoading {
                            ProgressView()
                        } else {
                            Label("选择账单文件", systemImage: "doc.badge.plus")
                        }
                    }
                    .disabled(isLoading || isRecognizing || !hasActiveAccount)
                    Text("支持 TXT、CSV、XLSX、文字版 PDF。Excel 最大 5MB，其余文件最大 20MB；ZIP 请先解压，扫描件暂不支持。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("截图识别") {
                    PhotosPicker(selection: $screenshotItem, matching: .screenshots) {
                        if isRecognizing {
                            HStack { Text("正在识别截图…"); Spacer(); ProgressView() }
                        } else {
                            Label("从截图识别（微信/支付宝支付页）", systemImage: "text.viewfinder")
                        }
                    }
                    .disabled(isRecognizing || isLoading || !hasActiveAccount)
                    Text("识别在本机完成，截图不会上传；识别结果先进入预览，确认后才入账。同一张截图重复导入会自动去重。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("如何导出账单") {
                    Text("微信：我 → 服务 → 钱包 → 账单 → 导出账单\n支付宝：我的 → 账单 → … → 开具交易流水\n银行：App 导出交易流水")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            if let job {
                Section(job.status == "staged" ? "账单已识别" : "导入结果") {
                    LabeledContent("来源", value: sourceName(job.source))
                    LabeledContent("文件", value: job.filename ?? "-")
                    LabeledContent("明细", value: "\(items.count) 条")
                    if items.isEmpty {
                        Button("重新加载预览") {
                            Task {
                                do { try await loadDetail(job.id, ledgerId: job.ledgerId) }
                                catch { errorMessage = error.localizedDescription }
                            }
                        }
                    }
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
                                Text(Money.format(item.amount, currency: item.currency)).font(.subheadline)
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
                .disabled(job.status != "staged" || isLoading)

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
                    if job.status != "staged" {
                        Button("继续导入其他账单") { reset() }
                    }
                }
            }

            if let message {
                Section { Text(message).foregroundColor(.green) }
            }
        }
        .navigationTitle("导入账单")
        .fileImporter(isPresented: $showPicker, allowedContentTypes: BillImportFile.contentTypes) { result in
            switch result {
            case .success(let url):
                Task { await upload(url) }
            case .failure(let error):
                errorMessage = error.localizedDescription
            }
        }
        .sheet(isPresented: $showAddAccount) { AccountFormView() }
        .onChange(of: screenshotItem) { _, newItem in
            guard let newItem else { return }
            screenshotItem = nil
            Task { await importScreenshot(newItem) }
        }
        .task { await store.refreshAccounts() }
        .onChange(of: store.ledgerId) { _, _ in reset() }
        .errorAlert($errorMessage)
    }

    private var hasActiveAccount: Bool { store.accounts.contains { !$0.isArchived } }

    private func sourceName(_ source: String) -> String {
        switch source {
        case "wechat": return "微信"
        case "alipay": return "支付宝"
        case "bank": return "银行"
        default: return "账单文件"
        }
    }

    private func reset() {
        job = nil
        items = []
        message = nil
        errorMessage = nil
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
        let ledgerId = store.ledgerId
        message = nil
        do {
            let created = try await APIService.shared.uploadImportFile(fileURL: url, ledgerId: ledgerId)
            guard store.ledgerId == ledgerId else { return }
            job = created
            try await loadDetail(created.id, ledgerId: created.ledgerId)
            message = "已识别账单，请确认明细后导入"
        } catch {
            guard store.ledgerId == ledgerId else { return }
            let nsError = error as NSError
            if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileReadNoPermissionError {
                errorMessage = "无法读取所选文件，请先保存到“文件”App，下载完成后重新选择。"
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// 截图识别：本机 OCR → 合成微信格式文本 → 走同一条暂存导入管道（服务端零改动）
    private func importScreenshot(_ item: PhotosPickerItem) async {
        isRecognizing = true
        defer { isRecognizing = false }
        let ledgerId = store.ledgerId
        message = nil
        do {
            guard let imageData = try await item.loadTransferable(type: Data.self) else {
                throw BillScreenshotOCR.OCRError.noText
            }
            let lines = try await BillScreenshotOCR.recognizeLines(from: imageData)
            guard !lines.isEmpty else { throw BillScreenshotOCR.OCRError.noText }
            let bill = BillScreenshotOCR.extractBill(from: lines)
            guard bill.minorUnits != nil, bill.minorUnits! > 0 else {
                throw BillScreenshotOCR.OCRError.noAmount
            }
            let text = BillScreenshotOCR.synthesizeBillText(bill)
            let created = try await APIService.shared.uploadImportData(
                name: BillScreenshotOCR.suggestedFileName(),
                data: Data(text.utf8),
                ledgerId: ledgerId
            )
            guard store.ledgerId == ledgerId else { return }
            job = created
            try await loadDetail(created.id, ledgerId: created.ledgerId)
            message = "已识别截图，请核对金额与日期后导入"
        } catch {
            guard store.ledgerId == ledgerId else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadDetail(_ id: String, ledgerId: String) async throws {
        let detail = try await APIService.shared.importJob(id: id, ledgerId: ledgerId)
        guard store.ledgerId == ledgerId else { return }
        job = detail.job
        items = detail.items
    }

    private func decide(_ id: String, decision: String) async {
        guard let job else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            try await APIService.shared.decideImportItem(id: id, decision: decision, ledgerId: job.ledgerId)
            guard store.ledgerId == job.ledgerId else { return }
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
            let res = try await APIService.shared.commitImportJob(id: job.id, ledgerId: job.ledgerId)
            guard store.ledgerId == job.ledgerId else { return }
            message = "导入成功 \(res.imported) 条，跳过 \(res.skipped) 条"
            await store.loadAll()
            try await loadDetail(job.id, ledgerId: job.ledgerId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
