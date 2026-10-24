import AppKit

/// Looks for a newer OpenWave release on GitHub.
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
            // The DMG for this Mac downloads straight away; the release page is the fallback.
            let dmg = (json?["assets"] as? [[String: Any]])?
                .first { $0["name"] as? String == dmgName }
                .flatMap { $0["browser_download_url"] as? String }
                .flatMap(URL.init(string:))
            DispatchQueue.main.async {
                let current = Bundle.main.shortVersion
                if let tag, let page, isNewer(tag, than: current) {
                    let alert = NSAlert()
                    alert.messageText = "OpenWave \(tag) is available"
                    alert.informativeText = "You have \(current). Open the download and drag OpenWave into Applications. Your library stays as it is."
                    alert.addButton(withTitle: "Download")
                    alert.addButton(withTitle: "Later")
                    if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(dmg ?? page) }
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
