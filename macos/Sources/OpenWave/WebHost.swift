import AppKit
import WebKit

/// Owns the single WKWebView that renders OpenWave, plus everything a browser would normally handle:
/// downloads, file pickers, external links and the native bridge.
final class WebHost: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    static let shared = WebHost()

    let webView: WKWebView
    let containerView: NSView
    private var loadedURL: URL?

    private override init() {
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "OpenWaveMac/\(Bundle.main.shortVersion)"
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .default()
        let controller = WKUserContentController()
        // Let the page reserve space for the traffic lights and the drag strip.
        controller.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('native-app','native-mac');",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = controller

        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        containerView = NSView()
        super.init()

        controller.add(WeakMessageHandler(self), name: "openwave")
        webView.navigationDelegate = self
        webView.uiDelegate = self

        webView.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(webView)
        let strip = DragStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        containerView.addSubview(strip)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            webView.topAnchor.constraint(equalTo: containerView.topAnchor),
            webView.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
            strip.leadingAnchor.constraint(equalTo: containerView.leadingAnchor, constant: 80),
            strip.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
            strip.topAnchor.constraint(equalTo: containerView.topAnchor),
            strip.heightAnchor.constraint(equalToConstant: 26),
        ])
    }

    // MARK: loading

    func load(_ url: URL) {
        loadedURL = url
        Bridge.shared.pageWillLoad()
        webView.load(URLRequest(url: url))
    }

    func showSplash(message: String, retry: Bool = false) {
        let logo = Bundle.main.url(forResource: "logo-mark", withExtension: "png")
            .flatMap { try? Data(contentsOf: $0) }
            .map { "data:image/png;base64,\($0.base64EncodedString())" } ?? ""
        let html = """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;background:#0a0b14;color:#f3f3f6;font:15px -apple-system,system-ui,sans-serif}
        body{display:grid;place-items:center;-webkit-user-select:none}
        .c{text-align:center;display:flex;flex-direction:column;align-items:center;gap:18px;max-width:440px;padding:24px}
        img{height:72px;filter:drop-shadow(0 8px 30px rgba(79,107,255,.55));animation:b 1.6s ease-in-out infinite}
        @keyframes b{50%{transform:scale(1.06)}}
        p{color:#a4a4b2;margin:0;line-height:1.5}
        a{color:#fff;background:linear-gradient(135deg,#2fc8ff,#4f6bff 45%,#c45cff);padding:10px 22px;border-radius:999px;text-decoration:none;font-weight:650}
        </style></head><body><div class="c"><img src="\(logo)" alt=""><p>\(message.htmlEscaped)</p>
        \(retry ? "<a href=\"openwave-retry:\">Try again</a>" : "")</div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: navigation

    private func isAppURL(_ url: URL) -> Bool {
        guard let host = url.host else { return url.scheme == "about" || url.scheme == "data" || url.scheme == "blob" }
        return host == "127.0.0.1" || host == "localhost" || url.scheme == "blob"
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if url.scheme == "openwave-retry" {
            AppDelegate.shared?.startServer()
            return decisionHandler(.cancel)
        }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        if !isAppURL(url) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = loadedURL { webView.load(URLRequest(url: url)) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryIfServerRestarting(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryIfServerRestarting(error) }

    private func retryIfServerRestarting(_ error: Error) {
        guard let url = loadedURL, (error as NSError).code != NSURLErrorCancelled else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.webView.load(URLRequest(url: url)) }
    }

    // MARK: UI delegate

    /// target=_blank links and window.open go to the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.begin { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // MARK: downloads (library backups, shared insight cards)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.begin { completionHandler($0 == .OK ? panel.url : nil) }
    }

    // MARK: bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        Bridge.shared.handle(message.body)
    }
}

/// Avoids the retain cycle WKUserContentController creates with its handlers.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { target?.userContentController(c, didReceive: m) }
}

/// Invisible strip along the top edge so the window can be dragged (and double-click zoomed) over web content.
private final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
    }
}

extension String {
    var htmlEscaped: String {
        replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}

extension Bundle {
    var shortVersion: String { infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev" }
}
