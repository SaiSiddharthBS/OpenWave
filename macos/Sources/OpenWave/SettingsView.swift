import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

/// OpenWave ▸ Settings… (⌘,): things only the Mac app can do.
struct SettingsView: View {
    var body: some View {
        TabView {
            PhoneAccessView().tabItem { Label("Phone", systemImage: "iphone") }
            GeneralView().tabItem { Label("General", systemImage: "gearshape") }
        }
        .frame(width: 560, height: 560)
    }
}

private struct PhoneAccessView: View {
    @ObservedObject private var server = ServerManager.shared
    @State private var tailscale: Tailscale.State?
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Listen on your iPhone").font(.title2.bold())
                Text("Your iPhone plays from OpenWave on this Mac, with the same profiles, playlists and likes. Add it to your Home Screen and it works like an app.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Anywhere, no setup (recommended)", systemImage: "iphone.radiowaves.left.and.right").font(.headline)
                        PhonesView(port: server.port)
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Anywhere, with Tailscale", systemImage: "globe").font(.headline)
                        anywhere
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("At home, on the same Wi-Fi", systemImage: "wifi").font(.headline)
                        Toggle("Allow devices on my Wi-Fi to use OpenWave", isOn: Binding(get: { server.lanEnabled }, set: { server.setLAN($0) }))
                        if server.lanEnabled, let url = server.lanURL {
                            scan(url, then: "Then in Safari: Share → Add to Home Screen. Downloads for offline listening need the Anywhere option above.")
                        } else if server.lanEnabled {
                            Text("Connect this Mac to Wi-Fi or Ethernet to get an address.").foregroundStyle(.secondary)
                        }
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                }
                Text("Keep this Mac on and awake while you listen from your phone.").font(.callout).foregroundStyle(.secondary)
            }
            .padding(22)
        }
        .task { await refresh() }
    }

    @ViewBuilder private var anywhere: some View {
        switch tailscale {
        case nil:
            ProgressView().controlSize(.small)
        case .missing:
            Text("Uses Tailscale, which is free: your iPhone gets a private, secure address for this Mac that only your own devices can open.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Get Tailscale") { NSWorkspace.shared.open(Tailscale.downloadURL) }
                Button("I’ve Installed It") { Task { await refresh() } }
            }
        case .signedOut:
            Text("Open Tailscale on this Mac and sign in, then come back here.").foregroundStyle(.secondary)
            HStack {
                Button("Open Tailscale") { NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Tailscale.app")) }
                Button("Check Again") { Task { await refresh() } }
            }
        case .ready:
            Text("Give your iPhone a private, secure address for OpenWave on this Mac. Only devices signed in to your Tailscale account can open it, and downloads work offline.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Button(busy ? "Turning On…" : "Turn On") { toggle(on: true) }.disabled(busy).keyboardShortcut(.defaultAction)
        case .sharing(let url):
            scan(url, then: "On your iPhone: install Tailscale from the App Store and sign in with the same account, scan this code, then in Safari tap Share → Add to Home Screen.")
            Button(busy ? "Turning Off…" : "Turn Off") { toggle(on: false) }.disabled(busy)
        }
        if let problem { Text(problem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
    }

    private func scan(_ url: URL, then: String) -> some View {
        HStack(alignment: .top, spacing: 16) {
            if let qr = QRCode.image(for: url.absoluteString) {
                Image(nsImage: qr).interpolation(.none).resizable().frame(width: 130, height: 130)
                    .padding(7).background(.white).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Scan with your iPhone’s camera, or open:").foregroundStyle(.secondary)
                Text(url.absoluteString).font(.body.monospaced()).textSelection(.enabled)
                Text(then).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func refresh() async {
        let port = server.port
        tailscale = await Task.detached { Tailscale.state(enginePort: port) }.value
    }

    private func toggle(on: Bool) {
        busy = true
        problem = nil
        let port = server.port
        Task {
            let error: String? = await Task.detached { on ? Tailscale.share(enginePort: port) : { Tailscale.stop(); return nil }() }.value
            problem = error
            await refresh()
            busy = false
        }
    }
}

/// OpenWave Connect: pair phones by QR code (the engine's /api/connect; see openwave/connect.py).
private struct PhonesView: View {
    let port: Int
    @State private var status: [String: Any]?
    @State private var pairing: (id: String, link: URL)?
    @State private var problem: String?

    private var devices: [[String: Any]] { status?["devices"] as? [[String: Any]] ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Scan a code with your iPhone, or any phone. It plays from this Mac at home, at work or on mobile data. No accounts, and nothing else to install.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let status, status["available"] as? Bool == false {
                Text(status["reason"] as? String ?? "Not available.").foregroundStyle(.secondary)
            } else if let pairing {
                HStack(alignment: .top, spacing: 16) {
                    if let qr = QRCode.image(for: pairing.link.absoluteString) {
                        Image(nsImage: qr).interpolation(.none).resizable().frame(width: 150, height: 150)
                            .padding(7).background(.white).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("1. Open the Camera on the phone and point it at this code.")
                        Text("2. Tap the link that appears.")
                        Text("3. On an iPhone, add OpenWave to the Home Screen when it asks.")
                        Text(connectedLine ?? "Waiting for the phone…").foregroundStyle(connectedLine == nil ? Color.secondary : Color.green)
                        Text("The code works for 15 minutes. Anyone who scans it can use OpenWave on this Mac, so only show it to people you trust.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Button("Copy Link") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(pairing.link.absoluteString, forType: .string)
                            }
                            Button("Done") { self.pairing = nil; Task { await refresh() } }.keyboardShortcut(.defaultAction)
                        }
                    }.fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Button("Add a Phone…") { Task { await pair() } }
            }
            ForEach(Array(devices.enumerated()), id: \.offset) { _, d in
                HStack {
                    Image(systemName: "iphone")
                    VStack(alignment: .leading) {
                        Text(d["label"] as? String ?? "Phone")
                        Text(seen(d)).font(.caption).foregroundStyle(.secondary)
                        if let kept = keeps(d) {
                            Text("Keeps \(kept)’s profile to itself").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Remove") { Task { await remove(d["id"] as? String ?? "", keeping: keeps(d)) } }
                }
            }
            if let problem { Text(problem).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
        .task(id: port) {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: pairing == nil ? 10_000_000_000 : 2_000_000_000)
            }
        }
    }

    /// "iPhone is connected", once a phone has used the code on screen.
    private var connectedLine: String? {
        guard let pairing, let tickets = status?["tickets"] as? [[String: Any]],
              let ticket = tickets.first(where: { $0["id"] as? String == pairing.id }),
              let ids = ticket["devices"] as? [String], !ids.isEmpty else { return nil }
        let names = devices.filter { ids.contains($0["id"] as? String ?? "") }.compactMap { $0["label"] as? String }
        return names.isEmpty ? nil : "✓ \(names.joined(separator: ", ")) \(names.count == 1 ? "is" : "are") connected."
    }

    /// Whose profile this phone keeps (Settings → Profile → Only on this phone, on the phone).
    private func keeps(_ d: [String: Any]) -> String? {
        let names = d["profiles"] as? [String] ?? []
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    private func seen(_ d: [String: Any]) -> String {
        if d["online"] as? Bool == true { return "Connected now" }
        guard let t = d["seen"] as? Double else { return "Paired" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return "Last used " + f.localizedString(for: Date(timeIntervalSince1970: t), relativeTo: Date())
    }

    private func call(_ path: String, method: String = "GET") async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/connect\(path)")!)
        req.httpMethod = method
        req.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: req)
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, http.statusCode < 400 else {
            throw NSError(domain: "OpenWave", code: 1, userInfo: [NSLocalizedDescriptionKey: body["error"] as? String ?? body["detail"] as? String ?? "OpenWave didn’t answer."])
        }
        return body
    }

    private func refresh() async {
        if let s = try? await call("") { status = s }
    }

    private func pair() async {
        problem = nil
        do {
            let p = try await call("/pair", method: "POST")
            if let id = p["id"] as? String, let s = p["link"] as? String, let url = URL(string: s) { pairing = (id, url) }
            await refresh()
        } catch { problem = error.localizedDescription }
    }

    private func remove(_ id: String, keeping kept: String?) async {
        let alert = NSAlert()
        alert.messageText = "Remove this phone?"
        alert.informativeText = "It won’t be able to use OpenWave on this Mac any more. To use it again, add it again."
            + (kept.map { " \($0)’s profile is kept on this phone; once it’s removed, the profile can be opened on this Mac and other phones again." } ?? "")
        alert.addButton(withTitle: "Remove")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do { _ = try await call("/devices/\(id)/remove", method: "POST") } catch { problem = error.localizedDescription }
        await refresh()
    }
}

private struct GeneralView: View {
    @ObservedObject private var server = ServerManager.shared
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Toggle("Open OpenWave when I log in", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { on in
                    do {
                        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                        loginError = nil
                    } catch {
                        loginError = error.localizedDescription
                        launchAtLogin = SMAppService.mainApp.status == .enabled
                    }
                }
            if let loginError { Text(loginError).font(.caption).foregroundStyle(.red) }
            LabeledContent("Engine") {
                switch server.status {
                case .running: Text("Running on port \(server.port)")
                case .starting: Text("Starting…")
                case .failed(let why): Text(why).foregroundStyle(.red)
                }
            }
            if let ytdlp = server.health["ytDlp"] as? String {
                LabeledContent("YouTube support", value: "yt-dlp \(ytdlp)")
            }
            LabeledContent("Version", value: Bundle.main.shortVersion)
            HStack {
                Button("Restart Engine") { server.restart() }
                Button("Show Data Folder") { NSWorkspace.shared.open(ServerManager.supportDir) }
                Button("Check for Updates") { Updates.check(userInitiated: true) }
            }
            Text("Your profiles and library are stored in the data folder. YouTube support updates itself automatically in the background.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .formStyle(.grouped)
    }
}

enum QRCode {
    static func image(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)) else { return nil }
        let rep = NSCIImageRep(ciImage: output)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
