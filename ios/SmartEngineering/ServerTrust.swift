import Foundation
import Security

enum ServerTrust {
    static func evaluate(_ trust: SecTrust, host: String, port: Int, anchor: SecCertificate) -> Bool {
        guard host == PlatformPolicy.home.host, port == PlatformPolicy.home.port else { return false }
        let policy = SecPolicyCreateSSL(true, host as CFString)
        return SecTrustSetPolicies(trust, policy) == errSecSuccess &&
            SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess &&
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess &&
            SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess &&
            SecTrustEvaluateWithError(trust, nil)
    }
}
