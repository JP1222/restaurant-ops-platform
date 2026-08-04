import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function normalizeSignature(input: string) {
  return input.trim().replace(/^sha256=/i, "").toLowerCase();
}

export function computeHmacSha256Hex(secret: string, payload: string | Buffer) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function timingSafeCompare(left: string, right: string) {
  const leftBuffer = Buffer.from(normalizeSignature(left), "utf8");
  const rightBuffer = Buffer.from(normalizeSignature(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function makeOauthState(secret: string, payload: Record<string, string>) {
  const nonce = randomBytes(12).toString("hex");
  const body = Buffer.from(JSON.stringify({ ...payload, nonce, issuedAt: Date.now() })).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readOauthState(secret: string, state: string | undefined) {
  if (!state) {
    throw new Error("Missing OAuth state.");
  }

  const [body, signature] = state.split(".");
  if (!body || !signature) {
    throw new Error("Invalid OAuth state format.");
  }

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (expected !== signature) {
    throw new Error("OAuth state signature mismatch.");
  }

  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as {
    merchantId?: string;
    returnTo?: string;
    issuedAt?: number;
  };

  if (!parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000) {
    throw new Error("OAuth state expired.");
  }

  return parsed;
}
