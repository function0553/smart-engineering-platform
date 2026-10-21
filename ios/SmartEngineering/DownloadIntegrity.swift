import Foundation
import CryptoKit

enum DownloadIntegrity {
    static func verify(_ file: URL, expectedBytes: Int64, sha256: String?) throws {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var bytes: Int64 = 0
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            bytes += Int64(chunk.count)
            if bytes > PlatformPolicy.maximumDownloadBytes { throw Failure.invalid }
            hasher.update(data: chunk)
        }
        guard bytes > 0, expectedBytes < 0 || expectedBytes == bytes else { throw Failure.invalid }
        if let sha256 {
            guard hasher.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else { throw Failure.invalid }
        }
    }
    enum Failure: Error { case invalid }
}
