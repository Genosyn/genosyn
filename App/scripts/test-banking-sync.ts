/**
 * Real Chrome coverage for Finance → Banking's account cards and their sync
 * status, on the real App with deterministic API fixtures. Run with
 * `npm run test:banking-sync`.
 *
 *   - Each card says what the account is, where it comes from, its balance when
 *     the provider reports one, what waits for review, and how its sync is
 *     doing: "Synced 4 min ago", "Syncing…", or "Sync failed" with the reason
 *     and the one thing that fixes it — a Reconnect link to the Connection.
 *   - The All accounts card sums it up, worst news first.
 *   - Sync now shows `loading` on the pressed button and Syncing… on the card
 *     while it runs, then the account as the server reports it; a sync that
 *     fails is said on the card, never in a popup.
 *   - The open account's header shows the failure with the provider's details
 *     behind View details.
 *   - A Connection that was removed offers Choose a Connection, which points
 *     the account at another and syncs it straight away.
 *   - A read-only Member sees the status without the controls.
 *   - An account syncing when the page opens is followed until it finishes.
 *   - Loading, error and empty states; a phone; dark mode.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import type {
  Account,
  BankFeed,
  BankingAccount,
  BankTransaction,
  CardFeed,
  CardTransaction,
  FeedSyncStatus,
  IntegrationConnection,
  RuntimeSettingsSnapshot,
} from "../client/lib/api";
import { RUNTIME_DEFAULTS } from "../client/lib/runtimeSettingsSummary";
import {
  API,
  gate,
  hoursAgo,
  noSidewaysScroll,
  NOW,
  startApp,
  status,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Finance → Banking sync status");
const PATH = "/c/acme/finance/banking";
const MINUTE = 1 / 60;

// ─────────────────────────── fixtures ───────────────────────────

const LEDGER: Account[] = [
  ["acct-bank", "1100", "Bank", "asset"],
  ["acct-card", "2300", "Corporate Card Payable", "liability"],
  ["acct-ga", "6000", "General & Administrative", "expense"],
].map(([id, code, name, type]) => ({
  id,
  companyId: "company",
  code,
  name,
  type: type as Account["type"],
  parentId: null,
  isSystem: true,
  archivedAt: null,
  createdAt: hoursAgo(24 * 120),
  updatedAt: hoursAgo(24 * 120),
}));

function connection(id: string, provider: string, label: string): IntegrationConnection {
  return {
    id,
    companyId: "company",
    provider,
    label,
    authMode: "apikey",
    accountHint: "",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: hoursAgo(1),
    createdAt: hoursAgo(24 * 100),
    updatedAt: hoursAgo(24 * 100),
    scopeGroups: [],
    retired: null,
  };
}

const BREX = connection("conn-brex", "brex", "Brex (Ops)");
const BREX_SPARE = connection("conn-brex-2", "brex", "Brex (Finance team)");
const WISE = connection("conn-wise", "wise", "Wise business");

function sync(overrides: Partial<FeedSyncStatus> = {}): FeedSyncStatus {
  return {
    mode: "automatic",
    intervalMinutes: 30,
    syncing: false,
    startedAt: null,
    lastAttemptAt: hoursAgo(4 * MINUTE),
    lastSuccessAt: hoursAgo(4 * MINUTE),
    failureCount: 0,
    error: null,
    nextAttemptAt: hoursAgo(-26 * MINUTE),
    ...overrides,
  };
}

function bankFeed(overrides: Partial<BankFeed>): BankFeed {
  return {
    id: "feed-bank",
    companyId: "company",
    name: "Bank",
    kind: "brex_cash",
    connectionId: BREX.id,
    externalAccountId: "cash_1",
    accountId: "acct-bank",
    lastSyncAt: hoursAgo(4 * MINUTE),
    archivedAt: null,
    createdAt: hoursAgo(24 * 90),
    updatedAt: hoursAgo(1),
    ...overrides,
  };
}

function cardFeed(overrides: Partial<CardFeed>): CardFeed {
  return {
    id: "feed-card",
    companyId: "company",
    name: "Brex corporate card",
    kind: "brex_card",
    connectionId: BREX.id,
    liabilityAccountId: "acct-card",
    defaultExpenseAccountId: "acct-ga",
    paymentAccountId: "acct-bank",
    lastSyncAt: hoursAgo(4 * MINUTE),
    archivedAt: null,
    createdAt: hoursAgo(24 * 91),
    updatedAt: hoursAgo(1),
    ...overrides,
  };
}

function brexPrimary(overrides: Partial<BankingAccount> = {}): BankingAccount {
  return {
    kind: "bank",
    feed: bankFeed({ id: "feed-primary", name: "Brex Primary", createdAt: hoursAgo(24 * 92) }),
    toReview: 744,
    total: 1_310,
    provider: "brex",
    sync: sync(),
    connection: BREX,
    balance: { cents: 48_212_033, currency: "USD", at: hoursAgo(4 * MINUTE) },
    ...overrides,
  } as BankingAccount;
}

function brexCard(overrides: Partial<BankingAccount> = {}): BankingAccount {
  return {
    kind: "card",
    feed: cardFeed({}),
    toReview: 0,
    total: 412,
    provider: "brex",
    sync: sync({ syncing: true, startedAt: hoursAgo(0.2 * MINUTE) }),
    connection: BREX,
    balance: null,
    ...overrides,
  } as BankingAccount;
}

const WISE_DETAIL =
  "Wise rejected the API token. Copy it again, or create a new one in Wise under Your Account → Connect and manage apps → API tokens.";

function wiseUsd(overrides: Partial<BankingAccount> = {}): BankingAccount {
  return {
    kind: "bank",
    feed: bankFeed({
      id: "feed-wise",
      name: "Wise USD",
      kind: "wise_balance",
      connectionId: WISE.id,
      externalAccountId: "30000001:200001",
      createdAt: hoursAgo(24 * 60),
    }),
    toReview: 12,
    total: 96,
    provider: "wise",
    sync: sync({
      lastSuccessAt: hoursAgo(24 * 97),
      lastAttemptAt: hoursAgo(3 * MINUTE),
      failureCount: 3,
      error: { kind: "auth", message: "Wise rejected the API token", detail: WISE_DETAIL },
      nextAttemptAt: hoursAgo(-2),
    }),
    connection: WISE,
    balance: { cents: 1_234_567, currency: "USD", at: hoursAgo(24 * 97) },
    ...overrides,
  } as BankingAccount;
}

function checking(overrides: Partial<BankingAccount> = {}): BankingAccount {
  return {
    kind: "bank",
    feed: bankFeed({
      id: "feed-csv",
      name: "Business checking",
      kind: "csv",
      connectionId: null,
      externalAccountId: null,
      lastSyncAt: hoursAgo(24 * 3),
      createdAt: hoursAgo(24 * 30),
    }),
    toReview: 0,
    total: 58,
    provider: null,
    sync: sync({
      mode: "import",
      lastSuccessAt: hoursAgo(24 * 3),
      lastAttemptAt: null,
      nextAttemptAt: null,
    }),
    connection: null,
    balance: null,
    ...overrides,
  } as BankingAccount;
}

function bankTxn(id: string, feedId: string, cents: number, description: string, hours: number): BankTransaction {
  return {
    id,
    companyId: "company",
    feedId,
    externalId: id,
    date: hoursAgo(hours),
    amountCents: cents,
    description,
    reference: "",
    raw: "{}",
    matchedPaymentId: null,
    matchedLedgerEntryId: null,
    reconciledAt: null,
    reconciledById: null,
    createdAt: hoursAgo(hours),
    match: null,
  };
}

function cardTxn(id: string, cents: number, description: string, hours: number): CardTransaction {
  return {
    id,
    companyId: "company",
    feedId: "feed-card",
    externalId: id,
    cardId: null,
    postedAt: hoursAgo(hours),
    amountCents: cents,
    currency: "USD",
    description,
    providerType: "PURCHASE",
    accountingKind: "expense",
    expenseAccountId: "acct-ga",
    ledgerEntryId: `entry-${id}`,
    postingError: "",
    raw: "{}",
    reclassifiedAt: null,
    needsReview: true,
    createdAt: hoursAgo(hours),
    updatedAt: hoursAgo(hours),
  };
}

const BANK_TXNS = [
  bankTxn("txn-1", "feed-primary", 1_250_000, "ACME CORP WIRE INV-0042", 30),
  bankTxn("txn-2", "feed-primary", -4_210, "GITHUB, INC.", 52),
  bankTxn("txn-3", "feed-wise", -776, "Figma", 24 * 98),
];
const CARD_TXNS = [cardTxn("card-1", 18_900, "Delta Air Lines", 20)];

type World = {
  accounts: () => BankingAccount[];
  extra?: ApiRoute[];
};

/** The endpoints Banking reads, answered from `world`. */
function bankingRoutes(world: World): ApiRoute[] {
  return [
    ...(world.extra ?? []),
    ["GET", `${API}/banking/accounts`, () => world.accounts()],
    ["GET", `${API}/accounts`, () => LEDGER],
    [
      "GET",
      `${API}/finance-settings`,
      () => ({
        id: "settings",
        companyId: "company",
        homeCurrency: "USD",
        automaticExchangeRates: true,
        defaultFromBlock: "",
        defaultFooter: "",
        invoiceCcEmails: [],
        createdAt: hoursAgo(24 * 120),
        updatedAt: hoursAgo(24 * 120),
      }),
    ],
    [
      "GET",
      `${API}/bank-transactions`,
      ({ url }) => {
        const feed = url.searchParams.get("feedId");
        return BANK_TXNS.filter((txn) => !feed || txn.feedId === feed);
      },
    ],
    [
      "GET",
      `${API}/card-transactions`,
      ({ url }) => {
        const feed = url.searchParams.get("feedId");
        return CARD_TXNS.filter((txn) => !feed || txn.feedId === feed);
      },
    ],
    ["GET", `${API}/card-transactions/category-drift`, () => []],
    ["GET", `${API}/integrations/connections`, () => [BREX, BREX_SPARE, WISE]],
  ];
}

