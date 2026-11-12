import AVFoundation
import WebKit

/// The Mac app plays music with macOS's own audio engine, not the web view's: two decks the page
/// drives like audio elements (js/native-deck.js), each with its own speed, filters, volume and
/// echo, so Smart mix (js/mix.js) can blend songs beat for beat here too. WebKit can't do that: it
/// gives Web Audio silence for Opus, its clock is off by up to half a second from what's heard just
/// after a song starts, and its speed changes are heard as a blip.
///
/// Each song is fetched whole and decoded once, into a file of plain samples that the deck plays
/// from and seeks in instantly. The same decoding gives Smart mix its copy of the song to listen
/// to, so what it analyses is exactly what's played (WebKit's own decoder starts YouTube's AAC up to
/// 150 ms away from macOS's).
///
/// Page → native: messages to the "audio" handler, {op, deck, …}. Native → page:
/// window.__openwaveAudio({deck, …}) with each deck's state, and its decoded samples on request.
final class NativeAudio: NSObject, WKScriptMessageHandler {
    static let shared = NativeAudio()
    weak var webView: WKWebView?

    private let engine = AVAudioEngine()
    private let bus = AVAudioMixerNode()        // every deck and echo meets here, before the output
    private var decks: [Deck] = []
    private var started = false
    private var ticker: Timer?
    private let session = URLSession(configuration: .ephemeral)
    private let work = DispatchQueue(label: "openwave.audio.decode", qos: .userInitiated)
    let rate: Double = 44100
    private lazy var format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
    /// Tests: OPENWAVE_AUDIO_MUTE=1 keeps it silent; OPENWAVE_AUDIO_RECORD=path records what leaves
    /// the mixer; OPENWAVE_AUDIO_OFFLINE=1 runs the engine at real-time pace into that file instead
    /// of the speakers (for a machine whose sound can't be opened).
    private let muted = ProcessInfo.processInfo.environment["OPENWAVE_AUDIO_MUTE"] == "1"
    private let offline = ProcessInfo.processInfo.environment["OPENWAVE_AUDIO_OFFLINE"] == "1"
    private var recording: AVAudioFile?
    private var renderer: Thread?

