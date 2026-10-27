import cron, { type ScheduledTask } from "node-cron";
import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BankFeed, type BankFeedKind } from "../db/entities/BankFeed.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { type CardSyncResult, syncCardFeed } from "./cardExpenses.js";
import {
  describeFeedSyncFailure,
  FEED_SYNC_ERROR_KINDS,
  FeedSyncError,
  type FeedSyncContext,
  type FeedSyncErrorKind,
  type FeedSyncFailure,
  NEEDS_A_PERSON,
} from "./feedSyncErrors.js";
import { markConnectionUnusable } from "./integrations.js";
import { autoMatchFeed, syncBankFeed } from "./reconcile.js";
import { emitResourceChange } from "./resourceEvents.js";
import { getBankingSettings } from "./runtimeSettings.js";
import { schedulerLeaseHeld, withSchedulerLease } from "./schedulerLeases.js";

/**
 * Keeps every connected bank account and card on Finance → Banking in step
 * with its provider, and remembers how each sync went.
 *
 * Until this existed an account synced only when someone opened it and
 * pressed Update now, so a Brex account added in July still said "Updated
 * 18 Jul" in October: nothing else ever asked Brex for its transactions.
 * Now a node-cron tick runs every minute, and each Brex cash account, Mercury
 * account, Wise balance, Brex or Ramp card, and Stripe payouts account that
 * is due — every `runtime.banking.syncIntervalMinutes` (Admin → Runtime →
 * Bank sync; 30 by default) — syncs exactly as Sync now does: new
 * transactions land in To review, and a bank account's deposits are matched
 * to the payments already recorded. A CSV account has nothing to ask and is
 * never touched.
 *
 * - **Catching up.** Each provider sync asks for what was posted since a week
 *   before the feed's last *successful* sync (`lastSyncAt`), however long ago
 *   that was, and walks every page of it. A server that was off for a month
 *   brings the whole month in on its first pass after boot.
 * - **One sync per account.** Calls for an account already syncing in this
 *   process share that sync's promise; across app instances each sync holds
 *   the account's scheduler lease, and the dispatch pass holds its own, so
 *   one replica dispatches and no account is ever synced twice at once.
 * - **Failures are kept, not thrown away.** A failed sync records what went
 *   wrong in plain words, with the provider's own (`feedSyncErrors.ts`), and
 *   the card says so. It then backs off: a busy or unreachable provider is
 *   tried again within minutes, a rejected token or a removed Connection
 *   after an hour and then less often — a dead credential presented every
 *   minute is how an account gets locked — and at once when the Connection is
 *   changed. One account failing never stops the others.
 * - **No Routine noise.** The status columns are written with targeted
 *   updates, which the live-sync subscriber does not see, and open Banking
 *   pages are told with `trigger: false`. A Routine subscribed to Banking
 *   still fires on what a sync brought in — new transactions and matches —
 *   but not on the bookkeeping of a sync that found nothing.
 */

export type FeedKind = "bank" | "card";

/** One bank account or card, by which table it is in. */
export type FeedRef = { kind: FeedKind; companyId: string; id: string };

/** Bank accounts Genosyn syncs from a provider; a `csv` account is imported by hand. */
export const AUTOMATIC_BANK_FEED_KINDS: readonly BankFeedKind[] = [
  "stripe_payouts",
  "brex_cash",
  "mercury_account",
  "wise_balance",
];

export type FeedSyncOutcome =
  | { status: "synced"; kind: "bank"; inserted: number; matched: number }
  | { status: "synced"; kind: "card"; inserted: number; posted: number; failed: number }
  | { status: "failed"; failure: FeedSyncFailure }
  /** Another app instance is syncing this account right now, or it is being changed. */
  | { status: "busy" };

/** The account isn't this company's, or no longer exists. */
export class FeedNotFoundError extends Error {
  constructor() {
    super("Feed not found");
    this.name = "FeedNotFoundError";
  }
}

/** The account is syncing or being changed elsewhere; try again in a moment. */
export class FeedBusyError extends Error {
  constructor() {
    super("This account is syncing right now. Try again in a moment.");
    this.name = "FeedBusyError";
  }
}