const card = (page: Page, feedId: string) => page.getByTestId(`banking-account-${feedId}`);

async function cardText(page: Page, feedId: string): Promise<string> {
  return ((await card(page, feedId).textContent()) ?? "").replace(/\s+/g, " ").trim();
}

/** Wait until the card for `feedId` says `text` somewhere in it. */
async function cardSays(page: Page, feedId: string, text: string | RegExp) {
  await card(page, feedId)
    .getByText(text instanceof RegExp ? text : text, { exact: typeof text === "string" })
    .first()
    .waitFor();
}

// ─────────────────────────── checks ───────────────────────────

await app.check("each card says what it is, its balance, what waits, and how its sync is doing", async () => {
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({ accounts: () => [brexPrimary(), brexCard(), wiseUsd(), checking()] }),
  });
  const { page } = view;
  await cardSays(page, "feed-primary", "Synced 4 min ago");

  const primary = await cardText(page, "feed-primary");
  assert.match(primary, /Brex Primary/);
  assert.match(primary, /Brex · Business account/);
  assert.match(primary, /\$482,120\.33/);
  assert.match(primary, /744 to review/);
  assert.match(primary, /Synced 4 min ago/);

  const cardLine = await cardText(page, "feed-card");
  assert.match(cardLine, /Brex · Card/);
  assert.match(cardLine, /412\s*transactions/, "no balance, so the card counts its transactions");
  assert.match(cardLine, /All reviewed/);
  assert.match(cardLine, /Syncing…/);
  assert.equal(
    await page.getByRole("button", { name: "Sync Brex corporate card now" }).isDisabled(),
    true,
    "a card already syncing can't be asked again",
  );

  const wise = await cardText(page, "feed-wise");
  assert.match(wise, /Wise · USD balance/);
  assert.match(wise, /Sync failed/);
  assert.match(wise, /Wise rejected the API token/);
  const reconnect = card(page, "feed-wise").getByRole("link", { name: "Reconnect" });
  assert.equal(
    await reconnect.getAttribute("href"),
    "/c/acme/finance/integrations?reconnect=conn-wise",
    "Reconnect opens the Connection's own reconnect form",
  );

  const csv = await cardText(page, "feed-csv");
  assert.match(csv, /Bank account · CSV uploads/);
  assert.match(csv, /Imported 3 days ago/);
  assert.equal(
    await card(page, "feed-csv").getByRole("button", { name: /Sync .* now/ }).count(),
    0,
    "a CSV account has nothing to sync",
  );
  await card(page, "feed-csv")
    .getByRole("button", { name: "Import a CSV into Business checking" })
    .waitFor();

  // The worst news first: one account can't sync.
  const summary = page.getByTestId("banking-sync-summary");
  assert.equal((await summary.textContent())?.trim(), "Wise USD can't sync");
  assert.match((await page.getByTestId("banking-account-all").textContent()) ?? "", /756\s*to review/);

  // No transaction list is lost under the strip.
  await page.getByText("ACME CORP WIRE INV-0042").waitFor();
  await noSidewaysScroll(page, "desktop");
  await app.shot(page, "banking-sync-desktop");
  assert.deepEqual(view.unrouted, []);
  await page.close();
});

