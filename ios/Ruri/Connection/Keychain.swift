import Foundation
import Security

/// The phone's key for its Mac, kept in the keychain: on this device only,
/// readable once it has been unlocked since starting.
enum Keychain {
    private static let service = "com.justin06lee.ruri.phone"

    private static func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func save(_ secret: String, account: String) throws {
        #if targetEnvironment(macCatalyst)
        // run on a Mac for a look at it (ios/demo/mac.sh), unsigned: no
        // keychain will take it
        DevMac.keys[account] = secret
        #else
        delete(account: account)
        var item = query(account)
        item[kSecValueData as String] = Data(secret.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        #endif
    }

    static func read(account: String) -> String? {
        #if targetEnvironment(macCatalyst)
        return DevMac.keys[account]
        #else
        var item = query(account)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &found) == errSecSuccess,
              let data = found as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
        #endif
    }

    static func delete(account: String) {
        #if targetEnvironment(macCatalyst)
        DevMac.keys[account] = nil
        #else
        SecItemDelete(query(account) as CFDictionary)
        #endif
    }
}