    private override init() {
        super.init()
        engine.attach(bus)
        engine.connect(bus, to: engine.mainMixerNode, format: format)
        if muted { engine.mainMixerNode.outputVolume = 0 }
        for i in 0..<2 { decks.append(Deck(index: i, audio: self)) }
        NotificationCenter.default.addObserver(self, selector: #selector(configurationChanged), name: .AVAudioEngineConfigurationChange, object: engine)
        if let path = ProcessInfo.processInfo.environment["OPENWAVE_AUDIO_RECORD"] {
            recording = try? AVAudioFile(forWriting: URL(fileURLWithPath: path), settings: format.settings)
            if !offline { bus.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in try? self?.recording?.write(from: buffer) } }
        }
        if offline { try? engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096) }
    }

    fileprivate func attach(_ nodes: [AVAudioNode]) { nodes.forEach(engine.attach) }
    fileprivate func connect(_ a: AVAudioNode, _ b: AVAudioNode) { engine.connect(a, to: b, format: format) }
    fileprivate func connect(_ a: AVAudioNode, to points: [AVAudioConnectionPoint]) { engine.connect(a, to: points, fromBus: 0, format: format) }
    fileprivate var mixBus: AVAudioMixerNode { bus }

    /// The engine's clock, in seconds: what the page schedules volumes and filters against.
    var now: Double {
        guard let t = engine.outputNode.lastRenderTime, t.isSampleTimeValid else { return 0 }
        return Double(t.sampleTime) / t.sampleRate
    }

    fileprivate func ensureRunning() {
        guard !engine.isRunning else { return }
        engine.prepare()
        do { try engine.start(); started = true } catch { NSLog("OpenWave audio: engine didn't start: \(error)") }
        if offline && renderer == nil {
            // Render what real time has asked for, a few milliseconds at a time.
            let t = Thread { [weak self] in
                guard let self else { return }
                let buf = AVAudioPCMBuffer(pcmFormat: self.engine.manualRenderingFormat, frameCapacity: 4096)!
                let begin = CACurrentMediaTime()
                var done: AVAudioFramePosition = 0
                while true {
                    let due = AVAudioFramePosition((CACurrentMediaTime() - begin) * self.rate)
                    while done < due {
                        let n = AVAudioFrameCount(min(1024, due - done))
                        guard (try? self.engine.renderOffline(n, to: buf)) == .success else { break }
                        try? self.recording?.write(from: buf)
                        done += AVAudioFramePosition(buf.frameLength)
                    }
                    Thread.sleep(forTimeInterval: 0.003)
                }
            }
            t.qualityOfService = .userInteractive
            t.start()
            renderer = t
        }
        if ticker == nil {
            // 100 times a second: scheduled volumes and filters, and the page told where each deck is.
            let t = Timer(timeInterval: 0.01, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(t, forMode: .common)
            ticker = t
        }
    }

    /// Headphones in or out, a new output device: the engine stops itself. Start it again and carry on.
    @objc private func configurationChanged() {
        DispatchQueue.main.async { [self] in
            let playing = decks.filter { $0.playing }.map { ($0, $0.position) }
            decks.forEach { $0.halt() }
            ensureRunning()
            for (d, at) in playing { d.start(from: at) }
        }
    }

    private var reported = 0.0
    private func tick() {
        let t = now
        decks.forEach { $0.apply(at: t) }
        // The page hears where each deck is about 20 times a second while one plays.
        let since = CACurrentMediaTime() - reported
        if decks.contains(where: { $0.playing }) ? since > 0.05 : since > 1 { report() }
    }

    /// Every deck's state, in one message (so the two positions compare exactly).
    func report(_ event: (Int, String, String?)? = nil) {
        reported = CACurrentMediaTime()
        let states = decks.map { d -> [String: Any] in
            ["deck": d.index, "time": d.position, "playing": d.playing, "ended": d.ended, "duration": d.duration,
             "ready": d.file != nil, "loading": d.loading, "token": d.token]
        }
        var msg: [String: Any] = ["engine": now, "decks": states]
        if let (deck, type, message) = event { msg["event"] = ["deck": deck, "type": type, "message": message ?? ""] }
        send("window.__openwaveAudio && window.__openwaveAudio(\(json(msg)))")
    }

    fileprivate func send(_ js: String) {
        guard let web = webView else { return }
        if Thread.isMainThread { web.evaluateJavaScript(js) } else { DispatchQueue.main.async { web.evaluateJavaScript(js) } }
    }

    private func json(_ v: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: v)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    // MARK: page → native

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let op = m["op"] as? String else { return }
        let i = (m["deck"] as? Int) ?? 0
        guard decks.indices.contains(i) else { return }
        let d = decks[i]
        switch op {
        case "load":
            ensureRunning()
            d.load(url: (m["url"] as? String).flatMap(URL.init(string:)), data: (m["data"] as? String).flatMap { Data(base64Encoded: $0) },
                   token: m["token"] as? Int ?? 0)
        case "unload": d.unload(token: m["token"] as? Int ?? 0)
        case "play": ensureRunning(); d.play()
        case "pause": d.pause()
        case "seek": d.seek(to: m["time"] as? Double ?? 0)
        case "rate": d.setRate(m["rate"] as? Double ?? 1, keepPitch: m["keepPitch"] as? Bool ?? true)
        case "volume": d.volume = m["volume"] as? Double ?? 1; d.muted = m["muted"] as? Bool ?? false
        case "param":
            if let name = m["param"] as? String, let events = m["events"] as? [[String: Any]] { d.param(name)?.events = Automation.parse(events) }
        case "samples": d.sendSamples(id: m["id"] as? Int ?? 0)
        default: break
        }
        report()
    }

    // MARK: decoding

    /// The song as a file of plain samples at 44.1 kHz (for the deck), and as mono at 11025 Hz,
    /// 16-bit (for Smart mix to listen to).
    fileprivate func decode(_ source: URL, into dest: URL) throws -> (seconds: Double, samples: Data) {
        let asset = AVURLAsset(url: source)
        let sem = DispatchSemaphore(value: 0)
        var track: AVAssetTrack?
        Task { track = try? await asset.loadTracks(withMediaType: .audio).first; sem.signal() }
        sem.wait()
        guard let track else { throw NSError(domain: "OpenWave", code: 1, userInfo: [NSLocalizedDescriptionKey: "No audio in this file"]) }
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
                                       AVLinearPCMIsNonInterleaved: true, AVNumberOfChannelsKey: 2, AVSampleRateKey: rate]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? NSError(domain: "OpenWave", code: 2) }
        let file = try AVAudioFile(forWriting: dest, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        var mono = Data(), frames = 0
        var acc: Float = 0, accN = 0
        while let sb = output.copyNextSampleBuffer() {
            let n = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
            guard n > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: n) else { continue }
            buf.frameLength = n
            CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(n), into: buf.mutableAudioBufferList)
            try file.write(from: buf)
            // Every four samples averaged into one: 11025 Hz, plenty for beats and chords.
            let l = buf.floatChannelData![0], r = buf.floatChannelData![1]
            for k in 0..<Int(n) {
                acc += (l[k] + r[k]) * 0.5; accN += 1
                if accN == 4 {
                    var s = Int16(max(-32767, min(32767, (acc / 4) * 32767)))
                    withUnsafeBytes(of: &s) { mono.append(contentsOf: $0) }
                    acc = 0; accN = 0
                }
            }
            frames += Int(n)
        }
        if reader.status == .failed { throw reader.error ?? NSError(domain: "OpenWave", code: 3) }
        return (Double(frames) / rate, mono)
    }

    fileprivate func fetch(_ url: URL, to dest: URL, done: @escaping (Error?) -> Void) {
        session.downloadTask(with: url) { tmp, response, error in
            if let error { return done(error) }
            if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
                return done(NSError(domain: "OpenWave", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "The song couldn't be fetched (HTTP \(http.statusCode))"]))
            }
            guard let tmp else { return done(NSError(domain: "OpenWave", code: 4)) }
            do { try? FileManager.default.removeItem(at: dest); try FileManager.default.moveItem(at: tmp, to: dest); done(nil) } catch { done(error) }
        }.resume()
    }

    fileprivate func onWork(_ block: @escaping () -> Void) { work.async(execute: block) }
}

