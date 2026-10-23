import {
  formatMoney,
  type BankingAccount,
  type CardSyncResult,
  type Company,
  type FeedSyncErrorKind,
  type FeedSyncResponse,
} from "./api";

/**
 * What a Banking account card says about where its transactions come from and
 * how its sync is doing, worked out from what the server sends
 * (`server/services/bankingSync.ts`). Kept apart from the page so every line a
 * card or the All accounts card can show is pinned by a test.
 *
 * Nothing here guesses: an account the background sync should have reached by
 * now but hasn't says when it last did, in amber, rather than "Synced"; a
 * failure says what went wrong in the provider's terms, and offers the one
 * thing that fixes it when a person has to.
 */

/** How a line reads: fine, working, worth a look, wrong, or by the way. */
export type SyncTone = "ok" | "syncing" | "stale" | "error" | "muted";

/** Locale and time zone to format in; the browser's own when left out. */
export type FormatOptions = { locale?: string; timeZone?: string };

/** Who is looking, as far as what a card offers them goes. */
export type SyncViewer = {
  companySlug: string;
  /** Owners and admins manage Connections (Settings → Integrations). */
  role: Company["role"];
  /** Full finance access: Sync now, Choose a Connection, Import CSV. */
  canWrite: boolean;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

// ── What the account is ─────────────────────────────────────────────────

const PROVIDER_NAMES = { brex: "Brex", wise: "Wise", stripe: "Stripe" } as const;

/** A bank account brought up to date by importing CSV statements, not by a sync. */
export function isCsvAccount(account: BankingAccount): boolean {
  return account.kind === "bank" && account.feed.kind === "csv";
}

/** "Brex", "Wise", "Stripe" — or null for a CSV account. */
export function providerName(account: BankingAccount): string | null {
  return account.provider ? PROVIDER_NAMES[account.provider] : null;
}

/** What kind of account it is, in a word or two: "Business account", "Card", "USD balance". */
export function accountKindLabel(account: BankingAccount): string {
  if (account.kind === "card") return "Card";
  if (account.feed.kind === "brex_cash") return "Business account";
  if (account.feed.kind === "wise_balance") {
    return account.balance ? `${account.balance.currency} balance` : "Balance";
  }
  if (account.feed.kind === "stripe_payouts") return "Payouts";
  return "Bank account";
}

/** The line under the account's name: "Brex · Business account", "Bank account · CSV uploads". */
export function accountSubtitle(account: BankingAccount): string {
  const provider = providerName(account);
  return provider
    ? `${provider} · ${accountKindLabel(account)}`
    : `${accountKindLabel(account)} · CSV uploads`;
}

/** The balance the provider reported, or null when it reports none. */
export function formatBalance(account: BankingAccount): string | null {
  return account.balance ? formatMoney(account.balance.cents, account.balance.currency) : null;
}

// ── Times ────────────────────────────────────────────────────────────────

/** "14:05" or "2:05 PM", as the reader's locale writes a time. */
export function formatClock(iso: string, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  return at.toLocaleTimeString(opts.locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: opts.timeZone,
  });
}

/** "18 Jul", or "18 Jul 2025" in another year. */
export function formatShortDate(iso: string, now: Date, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  const year = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: opts.timeZone, year: "numeric" }).format(d);
  return at.toLocaleDateString(opts.locale, {
    day: "numeric",
    month: "short",
    year: year(at) === year(now) ? undefined : "numeric",
    timeZone: opts.timeZone,
  });
}

/**
 * How long ago, the way a status line says it: "just now", "4 min ago",
 * "3 hours ago", "2 days ago" — and past a week the date itself, "on 18 Jul",
 * which says more about a stale account than "3 months ago" does.
 */
export function syncAge(iso: string, now: Date, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  const elapsed = Math.max(0, now.getTime() - at.getTime());
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), "hour")} ago`;
  if (elapsed < 7 * DAY_MS) return `${plural(Math.floor(elapsed / DAY_MS), "day")} ago`;
  return `on ${formatShortDate(iso, now, opts)}`;
}

/** "every 30 minutes", "every hour", "every 6 hours", "every day". */
export function describeInterval(minutes: number): string {
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? "every day" : `every ${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "every hour" : `every ${hours} hours`;
  }
  return `every ${plural(minutes, "minute")}`;
}

/** "at 14:05" today, "on 24 Oct at 09:00" another day. */
export function formatWhenNext(iso: string, now: Date, opts: FormatOptions = {}): string {
  const at = parse(iso);
  if (!at) return "";
  const day = (d: Date) => formatShortDate(d.toISOString(), now, opts);
  return day(at) === day(now)
    ? `at ${formatClock(iso, opts)}`
    : `on ${day(at)} at ${formatClock(iso, opts)}`;
}