await app.check("the All accounts card says when everything is in step", async () => {
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () => [
        brexPrimary(),
        brexCard({ sync: sync({ lastSuccessAt: hoursAgo(25 * MINUTE) }) }),
        checking(),
      ],
    }),
  });
  const { page } = view;
  const summary = page.getByTestId("banking-sync-summary");
  await summary.getByText("All synced 25 min ago", { exact: true }).waitFor();
  await page.close();

  // One that fell behind is named, in amber, with when it last synced.
  const stale = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () => [
        brexPrimary({ sync: sync({ lastSuccessAt: hoursAgo(24 * 97), lastAttemptAt: hoursAgo(24 * 97) }) }),
      ],
    }),
  });
  // Past a week the date says more than "3 months ago" — in the browser's own
  // way of writing one.
  await stale.page
    .getByTestId("banking-sync-summary")
    .getByText(/^Brex Primary last synced on (Jul 4|4 Jul)$/)
    .waitFor();
  await cardSays(stale.page, "feed-primary", /^Synced on (Jul 4|4 Jul)$/);
  const line = stale.page.getByTestId(`banking-account-feed-primary`).getByTestId("banking-sync-line");
  assert.match((await line.getAttribute("class")) ?? "", /amber/, "a stale account reads amber");
  await stale.page.close();
});

