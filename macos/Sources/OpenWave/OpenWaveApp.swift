import AppKit
import SwiftUI

@main
struct OpenWaveApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @ObservedObject private var bridge = Bridge.shared

    var body: some Scene {
        MenuBarExtra {
            MiniPlayerView()
                .environmentObject(bridge)
        } label: {
            if let icon = MenuBarIcon.image {
                Image(nsImage: icon).renderingMode(.original)
            } else {
                Image(systemName: "waveform")
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
        }
        .commands { AppCommands() }
    }
}

/// The main window is plain AppKit so closing it only hides it: music keeps playing
/// (like Music.app) and the web view – with your queue and state – survives.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    static private(set) weak var shared: AppDelegate?
    private var window: NSWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppDelegate.shared = self
        NSApp.appearance = NSAppearance(named: .darkAqua)
        window = MainWindow.make(content: WebHost.shared.containerView)
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        Bridge.shared.webView = WebHost.shared.webView
        Bridge.shared.setUpSystemControls()
        startServer()
        Updates.checkInBackground()
    }

    func startServer() {
        WebHost.shared.showSplash(message: "Starting OpenWave…")
        ServerManager.shared.start { result in
            switch result {
            case .success(let url):
                WebHost.shared.load(url)
            case .failure(let error):
                WebHost.shared.showSplash(message: "OpenWave couldn’t start: \(error.localizedDescription)", retry: true)
            }
        }
    }

    /// openwave://play/<videoId>, openwave://album/<id>, openwave://search?q=…
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "openwave" {
            let path = ([url.host].compactMap { $0 } + url.pathComponents.filter { $0 != "/" }).joined(separator: "/")
            let query = url.query.map { "?" + $0 } ?? ""
            Bridge.shared.command("navigate", "#/\(path)\(query)")
        }
        showMain()
    }

    func showMain() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMain() }
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil) // keep playing in the background
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        ServerManager.shared.stop()
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        if let t = Bridge.shared.track {
            let now = NSMenuItem(title: "\(t.title) — \(t.artist)", action: nil, keyEquivalent: "")
            now.isEnabled = false
            menu.addItem(now)
            menu.addItem(.separator())
        }
        let playing = Bridge.shared.track?.playing == true
        menu.addItem(withTitle: playing ? "Pause" : "Play", action: #selector(dockToggle), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Next", action: #selector(dockNext), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Previous", action: #selector(dockPrev), keyEquivalent: "").target = self
        menu.addItem(withTitle: Bridge.shared.track?.liked == true ? "Unlike" : "Like", action: #selector(dockLike), keyEquivalent: "").target = self
        return menu
    }

    @objc private func dockToggle() { Bridge.shared.command("toggle") }
    @objc private func dockNext() { Bridge.shared.command("next") }
    @objc private func dockPrev() { Bridge.shared.command("prev") }
    @objc private func dockLike() { Bridge.shared.command("like") }
}

/// The silver OpenWave wave, shown in its own colours (not as a template, which macOS would
/// flatten to a one-colour silhouette). Its faint shadow keeps it visible on light menu bars.
enum MenuBarIcon {
    static let image: NSImage? = {
        guard let image = NSImage(named: "MenuBarIcon") else { return nil }
        image.isTemplate = false
        image.size = NSSize(width: image.size.width * 20 / max(image.size.height, 1), height: 20)
        return image
    }()
}

enum MainWindow {
    static let background = NSColor(red: 10 / 255, green: 11 / 255, blue: 20 / 255, alpha: 1)

    static func make(content: NSView) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "OpenWave"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.backgroundColor = background
        window.minSize = NSSize(width: 760, height: 560)
        window.contentView = content
        window.setFrameAutosaveName("OpenWaveMain")
        if !window.setFrameUsingName("OpenWaveMain") { window.center() }
        window.tabbingMode = .disallowed
        return window
    }
}