/**
 * When an automatic account counts as stale: the background sync should have
 * reached it several times over and hasn't. Three intervals, and never under
 * two hours, so a slow provider on one pass isn't called stale.
 */
export function staleAfterMs(intervalMinutes: number): number {
  return Math.max(3 * intervalMinutes * MINUTE_MS, 2 * HOUR_MS);
}

/**
 * An account that last synced fine longer ago than it should have: past
 * `staleAfterMs` for one the background sync keeps up, past a day for one it
 * doesn't (automatic sync is off on the server).
 */
export function isStale(account: BankingAccount, now: Date): boolean {
  const { sync } = account;
  if (sync.mode === "import" || sync.syncing || sync.error) return false;
  const last = parse(sync.lastSuccessAt);
  if (!last) return false;
  const limit = sync.mode === "manual" ? DAY_MS : staleAfterMs(sync.intervalMinutes);
  return now.getTime() - last.getTime() > limit;
}

// ── One account ──────────────────────────────────────────────────────────

/** What fixes a failed sync, when it needs a person. */
export type SyncFix =
  | { kind: "reconnect"; label: string; href: string }
  | { kind: "choose_connection"; label: string }
  /** The viewer can't fix it; this says who can. */
  | { kind: "ask"; label: string };

export type SyncLine = {
  tone: SyncTone;
  /** "Synced 4 min ago", "Syncing…", "Sync failed", "Not synced yet", "Imported 17 Jul". */
  label: string;
  /** Why a sync failed, in the provider's terms: "Brex rejected the token". */
  reason: string | null;
  /** The provider's own words behind the reason. */
  detail: string | null;
  /** The one thing that fixes it, when a person has to. */
  fix: SyncFix | null;
  /** A quieter line: when Genosyn tries again, or how often it syncs. */
  hint: string | null;
};

/**
 * Settings → Integrations' reconnect form for the Connection, from Finance's
 * own Integrations page — or null for someone who can't change Connections,
 * which only owners and admins can.
 */
export function reconnectHref(
  role: Company["role"],
  companySlug: string,
  connectionId: string,
): string | null {
  if (role !== "owner" && role !== "admin") return null;
  return `/c/${encodeURIComponent(companySlug)}/finance/integrations?reconnect=${encodeURIComponent(
    connectionId,
  )}`;
}

/** Failures the Connection's own credential is behind, which Reconnect fixes. */
const CREDENTIAL_KINDS: ReadonlySet<FeedSyncErrorKind> = new Set<FeedSyncErrorKind>([
  "auth",
  "permission",
  "credentials",
]);

/** Failures the next try may clear on its own. */
const TRANSIENT_KINDS: ReadonlySet<FeedSyncErrorKind> = new Set<FeedSyncErrorKind>([
  "rate_limited",
  "provider_unavailable",
  "provider_error",
  "bad_data",
  "internal",
]);

function fixFor(account: BankingAccount, kind: FeedSyncErrorKind, viewer: SyncViewer): SyncFix | null {
  const connection = account.connection;
  if (CREDENTIAL_KINDS.has(kind) && connection) {
    const href = reconnectHref(viewer.role, viewer.companySlug, connection.id);
    return href
      ? { kind: "reconnect", label: "Reconnect", href }
      : { kind: "ask", label: `Ask an owner or admin to reconnect ${connection.label}` };
  }
  if (kind === "connection_missing" || (CREDENTIAL_KINDS.has(kind) && !connection)) {
    return viewer.canWrite
      ? { kind: "choose_connection", label: "Choose a Connection" }
      : { kind: "ask", label: "Someone with full finance access can choose another Connection" };
  }
  return null;
}

function hintFor(
  account: BankingAccount,
  kind: FeedSyncErrorKind,
  now: Date,
  opts: FormatOptions,
): string | null {
  const { sync } = account;
  if (kind === "account_missing") return "If it was closed, remove it from Banking.";
  if (!TRANSIENT_KINDS.has(kind)) {
    // Reconnecting is noticed by the next pass; nothing to wait for.
    return sync.mode === "automatic" && CREDENTIAL_KINDS.has(kind)
      ? "It syncs again within a minute of being reconnected."
      : null;
  }
  if (sync.mode !== "automatic") return "Try Sync now again in a while.";
  const next = sync.nextAttemptAt;
  if (!next || Date.parse(next) <= now.getTime() + MINUTE_MS) {
    return "Genosyn tries again in a minute.";
  }
  return `Genosyn tries again ${formatWhenNext(next, now, opts)}.`;
}

/**
 * The sync line on an account's card. `syncingHere` is a Sync now this page
 * is waiting on, which shows before the server's own mark arrives.
 */
