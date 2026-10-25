import AppKit

/// OpenWave on your iPhone (or any of your devices) anywhere, through Tailscale: this Mac gets a
/// private HTTPS address that only devices signed in to your own Tailscale account can open.
/// Tailscale forwards it to the engine, which keeps listening on 127.0.0.1 only. HTTPS also lets the
/// iPhone's home-screen app keep downloads for offline listening.
enum Tailscale {
    /// Port 443 is often used by other things people share with Tailscale; OpenWave keeps to its own.
    static let httpsPort = 8443
    static let downloadURL = URL(string: "https://tailscale.com/download")!

    enum State: Equatable {
        case missing, signedOut
        case ready(host: String)
        case sharing(URL)
    }

    private static var cli: String? {
        ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @discardableResult
    private static func run(_ args: [String], timeout: TimeInterval = 30) -> (code: Int32, out: String) {
        guard let cli else { return (-1, "") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: cli)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if p.isRunning { p.terminate() }
        let out = String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? ""
        return (p.isRunning ? -1 : p.terminationStatus, out)
    }

    private static func json(_ args: [String]) -> [String: Any]? {
        let r = run(args, timeout: 10)
        return r.code == 0 ? (try? JSONSerialization.jsonObject(with: Data(r.out.utf8))) as? [String: Any] : nil
    }

    /// Call off the main thread: it asks the Tailscale app.
    static func state(enginePort: Int) -> State {
        guard cli != nil else { return .missing }
        guard let status = json(["status", "--json"]), status["BackendState"] as? String == "Running",
              let me = status["Self"] as? [String: Any], let dns = me["DNSName"] as? String, !dns.isEmpty else { return .signedOut }
        let host = dns.hasSuffix(".") ? String(dns.dropLast()) : dns
        let web = json(["serve", "status", "--json"])?["Web"] as? [String: Any]
        let handlers = (web?["\(host):\(httpsPort)"] as? [String: Any])?["Handlers"] as? [String: Any]
        let proxy = (handlers?["/"] as? [String: Any])?["Proxy"] as? String
        if proxy == "http://127.0.0.1:\(enginePort)", let url = URL(string: "https://\(host):\(httpsPort)/") {
            return .sharing(url)
        }
        return .ready(host: host)
    }

    /// Start sharing; returns a message for the person when Tailscale needs something first.
    static func share(enginePort: Int) -> String? {
        let r = run(["serve", "--bg", "--https=\(httpsPort)", "http://127.0.0.1:\(enginePort)"])
        if r.code == 0 { return nil }
        // A tailnet without HTTPS certificates: Tailscale prints a link to switch them on.
        if let link = r.out.range(of: #"https://login\.tailscale\.com/\S+"#, options: .regularExpression).map({ String(r.out[$0]) }),
           let url = URL(string: link) {
            NSWorkspace.shared.open(url)
            return "Tailscale needs HTTPS switched on for your account. Turn it on in the page that just opened, then try again."
        }
        let detail = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Tailscale couldn’t share OpenWave\(detail.isEmpty ? "." : ": \(detail.prefix(200))")"
    }

    static func stop() {
        run(["serve", "--https=\(httpsPort)", "off"])
    }
}
