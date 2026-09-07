import XCTest
@testable import Tally

final class BillImportTests: XCTestCase {
    func testSecurityScopedAccessSpansReadAndIsReleasedAfterSuccessOrFailure() throws {
        let url = URL(fileURLWithPath: "/external/statement.csv")
        var events: [String] = []
        let result = BillImportFile.withSecurityScopedAccess(to: url,
            start: { _ in events.append("start"); return true },
            stop: { _ in events.append("stop") }) {
                events.append("read")
                return 42
            }
        XCTAssertEqual(result, 42)
        XCTAssertEqual(events, ["start", "read", "stop"])
        events = []
        XCTAssertThrowsError(try BillImportFile.withSecurityScopedAccess(to: url,
            start: { _ in events.append("start"); return true },
            stop: { _ in events.append("stop") }) {
                events.append("read")
                throw APIError.invalidResponse
            })
        XCTAssertEqual(events, ["start", "read", "stop"])
    }

    func testAppOwnedFileDoesNotReleaseUnacquiredScope() {
        var stopped = false
        let bytes = BillImportFile.withSecurityScopedAccess(to: URL(fileURLWithPath: "/tmp/owned.csv"),
            start: { _ in false }, stop: { _ in stopped = true }) { Data("test".utf8) }
        XCTAssertEqual(bytes.count, 4)
        XCTAssertFalse(stopped)
    }

    func testCoordinatedFileReadKeepsOriginalBytesAndFilename() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".CSV")
        let original = Data("交易时间,金额\n2024-01-01,25.00\n".utf8)
        try original.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try BillImportFile.read(url)
        XCTAssertEqual(file.name, url.lastPathComponent)
        XCTAssertEqual(file.data, original)
    }

    func testFileLimitsAndUnsupportedArchivesHaveClearErrors() throws {
        for ext in BillImportFile.supportedExtensions { XCTAssertNoThrow(try BillImportFile.validate(name: "账单.\(ext)", size: 1)) }
        XCTAssertThrowsError(try BillImportFile.validate(name: "账单.zip", size: 100)) { error in
            guard case APIError.server(let code, _) = error else { return XCTFail("Missing structured error") }
            XCTAssertEqual(code, "FILE_NEEDS_UNZIP")
        }
        XCTAssertThrowsError(try BillImportFile.validate(name: "账单.xlsx", size: 5 * 1024 * 1024 + 1))
        XCTAssertThrowsError(try BillImportFile.validate(name: "账单.csv", size: 20 * 1024 * 1024 + 1))
        XCTAssertThrowsError(try BillImportFile.validate(name: "账单.pdf", size: 0))
    }

    func testMultipartHasOneFileNoManualSourceAndSafeFilename() throws {
        let file = BillImportFile(name: "账单\"\r\nInjected.csv", data: Data("original bytes".utf8))
        let multipart = file.multipart(boundary: "test-boundary")
        let body = try XCTUnwrap(String(data: multipart.data, encoding: .utf8))
        XCTAssertEqual(multipart.contentType, "multipart/form-data; boundary=test-boundary")
        XCTAssertTrue(body.contains("filename=\"账单___Injected.csv\""))
        XCTAssertFalse(body.contains("name=\"source\""))
        XCTAssertTrue(body.contains("\r\n\r\noriginal bytes\r\n--test-boundary--\r\n"))
    }

    func testUploadRefreshesExpiredTokenAndRetriesIdenticalMultipartAndLedger() async throws {
        let tokens = ImportTestTokens()
        let responder = UploadResponder()
        let session = makeSession(responder)
        defer { session.invalidateAndCancel() }
        let client = APIClient(session: session, tokenStore: tokens, baseURLOverride: "https://import-tests.invalid")
        let body = BillImportFile(name: "账单.csv", data: Data("statement".utf8)).multipart(boundary: "unchanged-boundary")
        let response: UploadOK = try await client.upload("/api/v1/imports/jobs/upload", bodyData: body.data, contentType: body.contentType,
            query: [URLQueryItem(name: "ledgerId", value: "chosen-ledger")])
        XCTAssertTrue(response.ok)
        XCTAssertEqual(responder.uploads.count, 2)
        XCTAssertEqual(responder.refreshCount, 1)
        XCTAssertEqual(responder.uploads.map(\.body), [body.data, body.data])
        XCTAssertEqual(responder.uploads.map(\.contentType), [body.contentType, body.contentType])
        XCTAssertEqual(responder.uploads.map(\.authorization), ["Bearer expired-token", "Bearer fresh-token"])
        XCTAssertEqual(responder.uploads.map(\.query), ["ledgerId=chosen-ledger", "ledgerId=chosen-ledger"])
        XCTAssertEqual(tokens.loadToken(), "fresh-token")
    }

    func testUploadBusinessErrorAfterRefreshDoesNotLogUserOut() async throws {
        let tokens = ImportTestTokens()
        let responder = UploadResponder(finalStatus: 400)
        let session = makeSession(responder)
        defer { session.invalidateAndCancel() }
        let client = APIClient(session: session, tokenStore: tokens, baseURLOverride: "https://import-tests.invalid")
        do {
            let _: UploadOK = try await client.upload("/api/v1/imports/jobs/upload", bodyData: Data("body".utf8), contentType: "multipart/form-data; boundary=boundary")
            XCTFail("Expected account error")
        } catch APIError.server(let code, _) {
            XCTAssertEqual(code, "ACCOUNT_REQUIRED")
        }
        XCTAssertEqual(tokens.loadToken(), "fresh-token")
        XCTAssertFalse(tokens.deleted)
    }

    private func makeSession(_ responder: UploadResponder) -> URLSession {
        ImportURLProtocol.responder = responder
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ImportURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private struct UploadOK: Decodable { let ok: Bool }

private final class ImportTestTokens: APITokenStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var access = "expired-token"
    private var refresh = "refresh-token"
    private(set) var deleted = false
    func loadToken() -> String? { lock.withLock { deleted ? nil : access } }
    func loadRefreshToken() -> String? { lock.withLock { deleted ? nil : refresh } }
    func saveTokens(token: String, refreshToken: String) { lock.withLock { access = token; refresh = refreshToken } }
    func deleteTokens() { lock.withLock { deleted = true } }
}

private final class UploadResponder: @unchecked Sendable {
    struct Upload { let body: Data; let contentType: String; let authorization: String; let query: String }
    private(set) var uploads: [Upload] = []
    private(set) var refreshCount = 0
    let finalStatus: Int
    init(finalStatus: Int = 200) { self.finalStatus = finalStatus }
    func response(for request: URLRequest) -> (Int, Data) {
        if request.url?.path == "/api/v1/auth/refresh" {
            refreshCount += 1
            return (200, Data(#"{"token":"fresh-token","refreshToken":"fresh-refresh"}"#.utf8))
        }
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        uploads.append(Upload(body: body, contentType: request.value(forHTTPHeaderField: "Content-Type") ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization") ?? "", query: request.url?.query ?? ""))
        if uploads.count == 1 { return (401, Data(#"{"error":{"code":"UNAUTHORIZED","message":"expired"}}"#.utf8)) }
        return finalStatus == 200 ? (200, Data(#"{"ok":true}"#.utf8))
            : (400, Data(#"{"error":{"code":"ACCOUNT_REQUIRED","message":"请先创建账户"}}"#.utf8))
    }
}

private final class ImportURLProtocol: URLProtocol, @unchecked Sendable {
    static var responder: UploadResponder?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "import-tests.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let responder = Self.responder, let url = request.url else { return }
        let (status, data) = responder.response(for: request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
