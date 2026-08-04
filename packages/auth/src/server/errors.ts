export type AuthErrorCode =
  | "authentication_required"
  | "challenge_expired"
  | "invalid_credentials"
  | "invalid_origin"
  | "passkey_already_registered"
  | "passkey_not_found"
  | "passkey_verification_failed"
  | "rate_limited"
  | "session_expired";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: AuthErrorCode
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export class AuthenticationRequiredError extends AuthError {
  constructor(message = "Authentication required.") {
    super(message, "authentication_required");
    this.name = "AuthenticationRequiredError";
  }
}

export class InvalidCredentialError extends AuthError {
  constructor(message = "Invalid username or password.") {
    super(message, "invalid_credentials");
    this.name = "InvalidCredentialError";
  }
}

export class InvalidOriginError extends AuthError {
  constructor(message = "Untrusted origin.") {
    super(message, "invalid_origin");
    this.name = "InvalidOriginError";
  }
}

export class PasskeyVerificationError extends AuthError {
  constructor(message = "Passkey authentication failed.") {
    super(message, "passkey_verification_failed");
    this.name = "PasskeyVerificationError";
  }
}

export class PasskeyAlreadyRegisteredError extends AuthError {
  constructor(message = "Passkey already registered.") {
    super(message, "passkey_already_registered");
    this.name = "PasskeyAlreadyRegisteredError";
  }
}

export class PasskeyNotFoundError extends AuthError {
  constructor(message = "Passkey not found.") {
    super(message, "passkey_not_found");
    this.name = "PasskeyNotFoundError";
  }
}

export class ChallengeExpiredError extends AuthError {
  constructor(message = "Passkey verification expired. Try again.") {
    super(message, "challenge_expired");
    this.name = "ChallengeExpiredError";
  }
}

export class SessionExpiredError extends AuthError {
  constructor(message = "Session expired.") {
    super(message, "session_expired");
    this.name = "SessionExpiredError";
  }
}

export class RateLimitedError extends AuthError {
  constructor(
    message = "Too many login attempts.",
    public readonly retryAfterSeconds: number | null = null
  ) {
    super(message, "rate_limited");
    this.name = "RateLimitedError";
  }
}
