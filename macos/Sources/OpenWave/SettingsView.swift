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
                        Label("Anywhere: at home, at work, on mobile data", systemImage: "globe").font(.headline)
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
