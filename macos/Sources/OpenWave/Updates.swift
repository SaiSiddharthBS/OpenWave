import AppKit
import CryptoKit

/// Looks for a newer OpenWave release on GitHub and installs it.
///
/// The app downloads the update itself instead of sending you to the browser: macOS only shows its
/// "can't verify the developer" warning for files a browser downloaded, so an update installed this
/// way simply restarts as the new version. If anything goes wrong it falls back to the download page.
enum Updates {
    private static let api = URL(string: "https://api.github.com/repos/SaiSiddharthBS/OpenWave/releases/latest")!
    #if arch(arm64)
    private static let dmgName = "OpenWave-macOS-AppleSilicon.dmg"
    #else
    private static let dmgName = "OpenWave-macOS-Intel.dmg"
    #endif

    static func checkInBackground() {
        let last = UserDefaults.standard.double(forKey: "lastUpdateCheck")
        guard Date().timeIntervalSince1970 - last > 86_400 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { check(userInitiated: false) }
    }

    static func check(userInitiated: Bool) {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "lastUpdateCheck")
        var req = URLRequest(url: api)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, response, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let tag = (json?["tag_name"] as? String)?.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            let page = (json?["html_url"] as? String).flatMap(URL.init(string:))
            let assets = (json?["assets"] as? [[String: Any]]) ?? []
            let url = { (name: String) in
                assets.first { $0["name"] as? String == name }.flatMap { $0["browser_download_url"] as? String }.flatMap(URL.init(string:))
            }
            let dmg = url(dmgName), checksum = url(dmgName + ".sha256")
            DispatchQueue.main.async {
                let current = Bundle.main.shortVersion
                if let tag, let page, isNewer(tag, than: current) {
                    let alert = NSAlert()
                    alert.messageText = "OpenWave \(tag) is available"
                    alert.informativeText = "You have \(current). OpenWave will download the update, install it and restart. Your library stays as it is."
                    alert.addButton(withTitle: "Update Now")
                    alert.addButton(withTitle: "Later")
                    guard alert.runModal() == .alertFirstButtonReturn else { return }
                    if let dmg, let checksum, canReplaceApp { Installer(version: tag, dmg: dmg, checksum: checksum, page: page).start() } else { NSWorkspace.shared.open(dmg ?? page) }
                } else if userInitiated {
                    let alert = NSAlert()
                    let ok = (response as? HTTPURLResponse)?.statusCode == 200
                    alert.messageText = ok || tag != nil ? "You’re up to date" : "Couldn’t check for updates"
                    alert.informativeText = ok || tag != nil ? "OpenWave \(current) is the latest version." : "Make sure you’re online, then try again."
                    alert.runModal()
                }
            }
        }.resume()
    }

    /// Can this app replace itself (an admin user, with OpenWave in a writable folder)?
    private static var canReplaceApp: Bool {
        let app = Bundle.main.bundleURL
        return app.pathExtension == "app" && FileManager.default.isWritableFile(atPath: app.deletingLastPathComponent().path)
            && FileManager.default.isWritableFile(atPath: app.path)
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}

/// Downloads the new DMG (with a progress window), checks its SHA-256, and hands over to a small
/// script that swaps the app once this one has quit, then opens the new version.
private final class Installer: NSObject, URLSessionDownloadDelegate {
    private let version: String, dmg: URL, checksum: URL, page: URL
    private var panel: NSPanel?
    private let bar = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "")
    private var session: URLSession?
    private static var running: Installer? // keeps the download alive

    init(version: String, dmg: URL, checksum: URL, page: URL) {
        self.version = version; self.dmg = dmg; self.checksum = checksum; self.page = page
    }

    func start() {
        guard Self.running == nil else { return }
        Self.running = self
        showProgress()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
        session?.downloadTask(with: dmg).resume()
    }

    private func showProgress() {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 96), styleMask: [.titled], backing: .buffered, defer: false)
        p.title = "Updating OpenWave"
        label.stringValue = "Downloading OpenWave \(version)…"
        label.frame = NSRect(x: 20, y: 54, width: 300, height: 20)
        bar.frame = NSRect(x: 20, y: 26, width: 300, height: 20)
        bar.isIndeterminate = false
        bar.minValue = 0; bar.maxValue = 1
        p.contentView?.addSubview(label)
        p.contentView?.addSubview(bar)
        p.center()
        p.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        panel = p
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesExpectedToWrite > 0 { bar.doubleValue = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file at `location` is deleted when this method returns: move it somewhere of ours.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("openwave-update-\(UUID().uuidString)")
        let file = dir.appendingPathComponent("OpenWave.dmg")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: location, to: file)
        } catch {
            return fail("Couldn’t save the download (\(error.localizedDescription)).")
        }
        label.stringValue = "Checking the download…"
        bar.isIndeterminate = true
        bar.startAnimation(nil)
        URLSession.shared.dataTask(with: checksum) { data, _, _ in
            let expected = data.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: " ").first.map(String.init)?.lowercased()
            let actual = (try? Data(contentsOf: file, options: .mappedIfSafe)).map { SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined() }
            DispatchQueue.main.async {
                guard let expected, expected == actual else { return self.fail("The download didn’t match its checksum.") }
                self.install(file)
            }
        }.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { fail("The download stopped (\(error.localizedDescription)).") }
    }

    private func install(_ dmg: URL) {
        label.stringValue = "Installing… OpenWave will restart."
        let app = Bundle.main.bundleURL.path
        // Runs after this app quits: mount, swap the app (keeping the old one until the copy worked),
        // tidy up and open the new version.
        let script = """
        while kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.3; done
        MNT="$(mktemp -d)"
        if hdiutil attach -nobrowse -noautoopen -quiet -mountpoint "$MNT" "$1"; then
          rm -rf "$2.old"
          if mv "$2" "$2.old"; then
            if ditto "$MNT/OpenWave.app" "$2"; then rm -rf "$2.old"; else rm -rf "$2"; mv "$2.old" "$2"; fi
          fi
          hdiutil detach "$MNT" -quiet || true
        fi
        xattr -dr com.apple.quarantine "$2" 2>/dev/null || true
        rm -rf "$(dirname "$1")"
        open "$2"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, "openwave-update", dmg.path, app]
        do {
            try p.run()
        } catch {
            return fail("Couldn’t start the installer (\(error.localizedDescription)).")
        }
        NSApp.terminate(nil)
    }

    private func fail(_ why: String) {
        panel?.close()
        Self.running = nil
        let alert = NSAlert()
        alert.messageText = "The update didn’t install"
        alert.informativeText = "\(why) You can download OpenWave \(version) from its release page instead."
        alert.addButton(withTitle: "Open Download Page")
        alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(page) }
    }
}
