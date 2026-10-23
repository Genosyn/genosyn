import { isNetworkFailure, ProviderRequestError } from "../integrations/providerErrors.js";
import { WiseScaRequiredError } from "../integrations/providers/wise.js";
import { ConnectionAuthError } from "../integrations/types.js";

/**
 * Why a bank account or card on Banking could not sync, in words a person can
 * act on — the half of the sync status that explains a failure
 * (`services/bankingSync.ts` keeps the rest).
 *
 * A provider throws its own sentence for each failure, which is right for the
 * person who pressed Sync now and wrong for a card that has to say, in a
 * line, what is wrong and what fixes it. So every failure is sorted into a
 * kind. The kind picks the line on the card ("Brex rejected the token"), what
 * the card offers (Reconnect, Choose a Connection, nothing but wait), and how
 * long the background sync waits before trying again. The provider's own
 * words, the HTTP status and the request ride along as the details.
 */

export type FeedSyncErrorKind =
  /** The provider rejected the credential: a revoked, expired or mistyped token. */
  | "auth"
  /** The credential works, but may not read what this account needs. */
  | "permission"
  /** The Connection the account syncs through was removed. */
  | "connection_missing"
  /** The Connection's saved credential can't be read, or is missing its token. */
  | "credentials"
  /** The account, card or balance is no longer on the Connection. */
  | "account_missing"
  /** The provider asked Genosyn to slow down. */
  | "rate_limited"
  /** The provider didn't answer, or failed on its side. */
  | "provider_unavailable"
  /** The provider refused the request for another reason. */
  | "provider_error"
  /** The provider sent something Genosyn won't guess about, such as a transaction with no amount. */
  | "bad_data"
  /** This account can't be synced as it is, such as a balance in another currency. */
  | "unsupported"
  /** Anything else — a bug, or the database. */
  | "internal";

export const FEED_SYNC_ERROR_KINDS: readonly FeedSyncErrorKind[] = [
  "auth",
  "permission",
  "connection_missing",
  "credentials",
  "account_missing",
  "rate_limited",
  "provider_unavailable",
  "provider_error",
  "bad_data",
  "unsupported",
  "internal",
];

/**
 * Failures that stay until a person changes something: retrying them every few
 * minutes only presents a dead token to the provider again and again, which
 * is how an account gets locked. The background sync waits longer between
 * these, and tries again at once when the Connection changes.
 */
export const NEEDS_A_PERSON: ReadonlySet<FeedSyncErrorKind> = new Set<FeedSyncErrorKind>([
  "auth",
  "permission",
  "connection_missing",
  "credentials",
  "account_missing",
  "unsupported",
]);

/** A failure Genosyn itself recognised, with the kind already decided. */
export class FeedSyncError extends Error {
  constructor(
    readonly kind: FeedSyncErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "FeedSyncError";
  }
}

/** What one feed reads from its provider, for the sentences below. */
export type FeedSyncContext = {
  /** "Brex", "Wise", "Stripe". */
  provider: string;
  /** What the provider calls the credential: "token", "API key", "API token". */
  credential: string;
  /** What this account reads: "cash transactions", "card transactions", "payouts". */
  reads: string;
};

export type FeedSyncFailure = {
  kind: FeedSyncErrorKind;
  /** One line for the card, without a trailing full stop: "Brex rejected the token". */
  message: string;
  /** The provider's own words, the status and the request, for "View details". */
  detail: string;
  /** How long the provider asked Genosyn to wait, when it said. */
  retryAfterMs: number | null;
  /** How the Connection row should be marked, when the credential itself is dead. */
  connectionStatus: "error" | "expired" | null;
};

const MAX_MESSAGE = 300;
const MAX_DETAIL = 2_000;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function withoutFullStop(text: string): string {
  return text.replace(/\.\s*$/, "");
}

