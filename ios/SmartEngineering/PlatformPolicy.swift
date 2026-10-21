import Foundation

enum PlatformPolicy {
    static let home = URL(string: "https://211.139.12.141:21901/mobile/mobile.html")!
    static let maximumDownloadBytes: Int64 = 256 * 1024 * 1024

    static func isPlatform(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host == home.host &&
        url.port == home.port && url.user == nil && url.password == nil
    }

    static func allowsNavigation(_ url: URL) -> Bool {
        if isPlatform(url) { return true }
        if url.scheme == "blob", let nested = URL(string: String(url.absoluteString.dropFirst(5))) {
            return isPlatform(nested)
        }
        return url.absoluteString == "about:blank"
    }

    static func fileName(_ value: String) -> String {
        let forbidden = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\:"))
        let clean = String(value.unicodeScalars.map { forbidden.contains($0) ? "_" : String($0) }.joined().prefix(150))
        return clean.isEmpty || clean == "." || clean == ".." ? "施工资料" : clean
    }
}