// MARK: - a deck

private final class Deck {
    let index: Int
    unowned let audio: NativeAudio
    let player = AVAudioPlayerNode()
    let varispeed = AVAudioUnitVarispeed()
    let stretch = AVAudioUnitTimePitch()
    let eq = AVAudioUnitEQ(numberOfBands: 4)
    let dry = AVAudioMixerNode()
    let wet = AVAudioMixerNode()
    let delay = AVAudioUnitDelay()

    var file: AVAudioFile?
    var fileURL: URL?
    var samples: Data?
    var duration = 0.0
    var token = 0                 // the page's number for what's loaded, so late answers are dropped
    var loading = false
    var playing = false
    var ended = false
    private var from: AVAudioFramePosition = 0   // the frame the scheduled stretch starts at
    private var held = 0.0                       // the position while stopped
    private var segment = 0                      // which scheduled stretch is current
    var volume = 1.0, muted = false
    var rate = 1.0, keepPitch = true

    // What Smart mix moves, on the engine's clock (see js/native-deck.js).
    let gain = Automation(1), send = Automation(0), bass0 = Automation(0), bass1 = Automation(0)
    let highpass = Automation(10), lowpass = Automation(20000), echoTime = Automation(0.5)

    init(index: Int, audio: NativeAudio) {
        self.index = index
        self.audio = audio
        audio.attach([player, varispeed, stretch, eq, dry, wet, delay])
        // player → speed → stretch → EQ → the mix, and a send through the echo.
        audio.connect(player, varispeed)
        audio.connect(varispeed, stretch)
        audio.connect(stretch, eq)
        audio.connect(eq, to: [AVAudioConnectionPoint(node: dry, bus: 0), AVAudioConnectionPoint(node: wet, bus: 0)])
        audio.connect(dry, audio.mixBus)
        audio.connect(wet, delay)
        audio.connect(delay, audio.mixBus)
        stretch.bypass = true
        let b = eq.bands
        for k in 0...1 { b[k].filterType = .lowShelf; b[k].frequency = 220; b[k].gain = 0; b[k].bypass = false }
        b[2].filterType = .highPass; b[2].frequency = 20; b[2].bandwidth = 1; b[2].bypass = true
        b[3].filterType = .lowPass; b[3].frequency = 20000; b[3].bandwidth = 1; b[3].bypass = true
        wet.outputVolume = 0
        delay.wetDryMix = 100
        delay.feedback = 55
        delay.lowPassCutoff = 6000
        delay.delayTime = 0.5
    }

