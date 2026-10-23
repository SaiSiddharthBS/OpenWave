import SwiftUI

/// The menu-bar mini player.
struct MiniPlayerView: View {
    @EnvironmentObject private var bridge: Bridge

    var body: some View {
        VStack(spacing: 14) {
            if let t = bridge.track {
                HStack(spacing: 12) {
                    AsyncImage(url: t.artwork) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                    }
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 3) {
                        Text(t.title).font(.headline).lineLimit(2)
                        Text(t.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(spacing: 4) {
                        ProgressView(value: t.livePosition(at: context.date), total: max(t.duration, 1))
                            .tint(Color(red: 0.48, green: 0.48, blue: 1))
                        HStack {
                            Text(Self.time(t.livePosition(at: context.date)))
                            Spacer()
                            Text(Self.time(t.duration))
                        }
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 26) {
                    control("backward.fill", "prev")
                    Button { bridge.command("toggle") } label: {
                        Image(systemName: t.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 38))
                    }
                    .buttonStyle(.plain)
                    control("forward.fill", "next")
                    control(t.liked ? "heart.fill" : "heart", "like")
                        .foregroundStyle(t.liked ? Color.pink : Color.primary)
                }
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "waveform").font(.largeTitle).foregroundStyle(.secondary)
                    Text("Nothing playing").foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }
            Divider()
            HStack {
                Button("Open OpenWave") { AppDelegate.shared?.showMain() }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .buttonStyle(.borderless)
        }
        .padding(16)
        .frame(width: 300)
    }

    private func control(_ symbol: String, _ command: String) -> some View {
        Button { bridge.command(command) } label: { Image(systemName: symbol).font(.title3) }
            .buttonStyle(.plain)
    }

    private static func time(_ s: Double) -> String {
        guard s.isFinite, s > 0 else { return "0:00" }
        let total = Int(s)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
