/**
 * Byte checks shared by document adapters: signature prefixes and the
 * encrypted-OOXML (CFB container) test. Dependency-free so an adapter can
 * use them without loading another adapter's parser stack.
 *
 * @module src/converters/adapters/shared/ooxml-protection
 */

const CFB_SIGNATURE = new Uint8Array([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

export function utf16le(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf16le"));
}

const ENCRYPTION_INFO = utf16le("EncryptionInfo");
const ENCRYPTED_PACKAGE = utf16le("EncryptedPackage");

export function hasPrefix(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

export function includesBytes(bytes: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || bytes.length < needle.length) {
    return false;
  }
  outer: for (
    let index = 0;
    index <= bytes.length - needle.length;
    index += 1
  ) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** An encrypted (password-protected) OOXML workbook: a CFB container. */
export function isPasswordProtectedXlsx(bytes: Uint8Array): boolean {
  return (
    hasPrefix(bytes, CFB_SIGNATURE) &&
    includesBytes(bytes, ENCRYPTION_INFO) &&
    includesBytes(bytes, ENCRYPTED_PACKAGE)
  );
}
