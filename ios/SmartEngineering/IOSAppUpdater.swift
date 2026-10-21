import Foundation

struct StoreRelease {
    let version: String
    let url: URL
    let notes: String
}
enum StoreUpdateResult {
    case unpublished, current, requiresNewerIOS, available(StoreRelease)
}
enum StoreUpdatePolicy {
    enum Invalid: Error { case response }
    static func components(_ value: String) throws -> [Int] {
        guard value.range(of: "^[0-9]+(\\.[0-9]+){0,3}$", options: .regularExpression) != nil else { throw Invalid.response }
        var parts = try value.split(separator: ".").map { part -> Int in
            guard let number = Int(part), number < 1_000_000 else { throw Invalid.response }; return number
        }
        while parts.count < 4 { parts.append(0) }
        return parts
    }
    static func parse(_ data: Data, bundleID: String, installed: String, osVersion: String) throws -> StoreUpdateResult {
        guard data.count <= 2 * 1024 * 1024,
              let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let count = response["resultCount"] as? Int,
              let results = response["results"] as? [[String: Any]], count == results.count else { throw Invalid.response }
        if count == 0 { return .unpublished }
        guard count == 1, let item = results.first, item["bundleId"] as? String == bundleID,
              let version = item["version"] as? String,
              let id = item["trackId"] as? Int, id > 0,
              let address = item["trackViewUrl"] as? String, let url = URL(string: address),
              url.scheme == "https", url.host == "apps.apple.com", url.port == nil || url.port == 443,
              url.user == nil, url.password == nil, url.fragment == nil,
              url.path.hasSuffix("/id\(id)") else { throw Invalid.response }
        let latest = try components(version), current = try components(installed)
        if !current.lexicographicallyPrecedes(latest) { return .current }
        if let minimum = item["minimumOsVersion"] as? String,
           try components(osVersion).lexicographicallyPrecedes(components(minimum)) { return .requiresNewerIOS }
        return .available(StoreRelease(version: version, url: url, notes: String((item["releaseNotes"] as? String ?? "请更新后继续使用，原账号和已保存资料保留。").prefix(1600))))
    }
}

/// App Store owns package installation. This client discovers newer public releases;
/// TestFlight updates are delivered by Apple's TestFlight app, never by arbitrary IPA URLs.
final class IOSAppUpdater: NSObject, URLSessionTaskDelegate {
    private var task: URLSessionDataTask?
    private var lastAttempt: Date?
    private var session: URLSession?
    @discardableResult
    func check(force: Bool, bundleID: String, installed: String, osVersion: String, completion: @escaping (Result<StoreUpdateResult, Error>) -> Void) -> Bool {
        guard task == nil, force || (lastAttempt.map({ Date().timeIntervalSince($0) >= 6 * 3600 }) ?? true) else { return false }
        lastAttempt = Date()
        var address = URLComponents(string: "https://itunes.apple.com/lookup")!
        address.queryItems = [URLQueryItem(name: "bundleId", value: bundleID), URLQueryItem(name: "country", value: "cn"), URLQueryItem(name: "entity", value: "software")]
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 25
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: address.url!) { [weak self] data, response, error in
            let result: Result<StoreUpdateResult, Error>
            do {
                if let error { throw error }
                guard let data, (response as? HTTPURLResponse)?.statusCode == 200 else { throw StoreUpdatePolicy.Invalid.response }
                result = .success(try StoreUpdatePolicy.parse(data, bundleID: bundleID, installed: installed, osVersion: osVersion))
            } catch { result = .failure(error) }
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async {
                self?.task = nil
                self?.session = nil
                completion(result)
            }
        }
        self.task = task
        task.resume()
        return true
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, url.scheme == "https", url.host == "itunes.apple.com",
              url.port == nil || url.port == 443, url.user == nil, url.password == nil,
              url.path == "/lookup" else { completionHandler(nil); return }
        completionHandler(request)
    }
}
