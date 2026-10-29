import CryptoKit
import Foundation
import Security

/// The Mac's door has a certificate of ruri's own, which no authority
/// vouches for (server/tlsCert.ts). The phone trusts that one certificate,
/// by the fingerprint the pairing code carried, and nothing else — so the
/// line is private on any network, and nothing in between can pass for the
/// Mac.
enum Pinning {
    /// SHA-256 of a certificate's DER, base64url and unpadded — as
    /// server/tlsCert.ts's fingerprint() writes it.
    static func fingerprint(of der: Data) -> String {
        Data(SHA256.hash(data: der)).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Whether the certificate a server shows is the pinned one.
    static func holds(_ trust: SecTrust, fingerprint: String) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first
        else { return false }
        return Self.fingerprint(of: SecCertificateCopyData(leaf) as Data) == fingerprint
    }
}

/// A URLSession's delegate that lets a server in only by the pinned
/// certificate: whatever the name or address, and with no authority asked.
/// It is each task's delegate too, so a streaming task (`bytes(for:)`) on a
/// connection of its own is asked as well. App Transport Security is off
/// (Info.plist) so a tailnet address (100.64.0.0/10, not "local" to iOS)
/// reaches this check at all; a connection that somehow skipped it would
/// still meet the system's trust, which refuses ruri's own certificate.
final class PinnedDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let fingerprint: String

    init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge
    ) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        answer(challenge)
    }

    private func answer(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else { return (.performDefaultHandling, nil) }
        guard Pinning.holds(trust, fingerprint: fingerprint) else {
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }
}
