/**
 * Health bookkeeping for browser-login Connections.
 *
 * A browser-login Connection (`authMode: "browser"`) has no token to check.
 * Its only real credential is a live logged-in session, and the site on the
 * other end can revoke that at any moment — by expiring the cookies, by
 * showing a captcha, by demanding a 2FA code, or by deciding this login
 * looks unusual. None of those are things we may defeat, and none of them
 * are things the operator can see from a green "Connected" pill.
 *
 * Before this module existed, all of that was invisible:
 *
 *   * `checkStatus` reported "connected" whenever a username and password
 *     were *present*, so Settings → Integrations claimed X was fine while
 *     every tool call failed.
 *   * A blocked login threw a bare string. Nothing recorded it, so the next
 *     tool call drove the same doomed 60-second login again — and repeated
 *     login attempts are exactly what makes a site's block stick harder.
 *   * The AI employee had no way to distinguish "the site is challenging
 *     us" from "the integration is broken", so it guessed, and its guesses
 *     read to the operator as contradictory.
 *
 * So a browser-login Connection carries a `sessionHealth` record inside its
 * encrypted config (no migration: the config blob is provider-shaped
 * already). It names what happened, when, how many times, when we may try
 * again, and — the part that matters to a human — what to actually do about
 * it.
 *
 * The remedy copy is the point of this module. "X blocked the publish
 * attempt" tells an operator nothing. "X is asking for a verification code.
 * Open the connection's browser session, take over, finish the sign-in, and
 * the session is reused from then on" tells them where to click.
 */

/**
 * Why a browser-login session is unusable. Ordered roughly from
 * "a human can fix this in a minute" to "this needs new credentials".
 */
export type BrowserBlockReason =
  /** Cookies aged out or the site invalidated them. A fresh login may work. */
  | "session_expired"
  /** A captcha / "prove you're human" gate. Only a human can clear it. */
  | "captcha"
  /** The account has 2FA on and the site wants a code. */
  | "two_factor"
  /** "Unusual activity" — the site wants the account's email or phone. */
  | "verification_required"
  /** The site rejected the username/password outright. */
  | "bad_credentials"
  /** Too many attempts; the site is throttling us. */
  | "rate_limited"
  /** Chromium/Playwright is missing, or the site never loaded. */
  | "unavailable"
  /** Anything we could not place. */
  | "unknown";

export type BrowserSessionHealthState = "ok" | "blocked" | "unknown";

/**
 * Persisted inside the Connection's encrypted config under `sessionHealth`.
 * Every field is optional-friendly: a connection created before this
 * existed simply reads back as `unknown`, which behaves like "we have not
 * tried yet" rather than like a failure.
 */
export type BrowserSessionHealth = {
  state: BrowserSessionHealthState;
  reason?: BrowserBlockReason;
  /** The site-facing error we actually observed, trimmed. */
  message?: string;
  /** ms epoch of the observation. */
  observedAt?: number;
  /** Consecutive failures — drives the backoff and the "give up" copy. */
  failures?: number;
  /** ms epoch before which we refuse to drive another login. */
  retryAfter?: number;
  /** ms epoch of the last confirmed-good session. */
  lastOkAt?: number;
};

/** Health for a connection that has never been exercised. */
export const UNKNOWN_BROWSER_SESSION_HEALTH: BrowserSessionHealth = { state: "unknown" };

/**
 * Backoff between login attempts after a failure. A blocked login is not a
 * transient network blip — retrying it in a tight loop is what escalates a
 * soft challenge into a hard account block — so this climbs fast and then
 * sits at an hour, which is long enough that the operator gets a chance to
 * intervene before we knock again.
 */
const COOLDOWN_LADDER_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  60 * 60_000, // 1h
];

/**
 * Reasons no amount of waiting will clear: the site is asking a human a
 * question. We still stamp a cooldown (so a routine firing every minute
 * doesn't hammer the login page) but the remedy is a person, not patience.
 */
const HUMAN_ONLY_REASONS: ReadonlySet<BrowserBlockReason> = new Set([
  "captcha",
  "two_factor",
  "verification_required",
  "bad_credentials",
]);

/** True when only a human can clear this block. */
export function blockNeedsHuman(reason: BrowserBlockReason | undefined): boolean {
  return reason !== undefined && HUMAN_ONLY_REASONS.has(reason);
}

/**
 * A human signing in through the live browser session fixes everything
 * except wrong credentials — for those the operator has to correct the
 * stored password first.
 */
