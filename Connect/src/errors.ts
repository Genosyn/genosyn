/**
 * The only errors whose message may reach an HTTP response. Anything else —
 * a database failure, an upstream body, a fetch error — is logged without
 * detail and answered with a generic message, because the requests this
 * service handles carry authorization codes and refresh tokens.
 */
export class ConnectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

export class RateLimitError extends ConnectError {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many attempts. Try again later.", 429);
    this.name = "RateLimitError";
  }
}

/** An upstream identity provider failed; its body and error never leave this process. */
export class UpstreamError extends ConnectError {
  constructor(message = "Sign-in could not be completed. Please try again.", status = 502) {
    super(message, status);
    this.name = "UpstreamError";
  }
}