await app.check("Sync now shows it is working, then the account as the server has it", async () => {
  let synced = false;
  const reply = gate();
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () => [
        brexPrimary(
          synced
            ? { toReview: 747, sync: sync({ lastSuccessAt: NOW.toISOString(), lastAttemptAt: NOW.toISOString() }) }
            : { sync: sync({ lastSuccessAt: hoursAgo(28 * MINUTE) }) },
        ),
        checking(),
      ],
      extra: [
        [
          "POST",
          `${API}/bank-feeds/feed-primary/sync`,
          async () => {
            await reply.opened;
            synced = true;
            return { inserted: 3, matched: 1 };
          },
        ],
      ],
    }),
  });
  const { page } = view;
  await cardSays(page, "feed-primary", "Synced 28 min ago");
  const button = page.getByRole("button", { name: "Sync Brex Primary now" });
  await view.click(button);
  await cardSays(page, "feed-primary", "Syncing…");
  assert.equal(await button.getAttribute("aria-busy"), "true", "the pressed button is loading");
  assert.equal(await button.isDisabled(), true);
  await page
    .getByTestId("banking-sync-summary")
    .getByText("Syncing Brex Primary…", { exact: true })
    .waitFor();
  await app.shot(page, "banking-sync-pressed");

  reply.open();
  await cardSays(page, "feed-primary", "Synced just now");
  await page
    .getByText("Brex Primary: 3 new transactions · 1 matched to payments already recorded", {
      exact: true,
    })
    .waitFor();
  assert.notEqual(await button.getAttribute("aria-busy"), "true");
  assert.match(await cardText(page, "feed-primary"), /747 to review/);
  assert.equal(view.clicks(), 1);
  const write = await view.waitForWrite((w) => w.path.endsWith("/sync"));
  assert.equal(write.method, "POST");
  await page.close();
});

