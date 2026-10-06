/**
 * The only errors whose message may reach an HTTP response. Anything else —
 * an upstream body, a fetch error — is logged without detail and answered
 * with a generic message, because the requests this service handles carry
 * authorization codes and refresh tokens.
 */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** Sent back to the installation when a sign-in ends without a credential. */
    readonly code?: SignInErrorCode,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * Why a sign-in ended without a credential, as the installation is told it.
 * Codes, not prose: the installation owns the wording its people read.
 */
export type SignInErrorCode =
  | "access_denied"
  | "account_unverified"
  | "offline_access_missing"
  | "registration_changed"
  | "exchange_failed";

export class RateLimitError extends ConnectError {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many attempts. Try again later.", 429);
    this.name = "RateLimitError";
  }
}

/** An upstream identity provider failed; its body and error never leave this process. */
export class UpstreamError extends ConnectError {
  constructor(
    message = "Sign-in could not be completed. Please try again.",
    status = 502,
    code: SignInErrorCode = "exchange_failed",
  ) {
    super(message, status, code);
    this.name = "UpstreamError";
  }
}
