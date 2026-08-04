import { describe, expect, it } from "vitest";
import {
  AuthError,
  ChallengeExpiredError,
  InvalidCredentialError,
  PasskeyAlreadyRegisteredError,
  RateLimitedError
} from "../src/server/errors.js";

describe("auth errors", () => {
  it("preserves stable error codes for route mapping", () => {
    expect(new InvalidCredentialError()).toMatchObject({
      code: "invalid_credentials",
      message: "Invalid username or password.",
      name: "InvalidCredentialError"
    });
    expect(new PasskeyAlreadyRegisteredError().code).toBe("passkey_already_registered");
    expect(new ChallengeExpiredError().code).toBe("challenge_expired");
  });

  it("carries retry metadata for rate-limited responses", () => {
    const error = new RateLimitedError(undefined, 120);

    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(120);
  });
});