export function blockClearedByManualSignIn(reason: BrowserBlockReason | undefined): boolean {
  return reason !== undefined && reason !== "bad_credentials" && reason !== "unavailable";
}

export function cooldownForFailureCount(failures: number): number {
  if (failures <= 0) return COOLDOWN_LADDER_MS[0];
  const index = Math.min(failures - 1, COOLDOWN_LADDER_MS.length - 1);
  return COOLDOWN_LADDER_MS[index];
}

/**
 * Map a raw driver error onto a reason. The drivers throw prose (they
 * surface whatever the site said, which is genuinely the most useful thing
 * to show), so this reads that prose rather than inventing a parallel error
 * taxonomy each driver would have to remember to use.
 *
 * Order matters: the more specific patterns are tested first, because a
 * captcha message often also mentions "login".
 */
export function classifyBrowserBlock(error: unknown): {
  reason: BrowserBlockReason;
  message: string;
} {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = raw.trim().slice(0, 500);
  const text = message.toLowerCase();

  if (/playwright|chromium is not installed|executable doesn't exist|browser binary/.test(text)) {
    return { reason: "unavailable", message };
  }
  if (/\b2fa\b|two-factor|two factor|authentication code|verification code|one-time code/.test(text)) {
    return { reason: "two_factor", message };
  }
  if (/captcha|arkose|funcaptcha|prove you'?re human|are you a robot|challenge/.test(text)) {
    return { reason: "captcha", message };
  }
  if (/unusual activity|unusual login|confirm your (email|phone)|verify your identity|verification (value|email|phone)/.test(text)) {
    return { reason: "verification_required", message };
  }
  if (/wrong password|incorrect password|password (is |was )?(wrong|incorrect)|could not log you in|invalid credentials|credentials (may be|are) wrong/.test(text)) {
    return { reason: "bad_credentials", message };
  }
  if (/rate.?limit|too many (attempts|requests)|try again later|temporarily (blocked|locked)|429/.test(text)) {
    return { reason: "rate_limited", message };
  }
  if (/session (has )?expired|logged out|not logged in|sign(ed)? out/.test(text)) {
    return { reason: "session_expired", message };
  }
  if (/timed out|timeout|did not render|did not load|net::err|navigation failed/.test(text)) {
    // A login page that will not render its own username field is, in
    // practice, a soft block — the site is serving us an interstitial. Say
    // so honestly rather than calling it "unknown", but keep the observed
    // text so the operator can see what we actually got.
    return { reason: "captcha", message };
  }
  return { reason: "unknown", message };
}

/** Fold a failure into the health record, advancing the backoff. */
export function recordBrowserBlock(args: {
  previous: BrowserSessionHealth | undefined;
  error: unknown;
  now: number;
}): BrowserSessionHealth {
  const { reason, message } = classifyBrowserBlock(args.error);
  // Only count consecutive failures of the same kind toward the backoff — a
  // new failure mode is new information, not more of the same wall.
  const sameAsBefore = args.previous?.state === "blocked" && args.previous.reason === reason;
  const failures = (sameAsBefore ? (args.previous?.failures ?? 0) : 0) + 1;
  const next: BrowserSessionHealth = {
    state: "blocked",
    reason,
    message,
    observedAt: args.now,
    failures,
    retryAfter: args.now + cooldownForFailureCount(failures),
  };
  // Only carried when there is one — an explicit `lastOkAt: undefined` would
  // survive in memory but vanish through the JSON the config is stored as,
  // so the same record would not compare equal to itself across a reload.
  if (typeof args.previous?.lastOkAt === "number") next.lastOkAt = args.previous.lastOkAt;
  return next;
}

/** A confirmed-good session clears everything. */
export function recordBrowserSessionOk(now: number): BrowserSessionHealth {
  return { state: "ok", observedAt: now, failures: 0, lastOkAt: now };
}