/** What actually talks to the providers — replaced by tests, never in production. */
export type BankingSyncDependencies = {
  syncBank: (feed: BankFeed) => Promise<number>;
  autoMatch: (feed: BankFeed) => Promise<number>;
  syncCard: (feed: CardFeed) => Promise<CardSyncResult>;
};

const DEFAULT_DEPENDENCIES: BankingSyncDependencies = {
  syncBank: (feed) => syncBankFeed(feed),
  autoMatch: (feed) => autoMatchFeed(feed),
  syncCard: (feed) => syncCardFeed(feed),
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A sync's lease, renewed while it runs (`withSchedulerLease`). Short, so an
 * account a crashed replica was syncing is picked up minutes later.
 */
const FEED_LEASE_TTL_MS = 5 * MINUTE_MS;
const TICK_LEASE_NAME = "banking-sync";
const TICK_LEASE_TTL_MS = 5 * MINUTE_MS;
/** Every minute. The interval is read on each tick, so a change needs no restart. */
const TICK_CRON = "* * * * *";

const leaseNameOf = (ref: FeedRef): string => `banking-sync:${ref.kind}:${ref.id}`;
const keyOf = (ref: FeedRef): string => `${ref.kind}:${ref.id}`;

/** Syncs running in this process, by account; a second call shares the first's promise. */
const inFlight = new Map<string, Promise<FeedSyncOutcome>>();
/** Accounts being removed or re-pointed here; a sync asked for meanwhile is busy. */
const changing = new Set<string>();

/** The sync-status columns, which `BankFeed` and `CardFeed` both carry. */
type SyncColumns = Pick<
  BankFeed,
  | "syncStartedAt"
  | "lastSyncAttemptAt"
  | "lastSyncError"
  | "lastSyncErrorDetail"
  | "lastSyncErrorKind"
  | "syncFailureCount"
  | "nextSyncAt"
>;

async function loadFeed(ref: FeedRef): Promise<BankFeed | CardFeed | null> {
  const where = { id: ref.id, companyId: ref.companyId };
  return ref.kind === "bank"
    ? AppDataSource.getRepository(BankFeed).findOneBy(where)
    : AppDataSource.getRepository(CardFeed).findOneBy(where);
}

/**
 * Write sync status with a targeted update: never a `save` of a copy read
 * earlier, which would put back whatever the sync itself changed meanwhile.
 * `startedAt`, when given, writes only if the mark is still that one.
 */
async function updateSyncColumns(
  ref: FeedRef,
  values: Partial<SyncColumns>,
  startedAt?: Date,
): Promise<number> {
  const where = {
    id: ref.id,
    companyId: ref.companyId,
    ...(startedAt ? { syncStartedAt: startedAt } : {}),
  };
  const result =
    ref.kind === "bank"
      ? await AppDataSource.getRepository(BankFeed).update(where, values)
      : await AppDataSource.getRepository(CardFeed).update(where, values);
  return result.affected ?? 0;
}

/** Tell open Banking pages to refetch, without starting any Routine event work. */
function announce(ref: FeedRef): void {
  emitResourceChange(ref.companyId, ref.kind === "bank" ? "reconcile" : "cardexpense", undefined, {
    trigger: false,
  });
}

/** Who to name in a failure, and what this account reads. */
export function feedSyncContext(kind: FeedKind, feedKind: string): FeedSyncContext {
  if (kind === "card") {
    return feedKind === "ramp_card"
      ? {
          provider: "Ramp",
          credential: "client ID and secret",
          holder: "this app",
          reads: "card transactions and payments",
        }
      : { provider: "Brex", credential: "token", reads: "card transactions" };
  }
  if (feedKind === "stripe_payouts") {
    return { provider: "Stripe", credential: "API key", reads: "payouts" };
  }
  if (feedKind === "mercury_account") {
    return { provider: "Mercury", credential: "API token", reads: "accounts and transactions" };
  }
  if (feedKind === "wise_balance") {
    return { provider: "Wise", credential: "API token", reads: "balance statements" };
  }
  return { provider: "Brex", credential: "token", reads: "cash accounts and transactions" };
}

/** Whether Genosyn syncs this account from a provider at all. */
export function isAutomaticFeed(kind: FeedKind, feed: BankFeed | CardFeed): boolean {
  if (feed.archivedAt) return false;
  if (kind === "card") return true;
  const bank = feed as BankFeed;
  return AUTOMATIC_BANK_FEED_KINDS.includes(bank.kind) && !!bank.connectionId;
}

/**
 * How long the background sync waits after a failure before trying again.
 * A busy or unreachable provider: five minutes, doubling, never longer than
 * six hours or the interval. A failure only a person can fix: an hour,
 * doubling, at most a day. Never sooner than the provider asked.
 */
export function retryDelayMs(
  kind: FeedSyncErrorKind,
  failures: number,
  intervalMs: number,
  retryAfterMs: number | null = null,
): number {
  const person = NEEDS_A_PERSON.has(kind);
  const base = person ? HOUR_MS : 5 * MINUTE_MS;
  const cap = person ? DAY_MS : Math.max(Math.min(intervalMs, DAY_MS), 6 * HOUR_MS);
  const doublings = Math.min(Math.max(failures - 1, 0), 16);
  return Math.max(Math.min(base * 2 ** doublings, cap), retryAfterMs ?? 0);
}

type SyncBookkeeping = Pick<
  BankFeed,
  | "lastSyncAt"
  | "lastSyncAttemptAt"
  | "lastSyncError"
  | "lastSyncErrorKind"
  | "syncFailureCount"
  | "nextSyncAt"
>;

function failing(feed: SyncBookkeeping): boolean {
  return feed.syncFailureCount > 0 || feed.lastSyncError !== "";
}

/** A stored kind the code no longer knows reads as unexpected, never as a crash. */
export function storedErrorKind(value: string): FeedSyncErrorKind {
  return (FEED_SYNC_ERROR_KINDS as readonly string[]).includes(value)
    ? (value as FeedSyncErrorKind)
    : "internal";
}

/**
 * Whether the background sync should sync this account now. A healthy one is
 * due once the interval has passed since its last successful sync (at once if
 * it never had one, or its clock is ahead of ours); a failing one when its
 * backoff has passed, or straight away once the Connection behind a failure
 * only a person could fix is connected again and was changed after the
 * failure — someone reconnected it. `connectionFixedAt` is when a connected
 * Connection last changed, null while it isn't connected: a failure that
 * marked the Connection expired must not read as a fix of itself.
 */
export function isFeedSyncDue(
  feed: SyncBookkeeping,
  now: Date,
  intervalMs: number,
  connectionFixedAt: Date | null = null,
): boolean {
  if (failing(feed)) {
    if (
      connectionFixedAt &&
      feed.lastSyncAttemptAt &&
      NEEDS_A_PERSON.has(storedErrorKind(feed.lastSyncErrorKind)) &&
      connectionFixedAt.getTime() > feed.lastSyncAttemptAt.getTime()
    ) {
      return true;
    }
    return !feed.nextSyncAt || feed.nextSyncAt.getTime() <= now.getTime();
  }
  if (!feed.lastSyncAt) return true;
  const since = now.getTime() - feed.lastSyncAt.getTime();
  return since < 0 || since >= intervalMs;
}

/** How an account's sync is doing, for the Banking card that shows it. */
export type FeedSyncStatus = {
  /**
   * `automatic`: Genosyn syncs it on a schedule. `manual`: a connected
   * account while the background sync is off at Admin → Runtime — Sync now
   * still works. `import`: a CSV account, brought up to date by importing.
   */
  mode: "automatic" | "manual" | "import";
  /** How often an automatic account syncs. */
  intervalMinutes: number;
  /** A sync is running now, here or on another instance. */
  syncing: boolean;
  startedAt: string | null;
  /** When the last attempt finished, whether or not it succeeded. */
  lastAttemptAt: string | null;
  /** When the last successful sync ran — the last import, for a CSV account. */
  lastSuccessAt: string | null;
  /** Attempts that have failed in a row. */
  failureCount: number;
  /** Why the last attempt failed; null when it succeeded. */
  error: { kind: FeedSyncErrorKind; message: string; detail: string } | null;
  /** When the background sync will next try on its own; null when it won't. */
  nextAttemptAt: string | null;
};

/** The sync status an account's row holds, as the Banking page reads it. */
export function feedSyncStatus(
  kind: FeedKind,
  feed: BankFeed | CardFeed,
  now = new Date(),
): FeedSyncStatus {
  const settings = getBankingSettings();
  const intervalMs = settings.syncIntervalMinutes * MINUTE_MS;
  const iso = (at: Date | null) => (at ? at.toISOString() : null);
  // A CSV account is imported; any other syncs from its provider, on a
  // schedule unless the background sync is off or the account can't be
  // reached that way (archived, or no Connection) — then by Sync now alone.
  const mode =
    kind === "bank" && (feed as BankFeed).kind === "csv"
      ? "import"
      : settings.syncEnabled && isAutomaticFeed(kind, feed)
        ? "automatic"
        : "manual";
  let nextAttemptAt: string | null = null;
  if (mode === "automatic") {
    const next = failing(feed)
      ? (feed.nextSyncAt ?? now)
      : feed.lastSyncAt
        ? new Date(feed.lastSyncAt.getTime() + intervalMs)
        : now;
    nextAttemptAt = new Date(Math.max(next.getTime(), now.getTime())).toISOString();
  }
  return {
    mode,
    intervalMinutes: settings.syncIntervalMinutes,
    syncing: !!feed.syncStartedAt,
    startedAt: iso(feed.syncStartedAt),
    lastAttemptAt: iso(feed.lastSyncAttemptAt),
    lastSuccessAt: iso(feed.lastSyncAt),
    failureCount: feed.syncFailureCount,
    error: feed.lastSyncError
      ? {
          kind: storedErrorKind(feed.lastSyncErrorKind),
          message: feed.lastSyncError,
          detail: feed.lastSyncErrorDetail,
        }
      : null,
    nextAttemptAt,
  };
}

// ───────────────────────────── one account ─────────────────────────────

export type SyncFeedOptions = {
  dependencies?: Partial<BankingSyncDependencies>;
};

/**
 * Sync one account now, the way Sync now and the background sync both do.
 * Resolves with how it went — a provider failure is an outcome, recorded on
 * the account, not an exception. Throws only before anything is recorded:
 * `FeedNotFoundError`, or a `FeedSyncError` for an account that has nothing
 * to sync (a CSV account, an archived one).
 */
export function syncFeed(ref: FeedRef, options: SyncFeedOptions = {}): Promise<FeedSyncOutcome> {
  const key = keyOf(ref);
  const running = inFlight.get(key);
  if (running) return running;
  if (changing.has(key)) return Promise.resolve({ status: "busy" });
  const promise: Promise<FeedSyncOutcome> = runFeedSync(ref, {
    ...DEFAULT_DEPENDENCIES,
    ...options.dependencies,
  }).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Whether this process is syncing the account right now. */
export function isFeedSyncing(ref: Pick<FeedRef, "kind" | "id">): boolean {
  return inFlight.has(`${ref.kind}:${ref.id}`);
}

async function runFeedSync(
  ref: FeedRef,
  dependencies: BankingSyncDependencies,
): Promise<FeedSyncOutcome> {
  const feed = await loadFeed(ref);
  if (!feed) throw new FeedNotFoundError();
  if (feed.archivedAt) throw new FeedSyncError("unsupported", "This account is archived");
  if (ref.kind === "bank" && !AUTOMATIC_BANK_FEED_KINDS.includes((feed as BankFeed).kind)) {
    throw new FeedSyncError("unsupported", "This feed type can only be imported via CSV");
  }
  const leased = await withSchedulerLease(leaseNameOf(ref), FEED_LEASE_TTL_MS, async () => ({
    outcome: await syncLeased(ref, dependencies),
  }));
  return leased?.outcome ?? { status: "busy" };
}

async function syncLeased(
  ref: FeedRef,
  dependencies: BankingSyncDependencies,
): Promise<FeedSyncOutcome> {
  // Read again under the lease: another instance may have just finished a
  // sync and moved the cursor on.
  const feed = await loadFeed(ref);
  if (!feed) throw new FeedNotFoundError();
  await updateSyncColumns(ref, { syncStartedAt: new Date() });
  announce(ref);
  try {
    let outcome: FeedSyncOutcome;
    if (ref.kind === "bank") {
      const bank = feed as BankFeed;
      const inserted = await dependencies.syncBank(bank);
      const matched = await dependencies.autoMatch(bank);
      outcome = { status: "synced", kind: "bank", inserted, matched };
    } else {
      outcome = { status: "synced", kind: "card", ...(await dependencies.syncCard(feed as CardFeed)) };
    }
    await updateSyncColumns(ref, {
      syncStartedAt: null,
      lastSyncAttemptAt: new Date(),
      lastSyncError: "",
      lastSyncErrorDetail: "",
      lastSyncErrorKind: "",
      syncFailureCount: 0,
      nextSyncAt: null,
    });
    return outcome;
  } catch (err) {
    const failure = describeFeedSyncFailure(
      err,
      feedSyncContext(ref.kind, (feed as BankFeed | CardFeed).kind),
    );
    if (ref.kind === "bank") {
      // Whatever came in before the failure still waits in To review; match
      // it now rather than on the next sync that works.
      await dependencies.autoMatch(feed as BankFeed).catch(() => 0);
    }
    if (failure.kind === "auth" && failure.connectionStatus && feed.connectionId) {
      await markCredentialDead(feed, failure);
    }
    const finishedAt = new Date();
    const failures = feed.syncFailureCount + 1;
    const intervalMs = getBankingSettings().syncIntervalMinutes * MINUTE_MS;
    await updateSyncColumns(ref, {
      syncStartedAt: null,
      lastSyncAttemptAt: finishedAt,
      lastSyncError: failure.message,
      lastSyncErrorDetail: failure.detail,
      lastSyncErrorKind: failure.kind,
      syncFailureCount: failures,
      nextSyncAt: new Date(
        finishedAt.getTime() +
          retryDelayMs(failure.kind, failures, intervalMs, failure.retryAfterMs),
      ),
    });
    return { status: "failed", failure };
  } finally {
    announce(ref);
  }
}

/**
 * A provider rejected the credential itself, so Settings → Integrations
 * should stop showing the Connection as connected — the same as when an AI
 * Employee's tool call is refused (`invokeConnectionTool`).
 */
async function markCredentialDead(feed: BankFeed | CardFeed, failure: FeedSyncFailure): Promise<void> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: feed.connectionId!,
    companyId: feed.companyId,
  });
  if (!connection || !failure.connectionStatus) return;
  await markConnectionUnusable({
    connection,
    status: failure.connectionStatus,
    message: `${failure.message}. Reconnect it to keep ${feed.name} syncing on Banking.`,
  });
}