await app.check("a sync that fails says why on the card, never in a popup", async () => {
  let failed = false;
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () => [
        brexPrimary(
          failed
            ? {
                sync: sync({
                  lastAttemptAt: NOW.toISOString(),
                  failureCount: 1,
                  error: {
                    kind: "auth",
                    message: "Brex rejected the token",
                    detail: "Unauthorized · HTTP 401 · GET /v2/accounts/cash",
                  },
                  nextAttemptAt: hoursAgo(-1),
                }),
              }
            : {},
        ),
      ],
      extra: [
        [
          "POST",
          `${API}/bank-feeds/feed-primary/sync`,
          () => {
            failed = true;
            return status(400, {
              error: "Brex rejected the token",
              kind: "auth",
              detail: "Unauthorized · HTTP 401 · GET /v2/accounts/cash",
            });
          },
        ],
      ],
    }),
  });
  const { page } = view;
  await cardSays(page, "feed-primary", "Synced 4 min ago");
  await view.click(page.getByRole("button", { name: "Sync Brex Primary now" }));
  await card(page, "feed-primary").getByTestId("banking-sync-failure").waitFor();
  const text = await cardText(page, "feed-primary");
  assert.match(text, /Sync failed/);
  assert.match(text, /Brex rejected the token\s*Reconnect/);
  assert.equal(
    await card(page, "feed-primary").getByRole("link", { name: "Reconnect" }).getAttribute("href"),
    "/c/acme/finance/integrations?reconnect=conn-brex",
  );
  assert.equal(await page.getByRole("dialog").count(), 0, "no error popup");
  assert.equal(await page.getByRole("alertdialog").count(), 0, "no error popup");

  // Opening the account shows the whole story, the provider's words behind View details.
  await view.click(page.getByRole("button", { name: "Show Brex Primary" }));
  const banner = page.getByRole("alert").filter({ hasText: "Sync failed · Brex rejected the token." });
  await banner.waitFor();
  assert.match((await banner.textContent()) ?? "", /It syncs again within a minute of being reconnected\./);
  await banner.getByRole("button", { name: "View details" }).click();
  await banner.getByText("Unauthorized · HTTP 401 · GET /v2/accounts/cash").waitFor();
  await app.shot(page, "banking-sync-failed");
  await page.close();
});

