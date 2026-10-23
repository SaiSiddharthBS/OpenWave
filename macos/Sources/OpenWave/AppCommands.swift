import AppKit
import SwiftUI

/// Native menus. Space / arrows without ⌘ are left to the page so they keep working in text fields.
struct AppCommands: Commands {
    private func go(_ hash: String) { Bridge.shared.command("navigate", hash); AppDelegate.shared?.showMain() }

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { Updates.check(userInitiated: true) }
        }
        CommandGroup(replacing: .newItem) {
            Button("Import Playlists…") { Bridge.shared.command("importPlaylists"); AppDelegate.shared?.showMain() }
                .keyboardShortcut("i", modifiers: [.command, .shift])
        }
        CommandMenu("Playback") {
            Button("Play / Pause") { Bridge.shared.command("toggle") }
                .keyboardShortcut(.space, modifiers: [.command])
            Button("Next") { Bridge.shared.command("next") }
                .keyboardShortcut(.rightArrow, modifiers: [.command])
            Button("Previous") { Bridge.shared.command("prev") }
                .keyboardShortcut(.leftArrow, modifiers: [.command])
            Divider()
            Button("Like Song") { Bridge.shared.command("like") }
                .keyboardShortcut("l", modifiers: [.command])
            Button("Shuffle") { Bridge.shared.command("shuffle") }
            Button("Repeat") { Bridge.shared.command("repeat") }
            Divider()
            Button("Volume Up") { Bridge.shared.command("volumeUp") }
                .keyboardShortcut(.upArrow, modifiers: [.command])
            Button("Volume Down") { Bridge.shared.command("volumeDown") }
                .keyboardShortcut(.downArrow, modifiers: [.command])
            Divider()
            Menu("Sleep Timer") {
                ForEach([15, 30, 45, 60, 90], id: \.self) { m in
                    Button("\(m) minutes") { Bridge.shared.command("sleep", "\(m)") }
                }
                Button("End of Song") { Bridge.shared.command("sleep", "track") }
                Divider()
                Button("Off") { Bridge.shared.command("sleep", "off") }
            }
            Button("Now Playing") { Bridge.shared.command("nowPlaying"); AppDelegate.shared?.showMain() }
                .keyboardShortcut("p", modifiers: [.command, .shift])
        }
        CommandMenu("Go") {
            Button("Home") { go("#/home") }.keyboardShortcut("1", modifiers: [.command])
            Button("Search") { Bridge.shared.command("search"); AppDelegate.shared?.showMain() }.keyboardShortcut("f", modifiers: [.command])
            Button("Your Library") { go("#/library") }.keyboardShortcut("2", modifiers: [.command])
            Button("Downloads") { go("#/downloads") }.keyboardShortcut("3", modifiers: [.command])
            Button("Insights") { go("#/insights") }.keyboardShortcut("4", modifiers: [.command])
            Button("Liked Songs") { go("#/liked") }.keyboardShortcut("5", modifiers: [.command])
            Divider()
            Button("Library Settings") { go("#/settings") }
            Button("Back") { WebHost.shared.webView.goBack() }.keyboardShortcut("[", modifiers: [.command])
            Button("Forward") { WebHost.shared.webView.goForward() }.keyboardShortcut("]", modifiers: [.command])
            Button("Reload") { WebHost.shared.webView.reload() }.keyboardShortcut("r", modifiers: [.command])
        }
        CommandGroup(after: .windowArrangement) {
            Button("Show OpenWave") { AppDelegate.shared?.showMain() }.keyboardShortcut("0", modifiers: [.command])
        }
        CommandGroup(replacing: .help) {
            Button("OpenWave on GitHub") { NSWorkspace.shared.open(URL(string: "https://github.com/SaiSiddharthBS/OpenWave")!) }
            Button("Report a Problem…") { NSWorkspace.shared.open(URL(string: "https://github.com/SaiSiddharthBS/OpenWave/issues/new/choose")!) }
            Divider()
            Button("Show Server Log") { NSWorkspace.shared.open(ServerManager.logURL) }
        }
    }
}
