import Foundation
import Security

var checked = 0
func check(_ value: Bool, _ name: String) {
    precondition(value, name)
    checked += 1
}
check(PlatformPolicy.isPlatform(PlatformPolicy.home), "production origin")
check(!PlatformPolicy.isPlatform(URL(string: "http://211.139.12.141:21901/")!), "reject cleartext")
check(!PlatformPolicy.isPlatform(URL(string: "https://211.139.12.141:443/")!), "reject different port")
check(!PlatformPolicy.isPlatform(URL(string: "https://211.139.12.141.evil.test:21901/")!), "reject suffix hostname")
check(!PlatformPolicy.isPlatform(URL(string: "https://name:pass@211.139.12.141:21901/")!), "reject userinfo")
check(!PlatformPolicy.allowsNavigation(URL(string: "file:///etc/passwd")!), "reject local file")
check(!PlatformPolicy.allowsNavigation(URL(string: "javascript:alert(1)")!), "reject script scheme")
check(!PlatformPolicy.allowsNavigation(URL(string: "data:text/html,example")!), "reject inline document")
check(PlatformPolicy.allowsNavigation(URL(string: "blob:https://211.139.12.141:21901/example")!), "allow own blob")
check(!PlatformPolicy.allowsNavigation(URL(string: "blob:https://other.test/example")!), "reject foreign blob")
check(PlatformPolicy.fileName("../资料\\\n.docx") == ".._资料__.docx", "sanitize separators and controls")
check(PlatformPolicy.fileName("..") == "施工资料", "reject directory names")
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try Data("abc".utf8).write(to: temporary)
defer { try? FileManager.default.removeItem(at: temporary) }
try DownloadIntegrity.verify(temporary, expectedBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
checked += 1
func rejects(_ run: () throws -> Void) -> Bool { do { try run(); return false } catch { return true } }
check(rejects { try DownloadIntegrity.verify(temporary, expectedBytes: 4, sha256: nil) }, "reject truncated size")
check(rejects { try DownloadIntegrity.verify(temporary, expectedBytes: 3, sha256: String(repeating: "0", count: 64)) }, "reject corrupt content")
try Data().write(to: temporary)
check(rejects { try DownloadIntegrity.verify(temporary, expectedBytes: 0, sha256: nil) }, "reject empty file")
let large = try FileHandle(forWritingTo: temporary)
try large.truncate(atOffset: UInt64(PlatformPolicy.maximumDownloadBytes + 1))
try large.close()
check(rejects { try DownloadIntegrity.verify(temporary, expectedBytes: -1, sha256: nil) }, "reject oversized file with unknown response length")
let base = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let ca = SecCertificateCreateWithData(nil, try Data(contentsOf: base.appendingPathComponent("ios/SmartEngineering/Server252CA.cer")) as CFData)!
let leaf = SecCertificateCreateWithData(nil, try Data(contentsOf: base.appendingPathComponent("outputs/ios-20261019/server-leaf.cer")) as CFData)!
func trust(_ date: Date? = nil) -> SecTrust {
    var value: SecTrust?
    SecTrustCreateWithCertificates([leaf,ca] as CFArray, SecPolicyCreateSSL(true, "211.139.12.141" as CFString), &value)
    if let date { SecTrustSetVerifyDate(value!, date as CFDate) }
    return value!
}
check(ServerTrust.evaluate(trust(), host: "211.139.12.141", port: 21901, anchor: ca), "real server chain and IP match")
check(!ServerTrust.evaluate(trust(), host: "other.test", port: 21901, anchor: ca), "reject foreign server")
check(!ServerTrust.evaluate(trust(), host: "211.139.12.141", port: 443, anchor: ca), "reject foreign TLS port")
check(!ServerTrust.evaluate(trust(Date(timeIntervalSince1970: 0)), host: "211.139.12.141", port: 21901, anchor: ca), "reject not yet valid certificate")
check(!ServerTrust.evaluate(trust(Date(timeIntervalSince1970: 2208988800)), host: "211.139.12.141", port: 21901, anchor: ca), "reject expired certificate")
func store(_ overrides: [String: Any] = [:], installed: String = "0.1.0") throws -> StoreUpdateResult {
    var item: [String: Any] = ["bundleId":"cn.smartengineering.dailyreport", "version":"0.2.0", "trackId":123, "trackViewUrl":"https://apps.apple.com/cn/app/example/id123", "minimumOsVersion":"17.0"]
    item.merge(overrides) { _, new in new }
    return try StoreUpdatePolicy.parse(JSONSerialization.data(withJSONObject:["resultCount":1,"results":[item]]), bundleID: "cn.smartengineering.dailyreport", installed: installed, osVersion: "17.0")
}
if case .unpublished = try StoreUpdatePolicy.parse(Data("{\"resultCount\":0,\"results\":[]}".utf8), bundleID:"cn.smartengineering.dailyreport", installed:"0.1.0", osVersion:"17.0") { checked += 1 } else { fatalError("unlisted test build") }
if case .available(let release) = try store() { check(release.version == "0.2.0", "newer store version") } else { fatalError("newer version not detected") }
if case .current = try store(["version":"0.1"], installed:"0.1.0") { checked += 1 } else { fatalError("equal semantic versions") }
if case .current = try store(["version":"0.0.9"]) { checked += 1 } else { fatalError("no downgrade") }
check(rejects { _ = try store(["bundleId":"other.app"]) }, "reject unrelated app update")
check(rejects { _ = try store(["trackViewUrl":"https://apps.apple.com.evil.test/cn/app/id123"]) }, "reject foreign install host")
check(rejects { _ = try store(["trackViewUrl":"http://apps.apple.com/cn/app/id123"]) }, "reject cleartext install URL")
check(rejects { _ = try store(["version":"bad-version"]) }, "reject malformed update version")
if case .requiresNewerIOS = try store(["minimumOsVersion":"99.0"]) { checked += 1 } else { fatalError("incompatible OS update") }
print("iOS policy and integrity checks passed: \(checked)")
