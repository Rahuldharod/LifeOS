import Foundation
import Security

guard CommandLine.arguments.count == 4 else {
  FileHandle.standardError.write(Data("usage: keychain-helper get|set service account\n".utf8))
  exit(64)
}

let operation = CommandLine.arguments[1]
let service = CommandLine.arguments[2]
let account = CommandLine.arguments[3]
let query: [CFString: Any] = [
  kSecClass: kSecClassGenericPassword,
  kSecAttrService: service,
  kSecAttrAccount: account
]

if operation == "get" {
  var lookup = query
  lookup[kSecReturnData] = true
  lookup[kSecMatchLimit] = kSecMatchLimitOne
  var result: CFTypeRef?
  let status = SecItemCopyMatching(lookup as CFDictionary, &result)
  if status == errSecItemNotFound { exit(44) }
  guard status == errSecSuccess, let data = result as? Data else {
    FileHandle.standardError.write(Data("Keychain lookup failed (\(status))\n".utf8))
    exit(1)
  }
  FileHandle.standardOutput.write(data)
} else if operation == "set" {
  let value = FileHandle.standardInput.readDataToEndOfFile()
  guard !value.isEmpty else {
    FileHandle.standardError.write(Data("Refusing to store an empty value\n".utf8))
    exit(65)
  }
  let updateStatus = SecItemUpdate(query as CFDictionary, [kSecValueData: value] as CFDictionary)
  if updateStatus == errSecItemNotFound {
    var addition = query
    addition[kSecValueData] = value
    addition[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlock
    let addStatus = SecItemAdd(addition as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      FileHandle.standardError.write(Data("Keychain write failed (\(addStatus))\n".utf8))
      exit(1)
    }
  } else if updateStatus != errSecSuccess {
    FileHandle.standardError.write(Data("Keychain update failed (\(updateStatus))\n".utf8))
    exit(1)
  }
} else {
  FileHandle.standardError.write(Data("Unknown operation\n".utf8))
  exit(64)
}
