import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BankFeed, BankingAccount, CardFeed, FeedSyncStatus } from "./api.js";
import {
  accountKindLabel,
  accountSubtitle,
  describeInterval,
  describeSync,
  formatBalance,
  formatClock,
  formatShortDate,
  formatWhenNext,
  isCsvAccount,
  isStale,
  providerName,
  reconnectHref,
  staleAfterMs,
  summarizeSync,
  syncAge,
  syncNotice,
  type FormatOptions,
  type SyncViewer,
} from "./bankingSync.js";

/** Formatting pinned to one locale and zone, so every sentence is exact. */
const GB: FormatOptions = { locale: "en-GB", timeZone: "UTC" };
/** Friday 23 October 2026, 10:00 UTC. */
const NOW = new Date("2026-10-23T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const OWNER: SyncViewer = { companySlug: "acme", role: "owner", canWrite: true };
const WRITER: SyncViewer = { companySlug: "acme", role: "member", canWrite: true };
const READER: SyncViewer = { companySlug: "acme", role: "member", canWrite: false };

function sync(overrides: Partial<FeedSyncStatus> = {}): FeedSyncStatus {
  return {
    mode: "automatic",
    intervalMinutes: 30,
    syncing: false,
    startedAt: null,
    lastAttemptAt: ago(4 * MINUTE),
    lastSuccessAt: ago(4 * MINUTE),
    failureCount: 0,
    error: null,
    nextAttemptAt: ago(-26 * MINUTE),
    ...overrides,
  };
}

function bankFeed(overrides: Partial<BankFeed> = {}): BankFeed {
  return {
    id: "feed-bank",
    companyId: "company",
    name: "Brex Primary",
    kind: "brex_cash",
    connectionId: "conn-brex",
    externalAccountId: "cash_1",
    accountId: "acct-bank",
    lastSyncAt: ago(4 * MINUTE),
    archivedAt: null,
    createdAt: ago(90 * DAY),
    updatedAt: ago(HOUR),
    ...overrides,
  };
}

function cardFeed(overrides: Partial<CardFeed> = {}): CardFeed {
  return {
    id: "feed-card",
    companyId: "company",
    name: "Brex corporate card",
    kind: "brex_card",
    connectionId: "conn-brex",
    liabilityAccountId: "acct-card",
    defaultExpenseAccountId: "acct-ga",
    paymentAccountId: "acct-bank",
    lastSyncAt: ago(4 * MINUTE),
    archivedAt: null,
    createdAt: ago(90 * DAY),
    updatedAt: ago(HOUR),
    ...overrides,
  };
}

const BREX = {
  id: "conn-brex",
  label: "Brex (Ops)",
  provider: "brex",
  status: "connected" as const,
  statusMessage: "",
};

function bank(overrides: Partial<BankingAccount> = {}, feed: Partial<BankFeed> = {}): BankingAccount {
  return {
    kind: "bank",
    feed: bankFeed(feed),
    toReview: 744,
    total: 1_310,
    provider: "brex",
    sync: sync(),
    connection: BREX,
    balance: { cents: 48_212_033, currency: "USD", at: ago(4 * MINUTE) },
    ...overrides,
  } as BankingAccount;
}

function card(overrides: Partial<BankingAccount> = {}, feed: Partial<CardFeed> = {}): BankingAccount {
  return {
    kind: "card",
    feed: cardFeed(feed),
    toReview: 0,
    total: 412,
    provider: "brex",
    sync: sync(),
    connection: BREX,
    balance: null,
    ...overrides,
  } as BankingAccount;
}

function csv(overrides: Partial<BankingAccount> = {}): BankingAccount {
  return bank(
    {
      provider: null,
      connection: null,
      balance: null,
      sync: sync({ mode: "import", lastSuccessAt: ago(3 * DAY), lastAttemptAt: null, nextAttemptAt: null }),
      ...overrides,
    },
    { id: "feed-csv", name: "Business checking", kind: "csv", connectionId: null, externalAccountId: null },
  );
}

function failing(kind: NonNullable<FeedSyncStatus["error"]>["kind"], message: string, extra: Partial<FeedSyncStatus> = {}) {
  return sync({
    failureCount: 1,
    lastAttemptAt: ago(2 * MINUTE),
    error: { kind, message, detail: `${message} · HTTP 401` },
    nextAttemptAt: ago(-HOUR),
    ...extra,
  });
}

describe("what the account is", () => {
  test("names the provider and the kind of account", () => {
    assert.equal(isCsvAccount(csv()), true);
    assert.equal(isCsvAccount(bank()), false);
    assert.equal(isCsvAccount(card()), false);
    assert.equal(providerName(bank()), "Brex");
    assert.equal(providerName(csv()), null);
    assert.equal(accountSubtitle(bank()), "Brex · Business account");
    assert.equal(accountSubtitle(card()), "Brex · Card");
    assert.equal(
      accountSubtitle(bank({ provider: "wise", balance: { cents: 1, currency: "USD", at: ago(0) } }, { kind: "wise_balance" })),
      "Wise · USD balance",
    );
    assert.equal(accountKindLabel(bank({ provider: "wise", balance: null }, { kind: "wise_balance" })), "Balance");
    assert.equal(accountSubtitle(bank({ provider: "stripe", balance: null }, { kind: "stripe_payouts" })), "Stripe · Payouts");
    assert.equal(accountSubtitle(csv()), "Bank account · CSV uploads");
  });

  test("shows a balance only when the provider reported one", () => {
    assert.equal(formatBalance(bank()), "$482,120.33");
    assert.equal(formatBalance(card()), null);
    assert.equal(
      formatBalance(bank({ balance: { cents: 1_234_567, currency: "EUR", at: ago(0) } })),
      "€12,345.67",
    );
  });
});

describe("times", () => {
  test("a status line's age, and past a week the date itself", () => {
    assert.equal(syncAge(ago(20_000), NOW, GB), "just now");
    assert.equal(syncAge(ago(4 * MINUTE), NOW, GB), "4 min ago");
    assert.equal(syncAge(ago(59 * MINUTE), NOW, GB), "59 min ago");
    assert.equal(syncAge(ago(HOUR), NOW, GB), "1 hour ago");
    assert.equal(syncAge(ago(5 * HOUR), NOW, GB), "5 hours ago");
    assert.equal(syncAge(ago(DAY), NOW, GB), "1 day ago");
    assert.equal(syncAge(ago(6 * DAY), NOW, GB), "6 days ago");
    assert.equal(syncAge("2026-07-18T10:01:00.000Z", NOW, GB), "on 18 Jul");
    assert.equal(syncAge("2025-12-01T00:00:00.000Z", NOW, GB), "on 1 Dec 2025");
    assert.equal(syncAge(ago(-HOUR), NOW, GB), "just now", "a clock a little ahead is now");
    assert.equal(syncAge("not a date", NOW, GB), "");
  });

  test("clock times and short dates in the reader's way", () => {
    assert.equal(formatClock("2026-10-23T14:05:00.000Z", GB), "14:05");
    assert.equal(formatClock("2026-10-23T14:05:00.000Z", { locale: "en-US", timeZone: "UTC" }), "02:05 PM");
    assert.equal(formatShortDate("2026-10-24T09:00:00.000Z", NOW, GB), "24 Oct");
    assert.equal(formatWhenNext("2026-10-23T14:05:00.000Z", NOW, GB), "at 14:05");
    assert.equal(formatWhenNext("2026-10-24T09:00:00.000Z", NOW, GB), "on 24 Oct at 09:00");
  });

  test("how often, in words", () => {
    assert.equal(describeInterval(30), "every 30 minutes");
    assert.equal(describeInterval(1), "every 1 minute");
    assert.equal(describeInterval(60), "every hour");
    assert.equal(describeInterval(360), "every 6 hours");
    assert.equal(describeInterval(1_440), "every day");
    assert.equal(describeInterval(90), "every 90 minutes");
  });

  test("stale is several missed passes, never under two hours", () => {
    assert.equal(staleAfterMs(30), 2 * HOUR);
    assert.equal(staleAfterMs(60), 3 * HOUR);
    assert.equal(isStale(bank({ sync: sync({ lastSuccessAt: ago(119 * MINUTE) }) }), NOW), false);
    assert.equal(isStale(bank({ sync: sync({ lastSuccessAt: ago(121 * MINUTE) }) }), NOW), true);
    assert.equal(isStale(bank({ sync: sync({ mode: "manual", lastSuccessAt: ago(20 * HOUR) }) }), NOW), false);
    assert.equal(isStale(bank({ sync: sync({ mode: "manual", lastSuccessAt: ago(25 * HOUR) }) }), NOW), true);
    // Syncing, failing, never synced and CSV accounts have lines of their own.
    assert.equal(isStale(bank({ sync: sync({ lastSuccessAt: ago(9 * DAY), syncing: true }) }), NOW), false);
    assert.equal(isStale(bank({ sync: failing("auth", "x", { lastSuccessAt: ago(9 * DAY) }) }), NOW), false);
    assert.equal(isStale(bank({ sync: sync({ lastSuccessAt: null }) }), NOW), false);
    assert.equal(isStale(csv({ sync: sync({ mode: "import", lastSuccessAt: ago(90 * DAY) }) }), NOW), false);
  });
});

describe("describeSync", () => {
  test("a healthy account says when it synced and how often it does", () => {
    assert.deepEqual(describeSync(bank(), NOW, OWNER, GB), {
      tone: "ok",
      label: "Synced 4 min ago",
      reason: null,
      detail: null,
      fix: null,
      hint: "Syncs every 30 minutes",
    });
  });

  test("an account the background sync hasn't reached in a while says so, in amber", () => {
    const line = describeSync(bank({ sync: sync({ lastSuccessAt: "2026-07-18T10:01:00.000Z" }) }), NOW, OWNER, GB);
    assert.equal(line.tone, "stale");
    assert.equal(line.label, "Synced on 18 Jul");
  });

  test("a sync running now — the server's, or a Sync now still answering", () => {
    assert.deepEqual(describeSync(card({ sync: sync({ syncing: true }) }), NOW, OWNER, GB), {
      tone: "syncing",
      label: "Syncing…",
      reason: null,
      detail: null,
      fix: null,
      hint: "Last synced 4 min ago",
    });
    assert.equal(describeSync(card(), NOW, OWNER, { ...GB, syncingHere: true }).label, "Syncing…");
    // Even a failing account shows the retry that is running.
    assert.equal(
      describeSync(bank({ sync: failing("auth", "Brex rejected the token", { syncing: true }) }), NOW, OWNER, GB).tone,
      "syncing",
    );
    assert.equal(
      describeSync(card({ sync: sync({ syncing: true, lastSuccessAt: null }) }), NOW, OWNER, GB).hint,
      null,
    );
  });

  test("a rejected token offers Reconnect to an owner, and says who can to everyone else", () => {
    const account = bank({ sync: failing("auth", "Brex rejected the token") });
    const owner = describeSync(account, NOW, OWNER, GB);
    assert.equal(owner.tone, "error");
    assert.equal(owner.label, "Sync failed");
    assert.equal(owner.reason, "Brex rejected the token");
    assert.equal(owner.detail, "Brex rejected the token · HTTP 401");
    assert.deepEqual(owner.fix, {
      kind: "reconnect",
      label: "Reconnect",
      href: "/c/acme/finance/integrations?reconnect=conn-brex",
    });
    assert.equal(owner.hint, "It syncs again within a minute of being reconnected.");
    assert.deepEqual(describeSync(account, NOW, { ...OWNER, role: "admin" }, GB).fix?.kind, "reconnect");
    assert.deepEqual(describeSync(account, NOW, WRITER, GB).fix, {
      kind: "ask",
      label: "Ask an owner or admin to reconnect Brex (Ops)",
    });
    for (const kind of ["permission", "credentials"] as const) {
      assert.equal(describeSync(bank({ sync: failing(kind, "x") }), NOW, OWNER, GB).fix?.kind, "reconnect");
    }
  });

  test("a removed Connection offers Choose a Connection to someone who can", () => {
    const account = card({
      connection: null,
      sync: failing("connection_missing", "The Brex Connection this account used was removed"),
    });
    assert.deepEqual(describeSync(account, NOW, WRITER, GB).fix, {
      kind: "choose_connection",
      label: "Choose a Connection",
    });
    assert.deepEqual(describeSync(account, NOW, READER, GB).fix, {
      kind: "ask",
      label: "Someone with full finance access can choose another Connection",
    });
    // A rejected token whose Connection has since gone is fixed the same way.
    assert.equal(
      describeSync(card({ connection: null, sync: failing("auth", "x") }), NOW, OWNER, GB).fix?.kind,
      "choose_connection",
    );
    assert.equal(describeSync(account, NOW, WRITER, GB).hint, null, "nothing to wait for");
  });

  test("a failure the next try may clear says when that is", () => {
    const busy = (nextAttemptAt: string) =>
      describeSync(bank({ sync: failing("rate_limited", "Brex asked Genosyn to slow down", { nextAttemptAt }) }), NOW, OWNER, GB);
    assert.equal(busy("2026-10-23T14:05:00.000Z").hint, "Genosyn tries again at 14:05.");
    assert.equal(busy("2026-10-24T09:00:00.000Z").hint, "Genosyn tries again on 24 Oct at 09:00.");
    assert.equal(busy(ago(-30_000)).hint, "Genosyn tries again in a minute.");
    assert.equal(busy(ago(MINUTE)).hint, "Genosyn tries again in a minute.", "an overdue retry is the next pass");
    assert.equal(busy("2026-10-23T14:05:00.000Z").fix, null, "nothing for a person to do");
    const manual = describeSync(
      bank({ sync: failing("provider_unavailable", "Brex didn't answer", { mode: "manual" }) }),
      NOW,
      OWNER,
      GB,
    );
    assert.equal(manual.hint, "Try Sync now again in a while.");
  });

  test("a closed account or an unsupported one says so without a fix", () => {
    const closed = describeSync(bank({ sync: failing("account_missing", "This Brex cash account is no longer on the Connection") }), NOW, OWNER, GB);
    assert.equal(closed.fix, null);
    assert.equal(closed.hint, "If it was closed, remove it from Banking.");
    const sca = describeSync(bank({ sync: failing("unsupported", "Wise holds this balance's statements for Strong Customer Authentication") }), NOW, OWNER, GB);
    assert.deepEqual([sca.fix, sca.hint], [null, null]);
  });

  test("an account that never synced says when it will", () => {
    assert.deepEqual(
      [describeSync(bank({ sync: sync({ lastSuccessAt: null, lastAttemptAt: null }) }), NOW, OWNER, GB)].map((l) => [l.tone, l.label, l.hint]),
      [["muted", "Not synced yet", "Its first sync starts within a minute."]],
    );
    const off = describeSync(bank({ sync: sync({ mode: "manual", lastSuccessAt: null }) }), NOW, OWNER, GB);
    assert.equal(off.hint, "Automatic sync is off on this server — use Sync now.");
  });

  test("with automatic sync off on the server, a synced account says to use Sync now", () => {
    const line = describeSync(bank({ sync: sync({ mode: "manual" }) }), NOW, OWNER, GB);
    assert.deepEqual([line.tone, line.label, line.hint], ["ok", "Synced 4 min ago", "Automatic sync is off on this server — use Sync now."]);
    assert.equal(describeSync(bank({ sync: sync({ mode: "manual", lastSuccessAt: ago(2 * DAY) }) }), NOW, OWNER, GB).tone, "stale");
  });

  test("a CSV account says when it was last imported", () => {
    assert.deepEqual([describeSync(csv(), NOW, OWNER, GB)].map((l) => [l.tone, l.label, l.hint]), [["muted", "Imported 3 days ago", null]]);
    const empty = csv({ sync: sync({ mode: "import", lastSuccessAt: null }) });
    assert.deepEqual([describeSync(empty, NOW, WRITER, GB)].map((l) => [l.label, l.hint]), [["Nothing imported yet", "Import a CSV from your bank."]]);
    assert.equal(describeSync(empty, NOW, READER, GB).hint, null);
  });
});

describe("reconnectHref", () => {
  test("only owners and admins, who manage Connections, get one", () => {
    assert.equal(reconnectHref("owner", "acme", "conn-1"), "/c/acme/finance/integrations?reconnect=conn-1");
    assert.equal(reconnectHref("admin", "a b", "c/1"), "/c/a%20b/finance/integrations?reconnect=c%2F1");
    assert.equal(reconnectHref("member", "acme", "conn-1"), null);
    assert.equal(reconnectHref(undefined, "acme", "conn-1"), null);
  });
});

describe("summarizeSync", () => {
  const name = (account: BankingAccount, feedName: string) =>
    ({ ...account, feed: { ...account.feed, name: feedName, id: feedName } }) as BankingAccount;

  test("everything in step is dated by the account that synced longest ago", () => {
    assert.deepEqual(
      summarizeSync([bank(), card({ sync: sync({ lastSuccessAt: ago(25 * MINUTE) }) }), csv()], NOW, GB),
      { tone: "ok", label: "All synced 25 min ago" },
    );
    assert.deepEqual(summarizeSync([bank(), csv()], NOW, GB), { tone: "ok", label: "Synced 4 min ago" });
  });

  test("the worst news first", () => {
    const broken = name(bank({ sync: failing("auth", "x") }), "Wise USD");
    const running = name(card({ sync: sync({ syncing: true }) }), "Brex card");
    const behind = name(bank({ sync: sync({ lastSuccessAt: "2026-07-18T10:01:00.000Z" }) }), "Brex Primary");
    const fresh = name(bank({ sync: sync({ lastSuccessAt: null }) }), "New account");
    assert.deepEqual(summarizeSync([running, behind, broken, fresh], NOW, GB), {
      tone: "error",
      label: "Wise USD can't sync",
    });
    assert.deepEqual(summarizeSync([running, behind, fresh], NOW, GB), {
      tone: "syncing",
      label: "Syncing Brex card…",
    });
    assert.deepEqual(summarizeSync([behind, fresh], NOW, GB), {
      tone: "stale",
      label: "Brex Primary last synced on 18 Jul",
    });
    assert.deepEqual(summarizeSync([fresh, bank()], NOW, GB), {
      tone: "muted",
      label: "New account hasn't synced yet",
    });
  });

  test("several at once are counted", () => {
    const broken = bank({ sync: failing("auth", "x") });
    assert.equal(summarizeSync([broken, card({ sync: failing("permission", "y") })], NOW, GB).label, "2 accounts can't sync");
    assert.equal(
      summarizeSync([bank({ sync: sync({ syncing: true }) }), card({ sync: sync({ syncing: true }) })], NOW, GB).label,
      "Syncing 2 accounts…",
    );
    const old = sync({ lastSuccessAt: ago(30 * DAY) });
    assert.equal(summarizeSync([bank({ sync: old }), card({ sync: old })], NOW, GB).label, "2 accounts haven't synced lately");
    const never = sync({ lastSuccessAt: null });
    assert.equal(summarizeSync([bank({ sync: never }), card({ sync: never })], NOW, GB).label, "2 accounts haven't synced yet");
    // A failing account whose retry is running is counted as syncing.
    assert.equal(summarizeSync([bank({ sync: failing("auth", "x", { syncing: true }) })], NOW, GB).tone, "syncing");
  });

  test("CSV accounts alone, or none at all", () => {
    assert.deepEqual(summarizeSync([csv()], NOW, GB), { tone: "muted", label: "Imported by hand" });
    assert.deepEqual(summarizeSync([], NOW, GB), { tone: "muted", label: "No accounts yet" });
  });
});

describe("syncNotice", () => {
  test("says what a finished Sync now brought in that the list doesn't show", () => {
    assert.equal(syncNotice({ inserted: 3, matched: 1 }), "3 new transactions · 1 matched to payments already recorded");
    assert.equal(syncNotice({ inserted: 1, matched: 0 }), "1 new transaction");
    assert.equal(syncNotice({ inserted: 0, matched: 0 }), "0 new transactions");
    assert.equal(syncNotice({ inserted: 2, posted: 1, failed: 1 }), "2 new transactions · 1 couldn't be added to the books");
    assert.equal(syncNotice({ inserted: 2, posted: 2, failed: 0 }), "2 new transactions");
    assert.equal(syncNotice({ syncing: true }), null, "the card already says Syncing…");
  });
});