/**
 * Run `work` — removing an account, pointing it at another Connection — once
 * no sync is writing to it, and keep new syncs off it until `work` is done.
 * A sync running in this process is waited for; one holding the account's
 * lease on another instance makes this a `FeedBusyError`.
 */
export async function whileFeedIdle<T>(ref: FeedRef, work: () => Promise<T>): Promise<T> {
  const key = keyOf(ref);
  if (changing.has(key)) throw new FeedBusyError();
  changing.add(key);
  try {
    await inFlight.get(key)?.catch(() => undefined);
    const leased = await withSchedulerLease(leaseNameOf(ref), FEED_LEASE_TTL_MS, async () => ({
      value: await work(),
    }));
    if (!leased) throw new FeedBusyError();
    return leased.value;
  } finally {
    changing.delete(key);
  }
}

// ──────────────────────── Sync now, from a request ────────────────────────

/** How long a Sync now request waits for its sync before answering that it is still running. */
const REQUEST_WAIT_MS = 20_000;
let requestWaitMs = REQUEST_WAIT_MS;

/** Shorten the wait for a test. `null` restores it. */
export function setSyncRequestWaitForTests(ms: number | null): void {
  requestWaitMs = ms ?? REQUEST_WAIT_MS;
}

/**
 * Sync an account for someone who pressed Sync now. Most syncs take a second
 * or two and answer with what they brought in; the first sync of a long
 * history can take minutes, which a proxy in front of the App would cut off.
 * So past twenty seconds this answers `syncing` and the sync carries on — the
 * account shows Syncing… until it is done.
 */