await app.check("a removed Connection offers Choose a Connection, which syncs at once", async () => {
  let repointed = false;
  const syncs: string[] = [];
  const removed = (): BankingAccount =>
    brexCard({
      sync: sync({
        lastSuccessAt: hoursAgo(24 * 3),
        failureCount: 2,
        error: {
          kind: "connection_missing",
          message: "The Brex Connection this account used was removed",
          detail: "Brex Connection not found",
        },
        nextAttemptAt: hoursAgo(-1),
      }),
      connection: null,
      feed: cardFeed({ connectionId: "conn-gone" }),
    });
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () =>
        repointed
          ? [brexCard({ sync: sync(), feed: cardFeed({ connectionId: BREX_SPARE.id }), connection: BREX_SPARE })]
          : [removed()],
      extra: [
        [
          "PATCH",
          `${API}/card-feeds/feed-card`,
          ({ body }) => {
            assert.deepEqual(body, { connectionId: BREX.id });
            repointed = true;
            return cardFeed({ connectionId: BREX.id });
          },
        ],
        [
          "POST",
          `${API}/card-feeds/feed-card/sync`,
          ({ path }) => {
            syncs.push(path);
            return { inserted: 2, posted: 2, failed: 0 };
          },
        ],
      ],
    }),
  });
  const { page } = view;
  await cardSays(page, "feed-card", "The Brex Connection this account used was removed");
  await view.click(card(page, "feed-card").getByRole("button", { name: "Choose a Connection" }));
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Change the Connection for Brex corporate card").waitFor();
  const select = dialog.getByLabel("Brex Connection");
  assert.equal(await select.inputValue(), BREX.label, "the first Brex Connection is offered");
  await view.click(dialog.getByRole("button", { name: "Use this Connection" }));
  await dialog.waitFor({ state: "detached" });
  await page
    .getByText("Brex corporate card: 2 new transactions", { exact: true })
    .waitFor();
  assert.equal(syncs.length, 1, "the new Connection is tried straight away");
  await cardSays(page, "feed-card", "Synced 4 min ago");
  await page.close();
});

await app.check("a read-only Member sees how each sync is doing, without the controls", async () => {
  const view = await app.open({
    path: PATH,
    role: "member",
    company: { financeAccess: "read" },
    routes: bankingRoutes({ accounts: () => [brexPrimary(), wiseUsd()] }),
  });
  const { page } = view;
  await cardSays(page, "feed-wise", "Sync failed");
  assert.equal(await page.getByRole("button", { name: /Sync .* now/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Add account" }).count(), 0);
  assert.equal(await card(page, "feed-wise").getByRole("link", { name: "Reconnect" }).count(), 0);
  assert.match(
    await cardText(page, "feed-wise"),
    /Wise rejected the API token\s*Ask an owner or admin to reconnect Wise business\./,
  );
  await page.close();
});

await app.check("an account syncing when the page opens is followed until it finishes", async () => {
  let reads = 0;
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () => {
        reads += 1;
        // Syncing for the first two reads, then done.
        return [
          brexCard(
            reads <= 2
              ? {}
              : { toReview: 3, sync: sync({ lastSuccessAt: NOW.toISOString(), lastAttemptAt: NOW.toISOString() }) },
          ),
        ];
      },
    }),
  });
  const { page } = view;
  await cardSays(page, "feed-card", "Syncing…");
  await page.getByTestId("banking-sync-summary").getByText("Syncing Brex corporate card…").waitFor();
  await card(page, "feed-card").getByText("Synced just now", { exact: true }).waitFor({ timeout: 15_000 });
  assert.match(await cardText(page, "feed-card"), /3 to review/);
  await page.close();
});

await app.check("loading, a failed load, and no accounts yet each have their state", async () => {
  const hold = gate();
  let failing = true;
  const view = await app.open({
    path: PATH,
    routes: bankingRoutes({
      accounts: () => [],
      extra: [
        [
          "GET",
          `${API}/banking/accounts`,
          async () => {
            await hold.opened;
            if (failing) {
              failing = false;
              return status(500, { error: "The database is busy" });
            }
            return [];
          },
        ],
      ],
    }),
  });
  const { page } = view;
  await page.getByLabel("Loading your accounts").waitFor();
  await app.shot(page, "banking-sync-loading");
  hold.open();
  await page.getByText("The database is busy").waitFor();
  await view.click(page.getByRole("button", { name: "Try again" }));
  await page.getByText("Add your bank accounts and cards").waitFor();
  await app.shot(page, "banking-sync-empty");
  // Each starting point opens Add account on that kind.
  await view.click(page.getByRole("button", { name: /^Brex or Wise/ }));
  const form = page.getByRole("dialog");
  await form.getByText("Add an account").waitFor();
  assert.equal(await form.getByRole("radio", { name: "Brex business account" }).isChecked(), true);
  assert.equal(await form.getByLabel("Name").inputValue(), "Brex Cash");
  await page.close();
});

