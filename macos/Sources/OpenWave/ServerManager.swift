import Darwin
import Foundation

/// Runs the OpenWave server that ships inside the app bundle (Resources/server/openwave-server).
///
/// The port is fixed (47878) whenever possible: the web view keeps your downloads and session per
/// origin, so a stable port means they're still there next launch.
final class ServerManager: ObservableObject {
    static let shared = ServerManager()
    static let preferredPort = 47878

    enum Status: Equatable { case starting, running, failed(String) }

    @Published private(set) var status: Status = .starting
    @Published private(set) var port = ServerManager.preferredPort
    @Published var lanEnabled = UserDefaults.standard.bool(forKey: "lanEnabled")
    @Published private(set) var health: [String: Any] = [:]

    private var process: Process?
    private var stopping = false
    private var restarts = 0

    static let supportDir: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("OpenWave")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    static let logURL: URL = {
        let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("Logs/OpenWave")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("server.log")
    }()
    private static let pidURL = supportDir.appendingPathComponent("server.pid")

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    var lanURL: URL? { Network.lanIPv4().map { URL(string: "http://\($0):\(port)")! } }

    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        if let dev = ProcessInfo.processInfo.environment["OPENWAVE_DEV_URL"], let url = URL(string: dev) {
            status = .running
            return completion(.success(url))
        }
        stopping = false
        status = .starting
        killStaleServer()
        guard let exe = Bundle.main.resourceURL?.appendingPathComponent("server/openwave-server"),
              FileManager.default.isExecutableFile(atPath: exe.path) else {
            return fail("The OpenWave engine is missing from the app. Please reinstall OpenWave.", completion)
        }
        port = choosePort()
        let proc = Process()
        proc.executableURL = exe
        proc.arguments = ["--host", lanEnabled ? "0.0.0.0" : "127.0.0.1", "--port", String(port)]
        var env = ProcessInfo.processInfo.environment
        env["OPENWAVE_BIN_DIR"] = Bundle.main.resourceURL!.appendingPathComponent("bin").path
        if env["OPENWAVE_DATA"] == nil { env["OPENWAVE_DATA"] = Self.supportDir.path }
        env["PYTHONUNBUFFERED"] = "1"
        // Other devices on the Wi-Fi see this Mac by its name, and can find it out of the box.
        env["OPENWAVE_DEVICE_NAME"] = Host.current().localizedName ?? "Mac"
        env["OPENWAVE_DEVICE_KIND"] = "computer"
        env["OPENWAVE_LINK"] = "1"
        proc.environment = env
        FileManager.default.createFile(atPath: Self.logURL.path, contents: nil)
        if let log = try? FileHandle(forWritingTo: Self.logURL) {
            proc.standardOutput = log
            proc.standardError = log
        }
        proc.terminationHandler = { [weak self] p in
            DispatchQueue.main.async { self?.processExited(p, completion: completion) }
        }
        do {
            try proc.run()
        } catch {
            return fail(error.localizedDescription, completion)
        }
        process = proc
        try? String(proc.processIdentifier).write(to: Self.pidURL, atomically: true, encoding: .utf8)
        waitUntilHealthy(deadline: Date().addingTimeInterval(60), completion: completion)
    }

    func stop() {
        stopping = true
        guard let proc = process, proc.isRunning else { return }
        proc.terminate()
        let deadline = Date().addingTimeInterval(3)
        while proc.isRunning && Date() < deadline { usleep(50_000) }
        if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
        process = nil
        try? FileManager.default.removeItem(at: Self.pidURL)
    }

    func setLAN(_ enabled: Bool) {
        lanEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: "lanEnabled")
        restart()
    }

    func restart() {
        stop()
        start { result in
            if case .success(let url) = result { WebHost.shared.load(url) }
        }
    }

    // MARK: private

    private func processExited(_ proc: Process, completion: @escaping (Result<URL, Error>) -> Void) {
        guard proc === process, !stopping else { return }
        process = nil
        if restarts < 3 {
            restarts += 1
            start { result in if case .success(let url) = result { WebHost.shared.load(url) } }
        } else {
            status = .failed("The OpenWave engine keeps stopping. See Help → Show Server Log.")
        }
    }

    private func fail(_ message: String, _ completion: (Result<URL, Error>) -> Void) {
        status = .failed(message)
        completion(.failure(NSError(domain: "OpenWave", code: 1, userInfo: [NSLocalizedDescriptionKey: message])))
    }

    private func waitUntilHealthy(deadline: Date, completion: @escaping (Result<URL, Error>) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/health"))
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.health = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
                    self.status = .running
                    self.restarts = 0
                    completion(.success(self.baseURL))
                } else if self.process?.isRunning != true {
                    self.fail("The OpenWave engine stopped while starting. See Help → Show Server Log.", completion)
                } else if Date() > deadline {
                    self.fail("The OpenWave engine took too long to start.", completion)
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitUntilHealthy(deadline: deadline, completion: completion) }
                }
            }
        }.resume()
    }

    private func choosePort() -> Int {
        for candidate in Self.preferredPort..<(Self.preferredPort + 20) where Network.isPortFree(candidate, anyInterface: lanEnabled) {
            return candidate
        }
        return Self.preferredPort
    }

    /// A previous run that crashed may have left its engine running on our port.
    private func killStaleServer() {
        guard let text = try? String(contentsOf: Self.pidURL, encoding: .utf8), let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        var buffer = [CChar](repeating: 0, count: 4096)
        if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0, String(cString: buffer).hasSuffix("openwave-server") {
            kill(pid, SIGTERM)
            usleep(300_000)
        }
        try? FileManager.default.removeItem(at: Self.pidURL)
    }
}

enum Network {
    /// Free means nothing is listening and the engine could bind it. Bound with SO_REUSEADDR like
    /// the engine (uvicorn) is, so connections left over from the last run, still in TIME_WAIT,
    /// don't push OpenWave onto another port (which would hide downloads stored for this one).
    static func isPortFree(_ port: Int, anyInterface: Bool) -> Bool {
        if isListening(port) { return false }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in(port: port, host: anyInterface ? INADDR_ANY : inet_addr("127.0.0.1"))
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }

    /// Is something already answering on 127.0.0.1:port?
    private static func isListening(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in(port: port, host: inet_addr("127.0.0.1"))
        return withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
        }
    }

    /// The Wi-Fi / Ethernet address phones on the same network can reach.
    static func lanIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        var best: String?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let iface = ptr.pointee
            guard iface.ifa_addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: iface.ifa_name)
            guard name.hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            getnameinfo(iface.ifa_addr, socklen_t(iface.ifa_addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            let ip = String(cString: host)
            if name == "en0" { return ip }
            best = best ?? ip
        }
        return best
    }
}

private extension sockaddr_in {
    init(port: Int, host: in_addr_t) {
        self.init()
        sin_family = sa_family_t(AF_INET)
        sin_port = in_port_t(UInt16(port).bigEndian)
        sin_addr.s_addr = host
    }
}