export function describeSync(
  account: BankingAccount,
  now: Date,
  viewer: SyncViewer,
  opts: FormatOptions & { syncingHere?: boolean } = {},
): SyncLine {
  const { sync } = account;
  const line = (tone: SyncTone, label: string, extra: Partial<SyncLine> = {}): SyncLine => ({
    tone,
    label,
    reason: null,
    detail: null,
    fix: null,
    hint: null,
    ...extra,
  });

  if (sync.syncing || opts.syncingHere) {
    return line("syncing", "Syncing…", {
      hint: sync.lastSuccessAt ? `Last synced ${syncAge(sync.lastSuccessAt, now, opts)}` : null,
    });
  }

  if (sync.mode === "import") {
    return sync.lastSuccessAt
      ? line("muted", `Imported ${syncAge(sync.lastSuccessAt, now, opts)}`)
      : line("muted", "Nothing imported yet", {
          hint: viewer.canWrite ? "Import a CSV from your bank." : null,
        });
  }

  if (sync.error) {
    return line("error", "Sync failed", {
      reason: sync.error.message,
      detail: sync.error.detail || null,
      fix: fixFor(account, sync.error.kind, viewer),
      hint: hintFor(account, sync.error.kind, now, opts),
    });
  }

  if (!sync.lastSuccessAt) {
    return line("muted", "Not synced yet", {
      hint:
        sync.mode === "automatic"
          ? "Its first sync starts within a minute."
          : "Automatic sync is off on this server — use Sync now.",
    });
  }

  return line(isStale(account, now) ? "stale" : "ok", `Synced ${syncAge(sync.lastSuccessAt, now, opts)}`, {
    hint:
      sync.mode === "manual"
        ? "Automatic sync is off on this server — use Sync now."
        : `Syncs ${describeInterval(sync.intervalMinutes)}`,
  });
}

// ── All accounts ─────────────────────────────────────────────────────────

export type SyncSummary = { tone: SyncTone; label: string };

/**
 * How the accounts are doing together, for the All accounts card — the worst
 * news first: one that can't sync, then one syncing now, then one gone stale,
 * then one that never synced, and only then "All synced", dated by the
 * account that synced longest ago, so the line never claims more than is true.
 */
export function summarizeSync(accounts: BankingAccount[], now: Date, opts: FormatOptions = {}): SyncSummary {
  const connected = accounts.filter((account) => account.sync.mode !== "import");
  if (connected.length === 0) {
    return { tone: "muted", label: accounts.length ? "Imported by hand" : "No accounts yet" };
  }
  const named = (list: BankingAccount[], many: string, one: (name: string) => string) =>
    list.length === 1 ? one(list[0].feed.name) : `${plural(list.length, "account")} ${many}`;

  const failing = connected.filter((account) => account.sync.error && !account.sync.syncing);
  if (failing.length) {
    return { tone: "error", label: named(failing, "can't sync", (name) => `${name} can't sync`) };
  }
  const syncing = connected.filter((account) => account.sync.syncing);
  if (syncing.length) {
    return {
      tone: "syncing",
      label: syncing.length === 1 ? `Syncing ${syncing[0].feed.name}…` : `Syncing ${plural(syncing.length, "account")}…`,
    };
  }
  const stale = connected.filter((account) => isStale(account, now));
  if (stale.length) {
    return {
      tone: "stale",
      label:
        stale.length === 1
          ? `${stale[0].feed.name} last synced ${syncAge(stale[0].sync.lastSuccessAt!, now, opts)}`
          : `${plural(stale.length, "account")} haven't synced lately`,
    };
  }
  const never = connected.filter((account) => !account.sync.lastSuccessAt);
  if (never.length) {
    return {
      tone: "muted",
      label: never.length === 1 ? `${never[0].feed.name} hasn't synced yet` : `${plural(never.length, "account")} haven't synced yet`,
    };
  }
  const oldest = connected
    .map((account) => account.sync.lastSuccessAt!)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  return {
    tone: "ok",
    label: `${connected.length === 1 ? "Synced" : "All synced"} ${syncAge(oldest, now, opts)}`,
  };
}

// ── Sync now ─────────────────────────────────────────────────────────────

/**
 * What a finished Sync now brought in, when that is worth saying — counts the
 * list doesn't show by itself. Null for a sync still running, which the card
 * already shows as Syncing….
 */
export function syncNotice(response: FeedSyncResponse): string | null {
  if ("syncing" in response) return null;
  const parts = [plural(response.inserted, "new transaction")];
  if ("matched" in response) {
    if (response.matched) parts.push(`${response.matched} matched to payments already recorded`);
  } else if ((response as CardSyncResult).failed) {
    parts.push(`${(response as CardSyncResult).failed} couldn't be added to the books`);
  }
  return parts.join(" · ");
}