export async function syncFeedForRequest(
  ref: FeedRef,
): Promise<FeedSyncOutcome | { status: "syncing" }> {
  const sync = syncFeed(ref);
  let timer: NodeJS.Timeout | undefined;
  const stillRunning = new Promise<{ status: "syncing" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "syncing" }), requestWaitMs);
    timer.unref();
  });
  try {
    return await Promise.race([sync, stillRunning]);
  } finally {
    clearTimeout(timer);
    // The sync records its own outcome; nobody is left to hear a late throw.
    sync.catch(() => undefined);
  }
}

/**
 * How a Sync now request is answered. A sync that brought things in is a 200
 * with the counts it always had; one that failed a 400 carrying the card's
 * line, its kind and the provider's details; one that is still running a 202;
 * one another instance holds a 409.
 */
export function syncResponse(outcome: FeedSyncOutcome | { status: "syncing" }): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (outcome.status) {
    case "synced":
      return outcome.kind === "bank"
        ? { status: 200, body: { inserted: outcome.inserted, matched: outcome.matched } }
        : {
            status: 200,
            body: { inserted: outcome.inserted, posted: outcome.posted, failed: outcome.failed },
          };
    case "failed":
      return {
        status: 400,
        body: {
          error: outcome.failure.message,
          kind: outcome.failure.kind,
          detail: outcome.failure.detail,
        },
      };
    case "syncing":
      return { status: 202, body: { syncing: true } };
    case "busy":
      return { status: 409, body: { error: new FeedBusyError().message } };
  }
}

