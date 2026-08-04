import { timingSafeEqual } from "node:crypto";

export function tokenEquals(provided: string | undefined, expected: string | undefined) {
  if (!provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function bearerToken(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1];
}

export function singleHeaderValue(header: string | string[] | undefined) {
  return Array.isArray(header) ? header[0] : header;
}
