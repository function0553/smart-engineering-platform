import UIKit
import WebKit
import Security

/// Native iOS container for the same mobile workflow used by the 252 platform.
/// No JavaScript-to-native command bridge, embedded account or relaxed TLS policy.
final class EngineeringViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var web: WKWebView!
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let status = UILabel()
    private let retry = UIButton(type: .system)
    private let errorPanel = UIStackView()
    private var progressObservation: NSKeyValueObservation?
    private var historyObservation: NSKeyValueObservation?
    private var downloadObservation: NSKeyValueObservation?
    private var activeDownload: WKDownload?
    private var downloadFile: URL?
    private var expectedDownloadBytes: Int64 = -1
    private var expectedDownloadHash: String?
    private let appUpdater = IOSAppUpdater()
    private var activeObservation: NSObjectProtocol?
    private let downloadsRoot = FileManager.default.temporaryDirectory.appendingPathComponent("EngineeringDownloads", isDirectory: true)
    private lazy var back = UIBarButtonItem(title: "返回", style: .plain, target: self, action: #selector(goBack))

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "智慧工程"
        view.backgroundColor = .systemBackground
        navigationController?.navigationBar.tintColor = UIColor(red: 37/255, green: 99/255, blue: 235/255, alpha: 1)
        navigationItem.leftBarButtonItem = back
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "更多", style: .plain, target: self, action: #selector(showMenu))
        // Download temporary files are never an account-independent in-app archive.
        try? FileManager.default.removeItem(at: downloadsRoot)
        try? FileManager.default.createDirectory(at: downloadsRoot, withIntermediateDirectories: true)
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        web.accessibilityIdentifier = "engineeringWebView"
        view.addSubview(web)
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.isAccessibilityElement = true
        progress.accessibilityLabel = "页面加载进度"
        view.addSubview(progress)
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .body)
        status.adjustsFontForContentSizeCategory = true
        status.textAlignment = .center
        retry.setTitle("重新连接", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.titleLabel?.adjustsFontForContentSizeCategory = true
        retry.addTarget(self, action: #selector(reconnect), for: .touchUpInside)
        retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        errorPanel.axis = .vertical
        errorPanel.spacing = 16
        errorPanel.addArrangedSubview(status)
        errorPanel.addArrangedSubview(retry)
        errorPanel.translatesAutoresizingMaskIntoConstraints = false
        errorPanel.isHidden = true
        view.addSubview(errorPanel)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            progress.topAnchor.constraint(equalTo: web.topAnchor),
            progress.leadingAnchor.constraint(equalTo: web.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: web.trailingAnchor),
            errorPanel.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            errorPanel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            errorPanel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24)
        ])
        progressObservation = web.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progress.progress = Float(web.estimatedProgress)
            self?.progress.isHidden = !web.isLoading
        }
        historyObservation = web.observe(\.canGoBack, options: [.initial, .new]) { [weak self] web, _ in
            self?.back.isEnabled = web.canGoBack
        }
        // Enforce the fixed production origin for subresources as well as navigation.
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https://211\\.139\\.12\\.141:21901/"},"action":{"type":"ignore-previous-rules"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "engineering252-v1", encodedContentRuleList: rules) { [weak self] list, _ in
            guard let self else { return }
            guard let list else { self.showFailure("无法加载访问规则，请关闭后重新打开APP。"); return }
            self.web.configuration.userContentController.add(list)
            self.web.load(URLRequest(url: PlatformPolicy.home))
        }
        activeObservation = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.checkAppUpdate(manual: false) }
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        checkAppUpdate(manual: false)
    }
    deinit { if let activeObservation { NotificationCenter.default.removeObserver(activeObservation) } }

    @objc private func goBack() { if web.canGoBack { web.goBack() } }
    @objc private func reconnect() {
        errorPanel.isHidden = true
        web.isHidden = false
        if web.url == nil { web.load(URLRequest(url: PlatformPolicy.home)) } else { web.reload() }
    }
    @objc private func showMenu() {
        let sheet = UIAlertController(title: "智慧工程 iOS 0.1.0 测试版", message: "连接252。业务页面随服务器更新。", preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "检查APP更新", style: .default) { [weak self] _ in self?.checkAppUpdate(manual: true) })
        sheet.addAction(UIAlertAction(title: "重新加载页面…", style: .default) { [weak self] _ in self?.confirmReload() })
        if activeDownload != nil {
            sheet.addAction(UIAlertAction(title: "取消当前下载", style: .destructive) { [weak self] _ in
                guard let self, let download = self.activeDownload else { return }
                download.cancel { [weak self] _ in
                    guard self?.activeDownload === download else { return }
                    self?.clearDownload(removeFile: true)
                }
            })
        }
        sheet.addAction(UIAlertAction(title: "取消", style: .cancel))
        sheet.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        present(sheet, animated: true)
    }
    private func confirmReload() {
        let alert = UIAlertController(title: "重新加载页面？", message: "请先保存当前填写内容，再重新加载。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "继续填写", style: .cancel))
        alert.addAction(UIAlertAction(title: "重新加载", style: .destructive) { [weak self] _ in self?.reconnect() })
        present(alert, animated: true)
    }
    private func checkAppUpdate(manual: Bool) {
        guard let bundleID = Bundle.main.bundleIdentifier,
              let installed = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else { return }
        if manual { navigationItem.prompt = "正在检查APP版本" }
        let started = appUpdater.check(force: manual, bundleID: bundleID, installed: installed, osVersion: UIDevice.current.systemVersion) { [weak self] result in
            guard let self else { return }
            if manual, self.activeDownload == nil { self.navigationItem.prompt = nil }
            switch result {
            case .success(.available(let release)):
                guard self.presentedViewController == nil else { return }
                let alert = UIAlertController(title: "发现新版本 \(release.version)", message: release.notes + "\n请先保存填写内容。安装由App Store处理。", preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "稍后", style: .cancel))
                alert.addAction(UIAlertAction(title: "前往App Store", style: .default) { _ in UIApplication.shared.open(release.url) })
                self.present(alert, animated: true)
            case .success(.unpublished):
                if manual { self.notify("当前为尚未上架的测试版，暂无App Store更新。签名测试版本通过TestFlight更新；业务页面随252发布更新。") }
            case .success(.current):
                if manual { self.notify("当前已是可查询到的最新版本。系统App Store自动更新开关由你管理。") }
            case .success(.requiresNewerIOS):
                if manual { self.notify("商店新版本需要更高版本的iOS，请先检查系统更新。") }
            case .failure:
                if manual { self.notify("暂时无法检查APP更新，请稍后重试。当前填写和已保存资料不受影响。") }
            }
        }
        if manual && !started {
            if activeDownload == nil { navigationItem.prompt = nil }
            notify("已有版本检查正在进行，请稍后再试。")
        }
    }
    private func notify(_ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "智慧工程", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "知道了", style: .default))
        present(alert, animated: true)
    }
    private func showFailure(_ message: String) {
        web.isHidden = true
        errorPanel.isHidden = false
        status.text = message
        progress.isHidden = true
        UIAccessibility.post(notification: .screenChanged, argument: status)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, PlatformPolicy.allowsNavigation(url) else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame != false { notify("此链接不属于当前工程平台，已停止打开。") }
            return
        }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if navigationAction.targetFrame == nil {
            decisionHandler(.cancel)
            webView.load(navigationAction.request)
            return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, PlatformPolicy.allowsNavigation(url) else { decisionHandler(.cancel); return }
        if let response = navigationResponse.response as? HTTPURLResponse, !(200..<300).contains(response.statusCode), navigationResponse.isForMainFrame {
            decisionHandler(.cancel)
            notify("请求未完成，请重新登录或刷新资料后重试。")
            return
        }
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        progress.isHidden = true
        #if DEBUG && targetEnvironment(simulator)
        SimulatorFixture.install(in: webView)
        #endif
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        #if DEBUG
        NSLog("252 provisional load failed, code %ld", (error as NSError).code)
        #endif
        if (error as NSError).code != NSURLErrorCancelled { showFailure("暂时无法连接252，请检查网络后重试。填写草稿仍保留在本机。") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { notify("页面加载中断，请保存填写内容后重试。") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showFailure("页面已暂停。重新连接后可恢复已保存的本机草稿。")
    }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        #if DEBUG
        NSLog("252 trust challenge %@:%ld %@", space.host, space.port, space.authenticationMethod)
        #endif
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.host == PlatformPolicy.home.host, space.port == PlatformPolicy.home.port,
              let trust = space.serverTrust,
              let path = Bundle.main.url(forResource: "Server252CA", withExtension: "cer"),
              let data = try? Data(contentsOf: path), let anchor = SecCertificateCreateWithData(nil, data as CFData) else {
            completionHandler(.performDefaultHandling, nil); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let accepted = ServerTrust.evaluate(trust, host: space.host, port: space.port, anchor: anchor)
            DispatchQueue.main.async {
                if accepted { completionHandler(.useCredential, URLCredential(trust: trust)) }
                else { completionHandler(.cancelAuthenticationChallenge, nil) }
            }
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { adopt(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { adopt(download) }
    private func adopt(_ download: WKDownload) {
        guard activeDownload == nil else { download.cancel(nil); notify("已有文件正在下载，请稍后再试。"); return }
        activeDownload = download
        download.delegate = self
        navigationItem.prompt = "正在下载文件，可在“更多”中取消"
        downloadObservation = download.progress.observe(\.completedUnitCount, options: [.new]) { [weak self] value, _ in
            guard value.completedUnitCount <= PlatformPolicy.maximumDownloadBytes else {
                DispatchQueue.main.async {
                    guard self?.activeDownload === download else { return }
                    download.cancel { [weak self] _ in
                        guard self?.activeDownload === download else { return }
                        self?.clearDownload(removeFile: true)
                        self?.notify("文件超过256 MiB，请使用电脑端下载。")
                    }
                }
                return
            }
        }
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard activeDownload === download,
              response.expectedContentLength <= PlatformPolicy.maximumDownloadBytes,
              let url = response.url, PlatformPolicy.allowsNavigation(url) else {
            completionHandler(nil); clearDownload(removeFile: true); notify("文件下载依据无效或文件过大，请刷新资料重试。"); return
        }
        expectedDownloadBytes = response.expectedContentLength
        expectedDownloadHash = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Content-SHA256")
        if response.url?.path.hasPrefix("/api/engineering-site-media/") == true,
           expectedDownloadHash?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) == nil {
            completionHandler(nil); clearDownload(removeFile: true); notify("服务器未提供完整性依据，请刷新资料重试。"); return
        }
        do {
            let directory = downloadsRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
            let file = directory.appendingPathComponent(PlatformPolicy.fileName(suggestedFilename))
            downloadFile = file
            completionHandler(file)
        } catch { completionHandler(nil); clearDownload(removeFile: true); notify("无法准备文件保存位置，请检查可用空间。") }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map(PlatformPolicy.isPlatform) == true ? .allow : .cancel)
    }
    func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        webView(web, didReceive: challenge, completionHandler: completionHandler)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard activeDownload === download else { return }
        guard let file = downloadFile, FileManager.default.fileExists(atPath: file.path) else { clearDownload(removeFile: true); notify("文件未完整保存，请重试。"); return }
        let expectedBytes = expectedDownloadBytes, expectedHash = expectedDownloadHash
        navigationItem.prompt = "正在核对文件完整性"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let valid = (try? DownloadIntegrity.verify(file, expectedBytes: expectedBytes, sha256: expectedHash)) != nil
            DispatchQueue.main.async {
                guard let self, self.activeDownload === download else { return }
                if valid { self.shareDownload(file) }
                else { self.clearDownload(removeFile: true); self.notify("文件完整性核对失败，没有保存到系统文件。请重试。"); }
            }
        }
    }
    private func shareDownload(_ file: URL) {
        #if DEBUG && targetEnvironment(simulator)
        SimulatorFixture.preserveDownloadedFixture(file)
        #endif
        clearDownload(removeFile: false)
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        share.popoverPresentationController?.barButtonItem = navigationItem.rightBarButtonItem
        if presentedViewController != nil {
            // A menu may be open while a download finishes. Dismiss it before showing save/share.
            dismiss(animated: true) { [weak self] in self?.present(share, animated: true) }
        } else { present(share, animated: true) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard activeDownload === download else { return }
        clearDownload(removeFile: true)
        if (error as NSError).code != NSURLErrorCancelled { notify("下载中断，没有生成完整文件。请刷新资料后重新下载。") }
    }
    private func clearDownload(removeFile: Bool) {
        downloadObservation = nil
        activeDownload = nil
        navigationItem.prompt = nil
        if removeFile, let file = downloadFile { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        downloadFile = nil
        expectedDownloadBytes = -1
        expectedDownloadHash = nil
    }
}