// ─────────────────────────── the background sync ───────────────────────────

/**
 * Clear "Syncing…" from accounts no sync is running for any more — the marks a
 * process that stopped mid-sync left behind. Each is cleared only if its mark
 * is still the one read, so a sync that has just started keeps its own.
 */
async function clearAbandonedSyncs(): Promise<number> {
  const select = { id: true, companyId: true, syncStartedAt: true } as const;
  const where = { syncStartedAt: Not(IsNull()) };
  const marked: Array<{ ref: FeedRef; startedAt: Date }> = [
    ...(await AppDataSource.getRepository(BankFeed).find({ where, select })).map((row) => ({
      ref: { kind: "bank" as const, companyId: row.companyId, id: row.id },
      startedAt: row.syncStartedAt!,
    })),
    ...(await AppDataSource.getRepository(CardFeed).find({ where, select })).map((row) => ({
      ref: { kind: "card" as const, companyId: row.companyId, id: row.id },
      startedAt: row.syncStartedAt!,
    })),
  ];
  let cleared = 0;
  for (const { ref, startedAt } of marked) {
    if (inFlight.has(keyOf(ref)) || (await schedulerLeaseHeld(leaseNameOf(ref)))) continue;
    if (await updateSyncColumns(ref, { syncStartedAt: null }, startedAt)) {
      cleared += 1;
      announce(ref);
    }
  }
  return cleared;
}

