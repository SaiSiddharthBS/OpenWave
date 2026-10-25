import AppKit
import MediaPlayer
import UserNotifications
import WebKit

struct NowPlaying: Equatable {
    var videoId: String
    var title: String
    var artist: String
    var album: String
    var artwork: URL?
    var duration: Double
    var position: Double
    var playing: Bool
    var liked: Bool
    var updatedAt: Date

    /// Position extrapolated from the last update, for smooth progress bars.
    func livePosition(at date: Date = Date()) -> Double {
        min(duration, position + (playing ? date.timeIntervalSince(updatedAt) : 0))
    }
}

/// Connects the page's player to macOS: media keys, Control Center / Now Playing, notifications,
/// the menu-bar mini player and the Dock menu.
final class Bridge: ObservableObject {
    static let shared = Bridge()

    @Published private(set) var track: NowPlaying?
    weak var webView: WKWebView?
    private var notificationsEnabled = true
    private var artwork: (url: URL, image: NSImage)?
    private var lastNotified: String?
    private var pageReady = false
    private var pending: [(String, String?)] = []

    /// Called when the page starts (re)loading; commands wait until it says it's ready.
    func pageWillLoad() { pageReady = false }

    // MARK: page → native

    func handle(_ body: Any) {
        guard let msg = body as? [String: Any], let type = msg["type"] as? String else { return }
        switch type {
        case "nowPlaying":
            track = (msg["track"] as? [String: Any]).flatMap(Self.parse)
            updateNowPlaying()
        case "trackChanged":
            if let t = (msg["track"] as? [String: Any]).flatMap(Self.parse) { notify(t) }
        case "ready":
            pageReady = true
            let queued = pending
            pending.removeAll()
            queued.forEach { command($0.0, $0.1) }
            if let s = msg["settings"] as? [String: Any], let n = s["notifications"] as? Bool { notificationsEnabled = n }
        case "attention":
            AppDelegate.shared?.showMain() // another device is asking to connect
        case "settings":
            if let s = msg["settings"] as? [String: Any], let n = s["notifications"] as? Bool { notificationsEnabled = n }
        default:
            break
        }
    }

    private static func parse(_ d: [String: Any]) -> NowPlaying? {
        guard let id = d["videoId"] as? String, let title = d["title"] as? String else { return nil }
        return NowPlaying(
            videoId: id, title: title, artist: d["artist"] as? String ?? "", album: d["album"] as? String ?? "",
            artwork: (d["artwork"] as? String).flatMap(URL.init(string:)),
            duration: d["duration"] as? Double ?? 0, position: d["position"] as? Double ?? 0,
            playing: d["playing"] as? Bool ?? false, liked: d["liked"] as? Bool ?? false, updatedAt: Date())
    }

    // MARK: native → page

    func command(_ name: String, _ arg: String? = nil) {
        guard pageReady else { pending.append((name, arg)); return }
        let argJS = arg.map { ", " + Self.jsString($0) } ?? ""
        webView?.evaluateJavaScript("window.openwaveNative && window.openwaveNative.command(\(Self.jsString(name))\(argJS))")
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let json = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(json.dropFirst().dropLast())
    }

    // MARK: media keys & Now Playing

    func setUpSystemControls() {
        let center = MPRemoteCommandCenter.shared()
        let bind: (MPRemoteCommand, String) -> Void = { cmd, name in
            cmd.isEnabled = true
            cmd.addTarget { [weak self] _ in self?.command(name); return .success }
        }
        bind(center.togglePlayPauseCommand, "toggle")
        bind(center.playCommand, "play")
        bind(center.pauseCommand, "pause")
        bind(center.nextTrackCommand, "next")
        bind(center.previousTrackCommand, "prev")
        bind(center.likeCommand, "like")
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.command("seek", String(e.positionTime))
            return .success
        }
    }

    private func updateNowPlaying() {
        let info = MPNowPlayingInfoCenter.default()
        guard let t = track else {
            info.nowPlayingInfo = nil
            info.playbackState = .stopped
            return
        }
        var dict: [String: Any] = [
            MPMediaItemPropertyTitle: t.title,
            MPMediaItemPropertyArtist: t.artist,
            MPMediaItemPropertyAlbumTitle: t.album,
            MPMediaItemPropertyPlaybackDuration: t.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: t.position,
            MPNowPlayingInfoPropertyPlaybackRate: t.playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let art = artwork, art.url == t.artwork {
            dict[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: art.image.size) { _ in art.image }
        } else if let url = t.artwork {
            loadArtwork(url)
        }
        info.nowPlayingInfo = dict
        info.playbackState = t.playing ? .playing : .paused
    }

    private func loadArtwork(_ url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data, let image = NSImage(data: data) else { return }
            DispatchQueue.main.async {
                self?.artwork = (url, image)
                self?.updateNowPlaying()
            }
        }.resume()
    }

    // MARK: notifications

    private func notify(_ t: NowPlaying) {
        guard notificationsEnabled, !NSApp.isActive, lastNotified != t.videoId else { return }
        lastNotified = t.videoId
        // Ask the first time a notification is actually useful, not at launch.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, _ in
            if granted { DispatchQueue.main.async { self.deliver(t) } }
        }
    }

    private func deliver(_ t: NowPlaying) {
        let content = UNMutableNotificationContent()
        content.title = t.title
        content.body = t.artist
        let send = {
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "now-playing", content: content, trigger: nil))
        }
        guard let url = t.artwork else { return send() }
        URLSession.shared.downloadTask(with: url) { file, _, _ in
            if let file {
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent("openwave-art-\(t.videoId).jpg")
                try? FileManager.default.removeItem(at: dest)
                if (try? FileManager.default.moveItem(at: file, to: dest)) != nil,
                   let attachment = try? UNNotificationAttachment(identifier: "art", url: dest) {
                    content.attachments = [attachment]
                }
            }
            send()
        }.resume()
    }
}
