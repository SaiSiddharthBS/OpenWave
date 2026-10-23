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
        .frame(width: 500, height: 420)
    }
}

private struct PhoneAccessView: View {
    @ObservedObject private var server = ServerManager.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Listen on your phone").font(.title2.bold())
            Text("Your Mac can serve OpenWave to phones, tablets and other computers on the same Wi-Fi. Same profiles, same library, nothing to install.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("Allow devices on my Wi-Fi to use OpenWave", isOn: Binding(get: { server.lanEnabled }, set: { server.setLAN($0) }))
            if server.lanEnabled, let url = server.lanURL {
                HStack(alignment: .top, spacing: 18) {
                    if let qr = QRCode.image(for: url.absoluteString) {
                        Image(nsImage: qr).interpolation(.none).resizable().frame(width: 150, height: 150)
                            .padding(8).background(.white).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Scan with your phone's camera, or open:").foregroundStyle(.secondary)
                        Text(url.absoluteString).font(.title3.monospaced()).textSelection(.enabled)
                        Text("Then use “Add to Home Screen” to install it like an app. Keep your Mac awake while you listen.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else if server.lanEnabled {
                Text("Connect this Mac to Wi-Fi or Ethernet to get an address.").foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(22)
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