type DueFeed = { ref: FeedRef; feed: BankFeed | CardFeed };

/** Every connected account that is due, the most overdue first. */
export async function dueFeeds(now: Date, intervalMs: number): Promise<DueFeed[]> {
  const [banks, cards] = await Promise.all([
    AppDataSource.getRepository(BankFeed).find({
      where: {
        kind: In([...AUTOMATIC_BANK_FEED_KINDS]),
        archivedAt: IsNull(),
        connectionId: Not(IsNull()),
      },
    }),
    AppDataSource.getRepository(CardFeed).find({ where: { archivedAt: IsNull() } }),
  ]);
  const connectionIds = [
    ...new Set([...banks, ...cards].map((feed) => feed.connectionId).filter((id): id is string => !!id)),
  ];
  const connections = connectionIds.length
    ? await AppDataSource.getRepository(IntegrationConnection).find({
        where: { id: In(connectionIds) },
        select: { id: true, companyId: true, status: true, updatedAt: true },
      })
    : [];
  const changedAt = new Map(
    connections
      .filter((c) => c.status === "connected")
      .map((c) => [`${c.companyId}:${c.id}`, c.updatedAt]),
  );
  const all: DueFeed[] = [
    ...banks.map((feed) => ({ ref: { kind: "bank" as const, companyId: feed.companyId, id: feed.id }, feed })),
    ...cards.map((feed) => ({ ref: { kind: "card" as const, companyId: feed.companyId, id: feed.id }, feed })),
  ];
  // Never synced first, then whichever has waited longest since it last did.
  const waitedSince = (feed: BankFeed | CardFeed) =>
    feed.lastSyncAt ? feed.lastSyncAt.getTime() : Number.NEGATIVE_INFINITY;
  return all
    .filter(({ feed }) =>
      isFeedSyncDue(
        feed,
        now,
        intervalMs,
        changedAt.get(`${feed.companyId}:${feed.connectionId}`) ?? null,
      ),
    )
    .sort((a, b) => waitedSince(a.feed) - waitedSince(b.feed));
}

