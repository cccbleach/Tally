import Foundation
import UniformTypeIdentifiers

struct BillImportFile {
    let name: String
    let data: Data

    static let supportedExtensions = ["txt", "csv", "xlsx", "pdf"]
    static var contentTypes: [UTType] {
        supportedExtensions.compactMap { UTType(filenameExtension: $0) }
    }

    static func read(_ url: URL) throws -> BillImportFile {
        try withSecurityScopedAccess(to: url) {
            var coordinationError: NSError?
            var result: Result<BillImportFile, Error>?
            // 文件可能来自 iCloud/第三方文件提供商；在授权期间协调读取，完成后才释放权限。
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { readableURL in
                result = Result {
                    let size = try readableURL.resourceValues(forKeys: [.fileSizeKey]).fileSize
                    try validate(name: url.lastPathComponent, size: size ?? 1)
                    let limit = maxBytes(for: url.lastPathComponent)
                    let handle = try FileHandle(forReadingFrom: readableURL)
                    defer { try? handle.close() }
                    var bytes = Data()
                    while bytes.count <= limit {
                        let chunk = try handle.read(upToCount: min(64 * 1024, limit + 1 - bytes.count)) ?? Data()
                        if chunk.isEmpty { break }
                        bytes.append(chunk)
                    }
                    try validate(name: url.lastPathComponent, size: bytes.count)
                    return BillImportFile(name: url.lastPathComponent, data: bytes)
                }
            }
            if let coordinationError { throw coordinationError }
            guard let result else { throw APIError.invalidResponse }
            return try result.get()
        }
    }

    static func validate(name: String, size: Int) throws {
        let ext = (name as NSString).pathExtension.lowercased()
        if ext == "zip" {
            throw APIError.server(code: "FILE_NEEDS_UNZIP", message: "请先在“文件”App 中解压账单，再选择里面的文件")
        }
        guard supportedExtensions.contains(ext) else {
            throw APIError.server(code: "FILE_EXT_NOT_ALLOWED", message: "请选择 TXT、CSV、XLSX 或 PDF 账单文件")
        }
        guard size > 0 else { throw APIError.server(code: "FILE_EMPTY", message: "文件为空，请重新导出账单") }
        let maxSize = maxBytes(for: name)
        guard size <= maxSize else {
            throw APIError.server(code: "FILE_TOO_LARGE", message: ext == "xlsx" ? "Excel 账单不能超过 5MB，请缩短导出时间范围" : "账单文件不能超过 20MB")
        }
    }

    private static func maxBytes(for name: String) -> Int {
        ((name as NSString).pathExtension.lowercased() == "xlsx" ? 5 : 20) * 1024 * 1024
    }

    // 开始访问返回 false 时也允许读取 App 自己的文件，但不能对未取得的权限调用 stop。
    static func withSecurityScopedAccess<T>(
        to url: URL,
        start: (URL) -> Bool = { $0.startAccessingSecurityScopedResource() },
        stop: (URL) -> Void = { $0.stopAccessingSecurityScopedResource() },
        read: () throws -> T
    ) rethrows -> T {
        let accessing = start(url)
        defer { if accessing { stop(url) } }
        return try read()
    }

    func multipart(boundary: String) -> (data: Data, contentType: String) {
        // 文件名只能作为一个字段，不能借引号或换行注入 multipart 头。
        let safeName = name.replacingOccurrences(of: "[\r\n\"\\\\]", with: "_", options: .regularExpression)
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return (body, "multipart/form-data; boundary=\(boundary)")
    }
}
