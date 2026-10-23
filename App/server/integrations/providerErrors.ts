/**
 * A request to a provider's API that did not come back with what was asked
 * for: an HTTP error status, or no answer at all (`status` 0 — a timeout, a
 * refused connection, DNS).
 *
 * The message stays the provider's own words, as each provider has always
 * thrown them. What this adds is the status and `Retry-After`, so a caller
 * that keeps a feed in step — Banking's background sync — can tell a rejected
 * token from a busy provider without parsing sentences, and wait as long as
 * the provider asked before trying again.
 */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    /** The provider's product name, as a person says it: "Brex", "Wise", "Stripe". */
    readonly provider: string,
    /** The HTTP status, or 0 when the provider never answered. */
    readonly status: number,
    /** How long the provider asked callers to wait, when it said. */
    readonly retryAfterMs: number | null = null,
    /** What was asked for — "GET /v2/accounts/cash" — never with a credential. */
    readonly request: string = "",
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** The longest `Retry-After` honored; past it a caller simply tries later. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Read a `Retry-After` header: a number of seconds, or an HTTP date. Null when
 * there is none or it says nothing usable, so the caller backs off its own way.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Math.ceil(Number(value) * 1000);
    return Number.isFinite(ms) ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

/** A fetch that failed before any answer came back: a timeout, a reset, DNS. */
export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    (err instanceof TypeError && /fetch failed|network|socket|ECONN|ENOTFOUND|EAI_AGAIN/i.test(err.message))
  );
}