function requestDetail(err: ProviderRequestError): string {
  const parts = [
    err.message,
    err.status ? `HTTP ${err.status}` : "no answer",
    err.request,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Sort a thrown value into a kind, with the line the card shows and the details behind it. */
export function describeFeedSyncFailure(err: unknown, context: FeedSyncContext): FeedSyncFailure {
  const { provider, credential, reads } = context;
  const failure = (
    kind: FeedSyncErrorKind,
    message: string,
    detail: string,
    extra: Partial<Pick<FeedSyncFailure, "retryAfterMs" | "connectionStatus">> = {},
  ): FeedSyncFailure => ({
    kind,
    message: clip(withoutFullStop(message), MAX_MESSAGE),
    detail: clip(detail, MAX_DETAIL),
    retryAfterMs: extra.retryAfterMs ?? null,
    connectionStatus: extra.connectionStatus ?? null,
  });

  if (err instanceof FeedSyncError) {
    const said = err.message;
    switch (err.kind) {
      case "connection_missing":
        return failure(err.kind, `The ${provider} Connection this account used was removed`, said);
      case "credentials":
        return failure(err.kind, `Genosyn can't read the ${provider} ${credential} saved on the Connection`, said);
      case "bad_data":
        return failure(err.kind, `${provider} sent a transaction Genosyn couldn't read`, said);
      default:
        // Already a plain sentence about this account ("This Wise balance is
        // no longer on the Connection"), so it is the line itself.
        return failure(err.kind, said, said);
    }
  }

  if (err instanceof ConnectionAuthError) {
    return failure("auth", `${provider} rejected the ${credential}`, err.message, {
      connectionStatus: err.connectionStatus,
    });
  }

  if (err instanceof WiseScaRequiredError) {
    return failure(
      "unsupported",
      "Wise holds this balance's statements for Strong Customer Authentication",
      requestDetail(err),
    );
  }

  if (err instanceof ProviderRequestError) {
    const detail = requestDetail(err);
    if (err.status === 401) {
      return failure("auth", `${provider} rejected the ${credential}`, detail, {
        connectionStatus: "expired",
      });
    }
    if (err.status === 403) {
      return failure("permission", `${provider} won't let this ${credential} read ${reads}`, detail);
    }
    if (err.status === 404) {
      return failure(
        "account_missing",
        `${provider} couldn't find this account — it may have been closed`,
        detail,
      );
    }
    if (err.status === 429) {
      return failure("rate_limited", `${provider} asked Genosyn to slow down`, detail, {
        retryAfterMs: err.retryAfterMs,
      });
    }
    if (err.status === 0) {
      return failure("provider_unavailable", `${provider} didn't answer`, detail);
    }
    if (err.status >= 500) {
      return failure("provider_unavailable", `${provider} had a problem on its side`, detail, {
        retryAfterMs: err.retryAfterMs,
      });
    }
    return failure("provider_error", `${provider} refused the request`, detail);
  }

  if (isNetworkFailure(err)) {
    const said = err instanceof Error ? err.message : String(err);
    return failure("provider_unavailable", `Genosyn couldn't reach ${provider}`, said);
  }

  const said = err instanceof Error ? err.message || err.name : String(err);
  return failure("internal", "The sync stopped on an unexpected error", said);
}

// ─────────────────────────── retrying a request ───────────────────────────

/** Requests made in all, the first included, before one failure ends the sync. */
const ATTEMPTS = 3;
/** The longest one sync waits inline; past this a `Retry-After` ends the attempt. */
const MAX_INLINE_WAIT_MS = 20_000;

let sleepForTests: ((ms: number) => Promise<void>) | null = null;

/** Replace the waits between retries, so a test need not sleep. `null` restores them. */
export function setProviderRetrySleepForTests(sleep: ((ms: number) => Promise<void>) | null): void {
  sleepForTests = sleep;
}

function sleep(ms: number): Promise<void> {
  if (sleepForTests) return sleepForTests(ms);
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** How long to wait before asking again, or null when asking again can't help. */
function retryWait(err: unknown, attempt: number): number | null {
  const backoff = 1_000 * 2 ** (attempt - 1);
  if (err instanceof ProviderRequestError) {
    if (err.status === 429) return err.retryAfterMs ?? backoff;
    if (err.status === 0 || err.status >= 500) return Math.max(backoff, err.retryAfterMs ?? 0);
    return null;
  }
  return isNetworkFailure(err) ? backoff : null;
}

/**
 * Make one provider request, asking again when the provider was busy or
 * briefly unreachable: a 429, a 5xx, a timeout, a reset connection. A
 * rejected token or a missing account fails at once — asking again can't
 * change the answer. A provider that asks for more than twenty seconds is
 * left alone: the sync fails with that wait, and the background sync comes
 * back after it.
 */
export async function withProviderRetry<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (err) {
      const wait = retryWait(err, attempt);
      if (wait === null || attempt >= ATTEMPTS || wait > MAX_INLINE_WAIT_MS) throw err;
      await sleep(wait);
    }
  }
}