    func param(_ name: String) -> Automation? {
        switch name {
        case "gain": return gain
        case "send": return send
        case "bass0": return bass0
        case "bass1": return bass1
        case "hp": return highpass
        case "lp": return lowpass
        case "delay": return echoTime
        default: return nil
        }
    }

    /// Where the deck is in its song, in seconds.
    var position: Double {
        guard playing, let node = player.lastRenderTime, let t = player.playerTime(forNodeTime: node) else { return held }
        return min(duration, Double(from + max(0, t.sampleTime)) / audio.rate)
    }

    // MARK: loading

    func load(url: URL?, data: Data?, token: Int) {
        halt()
        self.token = token
        file = nil; samples = nil; duration = 0; held = 0; ended = false; loading = true
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("OpenWave-audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let source = dir.appendingPathComponent("deck\(index)-\(token).m4a") // macOS knows the format by its name
        let decoded = dir.appendingPathComponent("deck\(index)-\(token).caf")
        let finish: (Error?) -> Void = { [weak self] error in
            guard let self else { return }
            if let error { return self.failed(token, error) }
            self.audio.onWork {
                do {
                    let (seconds, mono) = try self.audio.decode(source, into: decoded)
                    try? FileManager.default.removeItem(at: source)
                    let f = try AVAudioFile(forReading: decoded)
                    DispatchQueue.main.async {
                        guard self.token == token else { try? FileManager.default.removeItem(at: decoded); return }
                        self.dropFile()
                        self.file = f; self.fileURL = decoded; self.samples = mono; self.duration = seconds; self.loading = false
                        self.audio.report((self.index, "loaded", nil))
                    }
                } catch { self.failed(token, error) }
            }
        }
        if let data {
            do { try data.write(to: source); finish(nil) } catch { finish(error) }
        } else if let url {
            audio.fetch(url, to: source, done: finish)
        } else {
            finish(NSError(domain: "OpenWave", code: 5, userInfo: [NSLocalizedDescriptionKey: "Nothing to play"]))
        }
    }

    private func failed(_ token: Int, _ error: Error) {
        DispatchQueue.main.async {
            guard self.token == token else { return }
            self.loading = false
            self.audio.report((self.index, "error", error.localizedDescription))
        }
    }

    func unload(token: Int) {
        halt()
        self.token = token
        dropFile()
        samples = nil; duration = 0; held = 0; ended = false; loading = false
        audio.report((index, "emptied", nil))
    }

    private func dropFile() {
        file = nil
        if let u = fileURL { try? FileManager.default.removeItem(at: u) }
        fileURL = nil
    }

    // MARK: transport

    /// Stop the player without it counting as the end of the song.
    func halt() {
        if playing { held = position }
        segment += 1
        player.stop()
        playing = false
    }

    func start(from seconds: Double) {
        guard let f = file else { return }
        segment += 1
        let mine = segment
        let first = AVAudioFramePosition(max(0, min(seconds, duration)) * audio.rate)
        let left = AVAudioFrameCount(max(0, f.length - first))
        from = first
        held = Double(first) / audio.rate
        ended = false
        if left == 0 { ended = true; audio.report((index, "ended", nil)); return }
        player.scheduleSegment(f, startingFrame: first, frameCount: left, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.segment == mine, self.playing else { return }
                self.held = self.duration
                self.playing = false
                self.ended = true
                self.audio.report((self.index, "ended", nil))
            }
        }
        player.play()
        playing = true
        audio.report((index, "playing", nil))
    }