await app.check("on a phone the cards stack and nothing scrolls sideways", async () => {
  const view = await app.open({
    path: PATH,
    touch: true,
    routes: bankingRoutes({ accounts: () => [brexPrimary(), brexCard(), wiseUsd(), checking()] }),
  });
  const { page } = view;
  await cardSays(page, "feed-primary", "Synced 4 min ago");
  await noSidewaysScroll(page, "phone");
  const first = await card(page, "feed-primary").boundingBox();
  const second = await card(page, "feed-card").boundingBox();
  assert.ok(first && second, "both cards are laid out");
  assert.ok(second.y >= first.y + first.height, "cards stack on a phone");
  assert.ok(first.x >= 0 && first.x + first.width <= 390, "a card fits the phone");
  await app.shot(page, "banking-sync-phone");
  await page.close();
});

await app.check("Admin → Runtime → Bank sync sets how often accounts sync", async () => {
  const snapshot = structuredClone(RUNTIME_DEFAULTS) as RuntimeSettingsSnapshot;
  snapshot.overridden = {
    web: false,
    mail: false,
    oauth: false,
    meetings: false,
    browser: false,
    agent: false,
    containment: false,
    network: false,
    banking: false,
  };
  const view = await app.open({
    path: "/c/acme/admin/runtime",
    me: { isMasterAdmin: true },
    routes: [
      ["GET", "/api/admin/runtime-settings", () => snapshot],
      ["GET", "/api/admin/hosted-sign-in", () => ({ enabled: true, url: "https://connect.genosyn.com", apps: [] })],
      [
        "PUT",
        "/api/admin/runtime-settings/banking",
        ({ body }) => {
          snapshot.banking = body as RuntimeSettingsSnapshot["banking"];
          snapshot.overridden.banking = true;
          return snapshot;
        },
      ],
    ],
  });
  const { page } = view;
  const section = page.getByRole("heading", { level: 2, name: /^Bank sync/ }).getByRole("button");
  await section.getByText("Defaults", { exact: true }).waitFor();
  await view.click(section);
  const every = page.getByLabel("Sync every", { exact: true });
  assert.equal(await every.inputValue(), "30");
  await every.fill("60");
  await view.click(page.getByRole("button", { name: /Save changes/ }));
  const put = await view.waitForWrite((w) => w.path === "/api/admin/runtime-settings/banking");
  assert.deepEqual(put.body, { syncEnabled: true, syncIntervalMinutes: 60 });
  await section.getByText("1 customized", { exact: true }).waitFor();

  // Out of bounds is refused in the form, before anything is sent.
  await every.fill("2");
  assert.equal(await every.getAttribute("min"), "5");
  assert.equal(await every.getAttribute("max"), "1440");
  await view.click(page.getByRole("button", { name: /Save changes/ }));
  await page.waitForTimeout(300);
  assert.equal(view.writes.length, 1, "nothing more was sent");
  await page.close();
});

await app.check("dark mode keeps every state readable", async () => {
  const view = await app.open({
    path: `${PATH}?account=feed-wise`,
    scheme: "dark",
    routes: bankingRoutes({ accounts: () => [brexPrimary(), brexCard(), wiseUsd(), checking()] }),
  });
  const { page } = view;
  await cardSays(page, "feed-wise", "Sync failed");
  await page.getByRole("alert").filter({ hasText: "Sync failed · Wise rejected the API token." }).waitFor();
  await app.shot(page, "banking-sync-dark");
  await page.close();
});

await app.finish();
