import { describe, expect, it } from "vitest";
import {
  decodeCredentialId,
  encodeCredentialId,
  publicKeyBytesToUint8Array,
  userIdToWebAuthnUserHandle
} from "../src/server/passkey-codec.js";

describe("passkey codec helpers", () => {
  it("round-trips credential IDs through base64url without padding", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = encodeCredentialId(bytes);

    expect(encoded).toBe("AAEC_f7_");
    expect(encoded).not.toContain("=");
    expect(decodeCredentialId(encoded)).toEqual(bytes);
  });

  it("encodes WebAuthn user handles with TextEncoder semantics", () => {
    expect(userIdToWebAuthnUserHandle("admin-1")).toEqual(new TextEncoder().encode("admin-1"));
  });

  it("copies public key bytes into a detached Uint8Array", () => {
    const source = new Uint8Array([1, 2, 3]);
    const copy = publicKeyBytesToUint8Array(source);

    source[0] = 9;
    expect(copy).toEqual(new Uint8Array([1, 2, 3]));
  });
});