    func play() {
        guard file != nil, !playing else { return }
        start(from: ended ? 0 : held)
    }

    func pause() {
        guard playing else { return }
        halt()
        audio.report((index, "pause", nil))
    }

    func seek(to seconds: Double) {
        let was = playing
        halt()
        held = max(0, min(seconds, duration))
        ended = false
        if was { start(from: held) }
        audio.report((index, "seeked", nil))
    }

    /// Turntable speed (pitch moves with it) when Smart mix asks, otherwise speed with the pitch kept.
    func setRate(_ r: Double, keepPitch: Bool) {
        rate = max(0.5, min(2, r))
        self.keepPitch = keepPitch
        if keepPitch && abs(rate - 1) > 1e-6 {
            varispeed.rate = 1
            stretch.rate = Float(rate)
            stretch.bypass = false
        } else {
            stretch.bypass = true
            stretch.rate = 1
            varispeed.rate = Float(rate)
        }
    }

    // MARK: Smart mix's moves

    /// Volumes and filters for this moment on the engine's clock.
    func apply(at t: Double) {
        dry.outputVolume = Float(max(0, gain.value(at: t)) * (muted ? 0 : volume))
        wet.outputVolume = Float(max(0, min(1, send.value(at: t))) * (muted ? 0 : volume))
        let b = eq.bands
        b[0].gain = Float(bass0.value(at: t))
        b[1].gain = Float(bass1.value(at: t))
        let hp = highpass.value(at: t), lp = lowpass.value(at: t)
        b[2].bypass = hp <= 12
        if hp > 12 { b[2].frequency = Float(min(hp, 20000)) }
        b[3].bypass = lp >= 19000
        if lp < 19000 { b[3].frequency = Float(max(lp, 20)) }
        let d = echoTime.value(at: t)
        if abs(Double(delay.delayTime) - d) > 0.0005 { delay.delayTime = max(0.01, min(2, d)) }
    }

    func sendSamples(id: Int) {
        let data = samples
        audio.onWork { [weak self] in
            guard let self else { return }
            let b64 = data?.base64EncodedString() ?? ""
            self.audio.send("window.__openwaveAudioSamples && window.__openwaveAudioSamples(\(self.index), \(id), \"\(b64)\")")
        }
    }
}

// MARK: - automation

/// A value that moves on the engine's clock, like a Web Audio parameter: the page sends its whole
/// list of moves (js/native-deck.js keeps it), and this works out the value at any moment.
final class Automation {
    struct Move { var kind: String; var time: Double; var value: Double; var end: Double; var curve: [Double] }
    var events: [Move] = []
    let initial: Double
    init(_ v: Double) { initial = v }

    static func parse(_ list: [[String: Any]]) -> [Move] {
        list.compactMap { e in
            guard let kind = e["kind"] as? String, let time = e["time"] as? Double else { return nil }
            return Move(kind: kind, time: time, value: e["value"] as? Double ?? 0, end: e["end"] as? Double ?? time, curve: e["curve"] as? [Double] ?? [])
        }.sorted { $0.time < $1.time }
    }

    func value(at t: Double) -> Double {
        var v = initial, vt = -Double.infinity
        for (k, e) in events.enumerated() {
            switch e.kind {
            case "curve":
                if t < e.time { return v }
                if t <= e.end, !e.curve.isEmpty {
                    let p = (t - e.time) / max(1e-9, e.end - e.time) * Double(e.curve.count - 1)
                    let i = min(e.curve.count - 2, Int(p)), f = p - Double(i)
                    return e.curve.count == 1 ? e.curve[0] : e.curve[i] * (1 - f) + e.curve[i + 1] * f
                }
                v = e.curve.last ?? v; vt = e.end
            case "linear", "exp":
                if t < e.time {
                    let span = e.time - vt, p = span.isFinite && span > 0 ? (t - vt) / span : 1
                    if e.kind == "exp", v > 0, e.value > 0 { return v * pow(e.value / v, p) }
                    return v + (e.value - v) * p
                }
                v = e.value; vt = e.time
            default: // set
                if t < e.time { return v }
                v = e.value; vt = e.time
            }
            _ = k
        }
        return v
    }
}
