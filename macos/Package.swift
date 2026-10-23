// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "OpenWave",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "OpenWave", path: "Sources/OpenWave"),
    ]
)
