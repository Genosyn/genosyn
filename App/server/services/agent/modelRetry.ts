/**
 * Retry policy for one model turn.
 *
 * The provider SDKs each ship their own hidden retry loop. The model clients
 * disable that loop so this module is the single authority: operators can see
 * retries in Run logs, every provider behaves the same way, and a cancellation
 * interrupts the backoff instead of waiting for an SDK timeout.
 */

/** Total provider calls allowed for one turn, counting the first. */
export const MODEL_TURN_MAX_ATTEMPTS = 5;

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 8_000;
const RETRY_AFTER_MAX_MS = 30_000;

type ErrorRecord = Record<string, unknown>;

/**
 * Retry only failures that can plausibly succeed without changing the request.
 *
 * This matches the useful overlap of the Anthropic and OpenAI SDK policies:
 * request timeout/conflict, rate limit, provider 5xx, and transport failures.
 * Authentication, not-found, validation, and other 4xx responses fail
 * immediately.
 */
export function isRetryableModelError(error: unknown): boolean {
  const record = asRecord(error);
  const status = numberField(record, "status") ?? numberField(record, "statusCode");
  if (status === 408 || status === 409 || status === 429) return true;
  if (status !== null) return status >= 500;

  const name = stringField(record, "name") ?? "";
  const message = stringField(record, "message") ?? String(error);
  const code = causeString(record, "code") ?? "";
  const haystack = `${name} ${message} ${code}`.toLowerCase();
  return /apiconnection|apitimeout|connection error|fetch failed|network|socket hang up|econnreset|econnrefused|enotfound|eai_again|enetunreach|ehostunreach|etimedout|und_err|epipe/.test(
    haystack,
  );
}

/** Short, credential-free reason suitable for a Run transcript. */
export function modelRetryReason(error: unknown): string {
  const record = asRecord(error);
  const status = numberField(record, "status") ?? numberField(record, "statusCode");
  if (status !== null) return `HTTP ${status}`;
  const code = causeString(record, "code");
  return code ? `transport error ${code}` : "temporary model connection error";
}

/**
 * Delay before retry number `retryNumber` (1 = the first retry).
 *
 * Provider `Retry-After` wins, but is capped so an unhealthy service cannot
 * park an employee for minutes. Otherwise use exponential backoff with the
 * same 75–100% jitter band the provider SDKs use.
 */
export function modelRetryDelayMs(
  error: unknown,
  retryNumber: number,
  options: { rng?: () => number; nowMs?: number } = {},
): number {
  const requested = retryAfterMs(error, options.nowMs ?? Date.now());
  if (requested !== null) return Math.min(requested, RETRY_AFTER_MAX_MS);

  const exponent = Math.min(Math.max(0, Math.floor(retryNumber) - 1), 30);
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent);
  const rawRandom = (options.rng ?? Math.random)();
  const random = Number.isFinite(rawRandom) ? Math.min(1, Math.max(0, rawRandom)) : 0;
  return Math.floor(ceiling * (0.75 + random * 0.25));
}

/** A cancellation-aware wait; aborting a chat or Run stops the retry promptly. */
export async function waitForModelRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, delayMs));

    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(abortError(signal));
    }

    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function retryAfterMs(error: unknown, nowMs: number): number | null {
  const record = asRecord(error);
  const headers = record?.headers ?? asRecord(record?.response)?.headers;

  const milliseconds = header(headers, "retry-after-ms");
  if (milliseconds !== null) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }

  const retryAfter = header(headers, "retry-after");
  if (retryAfter === null) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1_000);
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function header(headers: unknown, name: string): string | null {
  const record = asRecord(headers);
  const getter = record?.get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    return typeof value === "string" && value.trim() ? value : null;
  }
  if (!record) return null;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name && typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function causeString(record: ErrorRecord | null, key: string): string | null {
  let current = record;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const found = stringField(current, key);
    if (found) return found;
    current = asRecord(current.cause);
  }
  return null;
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("The model request was aborted."), { name: "AbortError" });
}

function asRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === "object" ? (value as ErrorRecord) : null;
}

function stringField(record: ErrorRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberField(record: ErrorRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