export function isCoolingDown(health: BrowserSessionHealth | undefined, now: number): boolean {
  if (!health || health.state !== "blocked") return false;
  return typeof health.retryAfter === "number" && health.retryAfter > now;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.ceil(minutes / 60)}h`;
}

/**
 * What the operator should actually do, per reason. Written for the person
 * reading a red pill in Settings → Integrations, not for a log grepper.
 *
 * `siteName` keeps this provider-neutral — the next browser-login provider
 * gets the same copy for free.
 */
export function remedyForBlock(args: {
  reason: BrowserBlockReason;
  siteName: string;
  /** When true, the employee has Browser tools and can host the sign-in. */
  manualSignInAvailable?: boolean;
}): string {
  const { reason, siteName } = args;
  const handoff = args.manualSignInAvailable
    ? ` Ask the AI employee to open ${siteName}'s login page with its Browser tools, then use "Take over" in the live browser panel to finish the sign-in yourself — the signed-in session is picked up by this connection from then on.`
    : ` Turn on Browser access for an AI employee that holds this connection, then ask it to open ${siteName}'s login page and use "Take over" in the live browser panel to sign in once — the signed-in session is picked up by this connection from then on.`;

  switch (reason) {
    case "captcha":
      return `${siteName} is showing a captcha or an anti-automation interstitial instead of the login form. Genosyn does not solve captchas — a human has to clear it once.${handoff}`;
    case "two_factor":
      return `${siteName} is asking for a two-factor code, which a stored password cannot answer.${handoff} Alternatively, connect ${siteName} over its official API instead of browser login.`;
    case "verification_required":
      return `${siteName} is running an "unusual activity" check and wants the account's email or phone. Add a Verification value to the connection under Settings → Integrations, or clear the check once by hand.${handoff}`;
    case "bad_credentials":
      return `${siteName} rejected the stored username or password. Update the credentials under Settings → Integrations → this connection → Reconnect.`;
    case "rate_limited":
      return `${siteName} is throttling sign-ins from this account. Leave it alone for a while — Genosyn already backs off automatically — and avoid re-running the routine in the meantime.`;
    case "session_expired":
      return `The saved ${siteName} session expired. Genosyn will try to sign in again on the next call; if that keeps failing, sign in once by hand.${handoff}`;
    case "unavailable":
      return `The headless browser is not available in this deployment, so browser-login connections cannot run at all. Use an image that bundles Chromium and playwright-core, or connect ${siteName} over its official API.`;
    case "unknown":
    default:
      return `Genosyn could not classify the failure. Check the message above against ${siteName}'s current login page.${handoff}`;
  }
}

/**
 * The full operator-facing sentence for a blocked connection: what we saw,
 * plus what to do. Used verbatim as `statusMessage` on the Connection row
 * and as the tool error the AI employee reports back, so the human and the
 * employee are looking at exactly the same explanation — which is the
 * failure mode that started all this.
 */
export function describeBrowserBlock(args: {
  health: BrowserSessionHealth;
  siteName: string;
  now: number;
  manualSignInAvailable?: boolean;
}): string {
  const { health, siteName, now } = args;
  if (health.state !== "blocked") {
    return health.state === "ok"
      ? `${siteName} browser session is signed in.`
      : `${siteName} browser session has not been used yet.`;
  }
  const reason = health.reason ?? "unknown";
  const parts: string[] = [];
  parts.push(health.message?.trim() || `${siteName} blocked the browser sign-in.`);
  parts.push(
    remedyForBlock({
      reason,
      siteName,
      manualSignInAvailable: args.manualSignInAvailable,
    }),
  );
  if (typeof health.retryAfter === "number" && health.retryAfter > now) {
    parts.push(
      blockNeedsHuman(reason)
        ? `Genosyn will not retry the sign-in on its own for ${formatDuration(health.retryAfter - now)} — retrying only hardens the block.`
        : `Genosyn retries automatically in ${formatDuration(health.retryAfter - now)}.`,
    );
  }
  return parts.join(" ");
}

/** Read the health record off a provider config blob, tolerating junk. */
export function readSessionHealth(config: unknown): BrowserSessionHealth {
  const raw = (config as { sessionHealth?: unknown } | null | undefined)?.sessionHealth;
  if (!raw || typeof raw !== "object") return UNKNOWN_BROWSER_SESSION_HEALTH;
  const record = raw as Record<string, unknown>;
  const state = record.state;
  if (state !== "ok" && state !== "blocked" && state !== "unknown") {
    return UNKNOWN_BROWSER_SESSION_HEALTH;
  }
  const health: BrowserSessionHealth = { state };
  if (typeof record.reason === "string") {
    health.reason = record.reason as BrowserBlockReason;
  }
  if (typeof record.message === "string") health.message = record.message;
  if (typeof record.observedAt === "number") health.observedAt = record.observedAt;
  if (typeof record.failures === "number") health.failures = record.failures;
  if (typeof record.retryAfter === "number") health.retryAfter = record.retryAfter;
  if (typeof record.lastOkAt === "number") health.lastOkAt = record.lastOkAt;
  return health;
}