export type BackgroundPass = {
  /** Accounts that were due. */
  due: number;
  synced: number;
  failed: number;
  /** Already syncing here or elsewhere, removed meanwhile, or being changed. */
  skipped: number;
  /** "Syncing…" marks a stopped process left behind, cleared. */
  cleared: number;
};

/**
 * One pass of the background sync: clear abandoned marks, then sync every
 * account that is due, one at a time, each under its own lease. One account
 * failing — or throwing — never stops the rest.
 */
export async function syncDueFeeds(
  options: {
    now?: Date;
    dependencies?: Partial<BankingSyncDependencies>;
    assertLeaseHeld?: () => void;
  } = {},
): Promise<BackgroundPass> {
  const now = options.now ?? new Date();
  const assertLeaseHeld = options.assertLeaseHeld ?? (() => undefined);
  const pass: BackgroundPass = { due: 0, synced: 0, failed: 0, skipped: 0, cleared: 0 };
  pass.cleared = await clearAbandonedSyncs();
  const settings = getBankingSettings();
  if (!settings.syncEnabled) return pass;
  const due = await dueFeeds(now, settings.syncIntervalMinutes * MINUTE_MS);
  pass.due = due.length;
  for (const { ref } of due) {
    assertLeaseHeld();
    if (inFlight.has(keyOf(ref)) || changing.has(keyOf(ref))) {
      pass.skipped += 1;
      continue;
    }
    try {
      const outcome = await syncFeed(ref, { dependencies: options.dependencies });
      if (outcome.status === "synced") pass.synced += 1;
      else if (outcome.status === "failed") pass.failed += 1;
      else pass.skipped += 1;
    } catch (err) {
      if (err instanceof FeedNotFoundError || err instanceof FeedSyncError) {
        pass.skipped += 1;
        continue;
      }
      pass.failed += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[banking] sync of ${keyOf(ref)} failed outside its own bookkeeping:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return pass;
}

let task: ScheduledTask | null = null;
let ticking = false;

/** One tick: the pass, under the dispatch lease, never two at once in this process. */
export async function runBankingSyncTick(): Promise<BackgroundPass | null> {
  if (ticking) return null;
  ticking = true;
  try {
    return await withSchedulerLease(TICK_LEASE_NAME, TICK_LEASE_TTL_MS, (lease) =>
      syncDueFeeds({ assertLeaseHeld: lease.assertHeld }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[banking] background sync pass failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    ticking = false;
  }
}

/**
 * Start the background sync. The first tick is within a minute of boot, so a
 * server that was down catches every account up straight away.
 */
export function bootBankingSync(): void {
  if (task) return;
  // The callback hands the pass off and returns, so node-cron never sees a
  // long one as an overlap; `runBankingSyncTick` skips a tick that lands
  // while the last pass is still syncing.
  task = cron.schedule(
    TICK_CRON,
    () => {
      void runBankingSyncTick();
    },
    { name: TICK_LEASE_NAME, timezone: "UTC" },
  );
}

/**
 * Take the background sync down — a restore destroys the database under it.
 * `destroy()`, not `stop()`, so node-cron forgets the task.
 */
export function stopBankingSync(): void {
  if (!task) return;
  void task.destroy();
  task = null;
}
