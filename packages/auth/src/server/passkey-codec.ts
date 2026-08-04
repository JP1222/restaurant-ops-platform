export function encodeCredentialId(buffer: Uint8Array): string {
  return Buffer.from(buffer).toString("base64url");
}

export function decodeCredentialId(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export function userIdToWebAuthnUserHandle(userId: string): Uint8Array {
  return new TextEncoder().encode(userId);
}

export function publicKeyBytesToUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  return new Uint8Array(value);
}
