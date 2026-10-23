/**
 * Real Chrome coverage for Admin → Backups, on the real App with
 * deterministic API fixtures. Run with `npm run test:backups-page`.
 *
 *   - The status summary answers "are we backed up?" first: when, where, the
 *     schedule, the last verification, and anything wrong, beside Back up now.
 *   - Test shows its result beside the destination it tested — a success and
 *     a failure with the destination's own reason — with the button busy while
 *     it runs, and the result staying put when the list reloads. This used to
 *     show nothing: a passing result was never rendered, and on a destination
 *     whose copies were failing the server's "still failing" note was dropped.
 *   - History says where every backup lives: this server, each destination,
 *     both, or "not recorded" for backups from before copies were recorded.
 *   - Back up now and Copy off-box answer at once and the page follows them.
 *   - Every section has its loading, empty and error state; everything else
 *     sits behind one closed Advanced disclosure that says what is inside.
 *   - It fits a phone and reads in dark mode.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type {
  BackupCopy,
  BackupDestination,
  BackupDestinationTest,
  BackupHistoryItem,
  BackupSchedule,
  BackupVerification,
} from "../client/lib/api";
import {
  gate,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  status,
  type ApiRoute,
  type AppView,
} from "./appFixture";

const app = await startApp("Admin → Backups");
const PATH = "/c/acme/admin/backup";
const DAY = 24;

// ─────────────────────────── fixtures ───────────────────────────

function destination(overrides: Partial<BackupDestination> = {}): BackupDestination {
  return {
    id: "synology",
    name: "Synology",
    kind: "smb",
    enabled: true,
    hint: "//nas.local/backups",
    path: null,
    host: "nas.local",
    port: 445,
    username: "backup",
    remoteDir: "",
    authMode: null,
    share: "backups",
    domain: "",
    encrypt: true,
    hasPassword: true,
    hasPrivateKey: false,
    configError: false,
    lastStatus: "ok",
    lastError: "",
    lastSyncedAt: hoursAgo(6),
    lastCheckedAt: null,
    lastAttemptAt: hoursAgo(6),
    failingSince: null,
    lastAlertedAt: null,
    createdAt: hoursAgo(60 * DAY),
    updatedAt: hoursAgo(60 * DAY),
    ...overrides,
  };
}

function copy(overrides: Partial<BackupCopy> = {}): BackupCopy {
  return {
    destinationId: "synology",
    status: "copied",
    error: "",
    startedAt: hoursAgo(6.1),
    copiedAt: hoursAgo(6),
    checkedAt: null,
    updatedAt: hoursAgo(6),
    ...overrides,
  };
}

function backup(overrides: Partial<BackupHistoryItem> = {}): BackupHistoryItem {
  return {
    id: "latest",
    filename: "backup-2026-10-09-030000.zip",
    sizeBytes: 1.2 * 1024 ** 3,
    kind: "scheduled",
    status: "completed",
    errorMessage: "",
    copiesTracked: true,
    createdAt: hoursAgo(6.2),
    completedAt: hoursAgo(6.15),
    onServer: true,
    inProgress: false,
    copies: [copy()],
    ...overrides,
  };
}

function schedule(overrides: Partial<BackupSchedule> = {}): BackupSchedule {
  return {
    enabled: true,
    frequency: "daily",
    hour: 3,
    dayOfWeek: 0,
    dayOfMonth: 1,
    cronExpr: "0 3 * * *",
    nextRunAt: hoursAgo(-18),
    timeZone: "UTC",
    lastRunAt: hoursAgo(6.15),
    retentionEnabled: true,
    retentionDays: 30,
    offBoxRetentionEnabled: false,
    offBoxRetentionDays: 90,
    updatedAt: hoursAgo(60 * DAY),
    ...overrides,
  };
}

function verification(problems: BackupVerification["areas"][number]["problems"] = []) {
  return {
    verifiedAt: hoursAgo(3),
    areas: [
      { id: "schedule", title: "Schedule", summary: "Backs up every day at 03:00.", problems: [] },
      { id: "server", title: "This server", summary: "12 archives on this server.", problems },
      { id: "synology", title: "Synology", summary: "12 backups there.", problems: [] },
    ],
  } satisfies BackupVerification;
}

type World = {
  history: BackupHistoryItem[];
  destinations: BackupDestination[];
  schedule: BackupSchedule;
  verification: BackupVerification | null;
};

function healthyWorld(): World {
  return {
    history: [
      backup(),
      backup({
        id: "yesterday",
        createdAt: hoursAgo(30),
        filename: "backup-2026-10-08-030000.zip",
      }),
    ],
    destinations: [destination()],
    schedule: schedule(),
    verification: verification(),
  };
}

/** The page's own reads, answered from `world`; `extra` routes win. */
function routes(world: World, extra: ApiRoute[] = []): ApiRoute[] {
  return [
    ...extra,
    ["GET", "/api/backups", () => world.history],
    ["GET", "/api/backups/schedule", () => world.schedule],
    ["GET", "/api/backup-destinations", () => world.destinations],
    ["GET", "/api/backups/verification", () => ({ verification: world.verification })],
  ];
}

async function openBackups(
  world: World,
  extra: ApiRoute[] = [],
  options: { width?: number; scheme?: "light" | "dark" } = {},
): Promise<AppView> {
  const view = await app.open({
    path: PATH,
    me: { isMasterAdmin: true },
    routes: routes(world, extra),
    width: options.width,
    scheme: options.scheme,
  });
  await view.page.getByRole("heading", { level: 1, name: "Backups" }).waitFor();
  return view;
}

/** The status summary's value for one fact ("Where it is", …). */
function fact(page: Page, term: string): Locator {
  return page.locator("dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");
}

/**
 * Checks one summary fact once it reads `expected`. Each section loads, and
 * each save lands, in a render of its own, so a one-shot read can catch the
 * value before it changes; waiting first keeps the check about the words.
 */
async function expectFact(page: Page, term: string, expected: string | RegExp): Promise<void> {
  const value = fact(page, term);
  const pattern =
    typeof expected === "string"
      ? new RegExp("^" + expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$")
      : expected;
  await value
    .filter({ hasText: pattern })
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  const text = (await value.textContent()) ?? "";
  if (typeof expected === "string") assert.equal(text, expected, term);
  else assert.match(text, expected, term);
}

function destinationRow(page: Page, name: string): Locator {
  return page.getByRole("listitem", { name, exact: true });
}

/** One History row, found by the text only it has. */
function historyRow(page: Page, text: string | RegExp): Locator {
  return page
    .locator("li")
    .filter({ has: page.getByRole("list", { name: "Where this backup is" }) })
    .filter({ hasText: text });
}

async function chips(row: Locator): Promise<string[]> {
  return (
    await row
      .getByRole("list", { name: "Where this backup is" })
      .getByRole("listitem")
      .allTextContents()
  ).map((text) => text.trim());
}

function backupRequestsUnanswered(view: AppView): string[] {
  return view.unrouted.filter((request) => /backup/.test(request));
}

// ─────────────────────────── the summary ───────────────────────────

await app.check('The status summary answers "are we backed up?" at a glance', async () => {
  const view = await openBackups(healthyWorld());
  const { page } = view;

  await page.getByRole("heading", { level: 2, name: "Your data is backed up" }).waitFor();
  await expectFact(page, "Last good backup", /^Today at .+ \(6 hours ago\) · 1\.2 GB$/);
  await expectFact(page, "Where it is", "On this server and Synology.");
  await expectFact(page, "Automatic backups", /^Every day at .+ \(UTC\) · Next: Tomorrow at /);
  await expectFact(page, "Last verified", /: every backup in place$/);
  assert.equal(
    await page.getByRole("heading", { name: "Needs attention" }).count(),
    0,
    "nothing is wrong",
  );
  const backUp = page.getByRole("button", { name: "Back up now" });
  assert.equal(await backUp.isEnabled(), true);

  // The sections follow in plain words, and Advanced is one closed line.
  for (const heading of ["Automatic backups", "Off-box destinations", "History"]) {
    await page.getByRole("heading", { level: 2, name: heading }).waitFor();
  }
  const advanced = page.getByRole("heading", { level: 2, name: /^Advanced/ }).getByRole("button");
  assert.equal(await advanced.getAttribute("aria-expanded"), "false", "Advanced starts closed");
  await advanced
    .getByText("Keep 30 days here, everything off-box · verified 3 hours ago", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByText("How long backups are kept").count(),
    0,
    "its contents stay out of sight",
  );

  assert.deepEqual(await chips(historyRow(page, "On this server and Synology.").first()), [
    "On this server",
    "On Synology",
  ]);
  await noSidewaysScroll(page, "Admin → Backups");
  assert.deepEqual(backupRequestsUnanswered(view), []);
  await app.shot(page, "backups-page-desktop");
  await page.close();
});

await app.check("Problems lead the summary, each with its reason", async () => {
  const world = healthyWorld();
  world.destinations = [
    destination({
      lastStatus: "error",
      lastError: "The copy to nas.local didn't finish within 7.6 hours",
      failingSince: hoursAgo(10 * DAY),
      lastSyncedAt: hoursAgo(11 * DAY),
    }),
  ];
  world.history[0] = backup({
    copies: [
      copy({ status: "failed", error: "The copy to nas.local didn't finish within 7.6 hours" }),
    ],
  });
  world.schedule = schedule({ enabled: false, nextRunAt: null });
  const view = await openBackups(world);
  const { page } = view;

  await page.getByRole("heading", { level: 2, name: "Backups need attention" }).waitFor();
  const issues = page.getByRole("region", { name: "Needs attention" });
  await issues
    .getByText(
      /^Backups aren't reaching Synology since .+: The copy to nas\.local didn't finish within 7\.6 hours$/,
    )
    .waitFor();
  await issues.getByText(/^Automatic backups are off\./).waitFor();
  await expectFact(page, "Where it is", "Only on this server: the copy to Synology failed.");
  await expectFact(page, "Automatic backups", "Off");
  const row = destinationRow(page, "Synology");
  await row.getByText(/^Copies failing since /).waitFor();
  await row.getByText(/The last copy arrived 11 days ago\.$/).waitFor();
  await app.shot(page, "backups-page-problems");
  await page.close();
});

// ─────────────────────────── Test ───────────────────────────

await app.check(
  "Test shows a pass and a failure beside each destination, busy while it runs",
  async () => {
    const world = healthyWorld();
    world.destinations = [
      destination({
        id: "office",
        name: "Office NAS",
        kind: "local",
        hint: "/mnt/nas",
        lastSyncedAt: null,
        lastStatus: "unknown",
      }),
      destination({
        id: "broken",
        name: "Broken share",
        lastSyncedAt: null,
        lastStatus: "unknown",
      }),
    ];
    world.history = [backup({ copies: [] })];
    const passing = gate();
    const tested: string[] = [];
    let destinationReads = 0;
    const view = await openBackups(world, [
      [
        "GET",
        "/api/backup-destinations",
        () => {
          destinationReads += 1;
          return world.destinations;
        },
      ],
      [
        "POST",
        /^\/api\/backup-destinations\/([^/]+)\/test$/,
        async ({ match }) => {
          tested.push(match[1]);
          if (match[1] === "office") {
            await passing.opened;
            world.destinations[0] = {
              ...world.destinations[0],
              lastStatus: "ok",
              lastCheckedAt: hoursAgo(0),
            };
            return {
              ok: true,
              message: "Connected. Genosyn can write backups here.",
              stillFailing: false,
              testedAt: hoursAgo(0),
            } satisfies BackupDestinationTest;
          }
          world.destinations[1] = {
            ...world.destinations[1],
            lastStatus: "error",
            lastError: "Authentication failed — check the username, password, and domain",
            lastCheckedAt: hoursAgo(0),
          };
          return {
            ok: false,
            message: "Authentication failed — check the username, password, and domain",
            stillFailing: false,
            testedAt: hoursAgo(0),
          } satisfies BackupDestinationTest;
        },
      ],
    ]);
    const { page } = view;
    const office = destinationRow(page, "Office NAS");
    const broken = destinationRow(page, "Broken share");
    await office.getByText("Not tested yet").waitFor();

    // The pressed button is busy until the answer comes; the other stays usable.
    const officeTest = office.getByRole("button", { name: /Test/ });
    await view.click(officeTest);
    await view.waitForWrite((write) => write.path === "/api/backup-destinations/office/test");
    assert.equal(await officeTest.getAttribute("aria-busy"), "true");
    assert.equal(await officeTest.isDisabled(), true);
    await office.getByRole("button", { name: "Testing…" }).waitFor();
    assert.equal(await broken.getByRole("button", { name: "Test" }).isEnabled(), true);
    assert.equal(await office.getByRole("status").count(), 0, "no result before the test has run");

    passing.open();
    const success = office.getByRole("status");
    await success
      .getByText("Connected. Genosyn can write backups here.", { exact: true })
      .waitFor();
    assert.notEqual(await officeTest.getAttribute("aria-busy"), "true", "no longer busy");
    assert.equal(await officeTest.isEnabled(), true);
    // The list reloads after a test; the result stays where it was.
    const readsAfterPass = destinationReads;
    await office.getByText(/^Connected · nothing copied yet$/).waitFor();
    assert.ok(readsAfterPass >= 2, "the destinations were read again after the test");
    await success.waitFor();

    await view.click(broken.getByRole("button", { name: "Test" }));
    const failure = broken.getByRole("alert");
    await failure
      .getByText("Authentication failed — check the username, password, and domain", {
        exact: true,
      })
      .waitFor();
    await broken.getByText("Last test failed").waitFor();
    // Each result sits beside its own destination, and neither is a pop-up.
    assert.equal(await office.getByRole("alert").count(), 0);
    assert.equal(await broken.getByRole("status").count(), 0);
    assert.equal(await page.getByRole("dialog").count(), 0, "no modal hides the page");
    assert.equal(await success.isVisible(), true, "the first result is still there");
    assert.deepEqual(tested, ["office", "broken"]);
    assert.equal(view.clicks(), 2);
    await app.shot(page, "backups-page-test-results");
    await page.close();
  },
);

await app.check("A test that can't reach the server says why beside the destination", async () => {
  const world = healthyWorld();
  const view = await openBackups(world, [
    [
      "POST",
      "/api/backup-destinations/synology/test",
      () => status(404, { error: "This destination no longer exists." }),
    ],
  ]);
  const row = destinationRow(view.page, "Synology");
  await view.click(row.getByRole("button", { name: "Test" }));
  await row
    .getByRole("alert")
    .getByText("This destination no longer exists.", { exact: true })
    .waitFor();
  await view.page.close();
});

await app.check(
  "The owner's case: a passing test on a destination whose copies keep failing",
  async () => {
    const world = healthyWorld();
    world.destinations = [
      destination({
        lastStatus: "error",
        lastError: "The copy to nas.local didn't finish within 7.6 hours",
        failingSince: hoursAgo(12 * DAY),
        lastSyncedAt: hoursAgo(13 * DAY),
      }),
    ];
    world.history = [
      backup({
        copies: [
          copy({ status: "failed", error: "The copy to nas.local didn't finish within 7.6 hours" }),
        ],
      }),
    ];
    const view = await openBackups(world, [
      [
        "POST",
        "/api/backup-destinations/synology/test",
        () =>
          ({
            ok: true,
            message:
              "Connected, and a test file got through, but copies of real backups here are still failing. Copy the latest backup here to confirm it's fixed.",
            stillFailing: true,
            testedAt: hoursAgo(0),
          }) satisfies BackupDestinationTest,
      ],
      [
        "POST",
        "/api/backups/latest/deliver",
        ({ body }) => {
          assert.deepEqual(body, { destinationId: "synology" });
          const queued = copy({ status: "copying", copiedAt: null, startedAt: hoursAgo(0) });
          world.history = [backup({ copies: [queued] })];
          return { ok: true, alreadyRunning: false, copies: [queued] };
        },
      ],
    ]);
    const { page } = view;
    const row = destinationRow(page, "Synology");

    await view.click(row.getByRole("button", { name: "Test" }));
    await row
      .getByRole("status")
      .getByText(
        /^Connected, and a test file got through, but copies of real backups here are still failing\./,
      )
      .waitFor();
    // The fix is one press away.
    await view.click(row.getByRole("button", { name: "Copy the latest backup here now" }));
    await row
      .getByText("Copying the latest backup here. Follow it in History.", { exact: true })
      .waitFor();
    const latest = historyRow(page, /^Today at /).first();
    await latest.getByText("Copying to Synology…", { exact: true }).waitFor();
    await page.getByRole("heading", { level: 2, name: "Backups need attention" }).waitFor();

    // When the copy lands, the next look says so.
    world.history = [backup()];
    world.destinations = [destination({ lastSyncedAt: hoursAgo(0) })];
    await latest.getByText("On Synology", { exact: true }).waitFor({ timeout: 10_000 });
    await page.getByRole("heading", { level: 2, name: "Your data is backed up" }).waitFor();
    await page.close();
  },
);

// ─────────────────────────── Back up now ───────────────────────────

await app.check(
  "Back up now answers at once, follows the backup and its copies, then settles",
  async () => {
    const world = healthyWorld();
    world.history = [backup({ id: "yesterday", createdAt: hoursAgo(30) })];
    const fresh = backup({
      id: "fresh",
      filename: "backup-2026-10-09-090000.zip",
      createdAt: hoursAgo(0),
      completedAt: null,
      status: "running",
      inProgress: true,
      onServer: false,
      sizeBytes: 0,
      copies: [],
    });
    const view = await openBackups(world, [
      [
        "POST",
        "/api/backups",
        () => {
          world.history = [fresh, ...world.history];
          return { ...fresh, alreadyRunning: false };
        },
      ],
    ]);
    const { page } = view;

    await view.click(page.getByRole("button", { name: "Back up now" }));
    await page.getByRole("heading", { level: 2, name: "Backing up now…" }).waitFor();
    const busy = page.getByRole("button", { name: "Backing up…" });
    await busy.waitFor();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    await page
      .getByText("Started just now. It carries on if you leave this page.", { exact: true })
      .waitFor();
    await historyRow(page, "Being written on this server…").waitFor();

    // Written; now its copy is on its way.
    world.history = [
      {
        ...fresh,
        status: "completed",
        onServer: true,
        sizeBytes: 900 * 1024 ** 2,
        copies: [copy({ status: "copying", copiedAt: null })],
      },
      ...world.history.slice(1),
    ];
    await page
      .getByRole("heading", { level: 2, name: "Backed up, and copying it off-box now" })
      .waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "Copying off-box…" }).waitFor();

    // Done: back to plain.
    world.history = [
      { ...world.history[0], inProgress: false, copies: [copy()] },
      ...world.history.slice(1),
    ];
    await page
      .getByRole("heading", { level: 2, name: "Your data is backed up" })
      .waitFor({ timeout: 10_000 });
    const again = page.getByRole("button", { name: "Back up now" });
    assert.equal(await again.isEnabled(), true);
    assert.equal(
      await fact(page, "Last good backup")
        .textContent()
        .then((t) => /\(just now\)/.test(t ?? "")),
      true,
    );
    assert.equal(view.writes.filter((write) => write.path === "/api/backups").length, 1);
    await page.close();
  },
);

await app.check(
  "Back up now says so when a backup was already under way, and when it can't start",
  async () => {
    const world = healthyWorld();
    let refuse = false;
    const view = await openBackups(world, [
      [
        "POST",
        "/api/backups",
        () =>
          refuse
            ? status(409, { error: "A restore is in progress. Try again once it finishes." })
            : {
                ...backup({ inProgress: true, copies: [copy({ status: "copying" })] }),
                alreadyRunning: true,
              },
      ],
    ]);
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Back up now" }));
    await page
      .getByText("A backup was already under way, so Genosyn is finishing that one first.", {
        exact: true,
      })
      .waitFor();
    // Once that one is done, a refusal reads as its reason, beside the button.
    world.history = healthyWorld().history;
    await page.getByRole("button", { name: "Back up now" }).waitFor({ timeout: 10_000 });
    refuse = true;
    await view.click(page.getByRole("button", { name: "Back up now" }));
    await page
      .getByRole("alert")
      .getByText("A restore is in progress. Try again once it finishes.", { exact: true })
      .waitFor();
    await page.close();
  },
);

// ─────────────────────────── History ───────────────────────────

await app.check("History says where every backup lives", async () => {
  const world = healthyWorld();
  const office = destination({
    id: "office",
    name: "Office NAS",
    kind: "local",
    hint: "/mnt/office",
  });
  world.destinations = [destination(), office];
  world.history = [
    backup({ copies: [copy(), copy({ destinationId: "office" })] }),
    backup({
      id: "failed-copy",
      createdAt: hoursAgo(1 * DAY + 6),
      copies: [
        copy(),
        copy({
          destinationId: "office",
          status: "failed",
          error: "Access denied — the account can't write to that share",
        }),
      ],
    }),
    backup({
      id: "offbox-only",
      createdAt: hoursAgo(2 * DAY + 6),
      onServer: false,
      copies: [copy(), copy({ destinationId: "office" })],
    }),
    backup({ id: "legacy", createdAt: hoursAgo(3 * DAY + 6), copiesTracked: false, copies: [] }),
    backup({
      id: "failed",
      createdAt: hoursAgo(4 * DAY + 6),
      status: "failed",
      errorMessage: "Could not copy the database",
      onServer: false,
      copies: [],
    }),
    backup({
      id: "unfinished",
      createdAt: hoursAgo(5 * DAY + 6),
      status: "running",
      onServer: false,
      copies: [],
    }),
    backup({
      id: "uploaded",
      kind: "uploaded",
      filename: "uploaded-2026-10-01-120000.zip",
      createdAt: hoursAgo(8 * DAY),
      copies: [],
    }),
  ];
  const view = await openBackups(world, [
    [
      "POST",
      "/api/backups/failed-copy/deliver",
      ({ body }) => {
        assert.deepEqual(body, { destinationId: "office" });
        const queued = copy({ destinationId: "office", status: "pending", copiedAt: null });
        world.history[1] = { ...world.history[1], copies: [copy(), queued] };
        return { ok: true, alreadyRunning: false, copies: [queued] };
      },
    ],
  ]);
  const { page } = view;

  const both = historyRow(page, "On this server, Synology and Office NAS.");
  assert.deepEqual(await chips(both), ["On this server", "On Synology", "On Office NAS"]);

  // Synology has it, Office NAS doesn't: the sentence says where it is, the
  // chips and the line under them say what happened to each copy.
  const partly = historyRow(page, "Access denied — the account can't write to that share");
  assert.equal(await partly.getByText("On this server and Synology.", { exact: true }).count(), 1);
  assert.deepEqual(await chips(partly), [
    "On this server",
    "On Synology",
    "Not on Office NAS: the copy failed",
  ]);

  const offBoxOnly = historyRow(
    page,
    "Only on Synology and Office NAS: it is no longer on this server.",
  );
  assert.deepEqual(await chips(offBoxOnly), [
    "No longer on this server",
    "On Synology",
    "On Office NAS",
  ]);
  assert.equal(
    await offBoxOnly.getByRole("link", { name: "Download" }).count(),
    0,
    "nothing here to download",
  );

  const legacy = historyRow(page, "On this server. Where its off-box copies went wasn't recorded.");
  assert.deepEqual(await chips(legacy), [
    "On this server",
    "Synology: not recorded",
    "Office NAS: not recorded",
  ]);

  await historyRow(page, "Not saved: Could not copy the database").waitFor();
  await historyRow(
    page,
    "Genosyn stopped while writing it, so there is nothing to restore.",
  ).waitFor();

  // An uploaded backup is never copied off-box on its own.
  const uploaded = historyRow(page, "Uploaded");
  await uploaded.waitFor();
  assert.deepEqual(await chips(uploaded), [
    "On this server",
    "Not copied to Synology",
    "Not copied to Office NAS",
  ]);

  // Try again copies to that one destination only.
  await view.click(partly.getByRole("button", { name: "Try again" }));
  const retry = await view.waitForWrite(
    (write) => write.path === "/api/backups/failed-copy/deliver",
  );
  assert.deepEqual(retry.body, { destinationId: "office" });
  await historyRow(page, /Waiting to copy to Office NAS/)
    .getByText("Waiting to copy to Office NAS")
    .waitFor();
  assert.deepEqual(backupRequestsUnanswered(view), []);
  await app.shot(page, "backups-page-history");
  await page.close();
});

await app.check(
  "The owner's History, as it reads now: plain reasons, nothing left 'running'",
  async () => {
    // The rows from the owner's screenshot, after boot recovery settled the five
    // weeks-old "running" ones — which used to sit there at 0 B for good.
    const INTERRUPTED =
      "Genosyn stopped while writing this backup (a restart, an upgrade or a crash), so it didn't finish.";
    const world = healthyWorld();
    world.history = [
      backup({ id: "oct22", createdAt: hoursAgo(17), sizeBytes: 41.3 * 1024 ** 3, copies: [] }),
      backup({
        id: "enospc",
        createdAt: hoursAgo(23),
        status: "failed",
        errorMessage: "ENOSPC: no space left on device, write",
        sizeBytes: 0,
        onServer: false,
        copies: [],
      }),
      backup({
        id: "oct21",
        kind: "manual",
        createdAt: hoursAgo(39),
        sizeBytes: 47.2 * 1024 ** 3,
        copies: [copy({ status: "failed", error: "connect ECONNREFUSED 10.0.0.5:445" })],
      }),
      ...[24, 48, 51, 51.1, 51.2].map((days, i) =>
        backup({
          id: `zombie-${i}`,
          createdAt: hoursAgo(days * DAY),
          status: "failed",
          errorMessage: INTERRUPTED,
          sizeBytes: 0,
          onServer: false,
          copies: [],
        }),
      ),
    ];
    const view = await openBackups(world, [
      [
        "POST",
        "/api/backups/oct22/deliver",
        ({ body }) => {
          assert.deepEqual(body, {}, "every enabled destination");
          const queued = copy({ status: "pending", copiedAt: null });
          world.history[0] = { ...world.history[0], copies: [queued] };
          return { ok: true, alreadyRunning: false, copies: [queued] };
        },
      ],
    ]);
    const { page } = view;

    // Nothing reads as running, and no row is a bare filename.
    await historyRow(page, /^/).first().waitFor();
    assert.equal(await page.getByText("running", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/backup-2026-.*\.zip/).count(), 0, "no filenames as labels");
    assert.equal(
      await historyRow(page, `Not saved: ${INTERRUPTED}`).count(),
      5,
      "each stopped backup says why, plainly",
    );

    // ENOSPC is "the server ran out of disk space", with the raw error one click away.
    const full = historyRow(
      page,
      "Not saved: The server ran out of disk space. Free some space, or keep fewer backups here under Advanced.",
    );
    assert.deepEqual(await chips(full), ["Failed"]);
    const raw = full.getByText("ENOSPC: no space left on device, write", { exact: true });
    assert.equal(await raw.isVisible(), false, "the technical detail starts closed");
    await view.click(full.getByText("Technical detail", { exact: true }));
    await raw.waitFor();

    // A destination's raw error reads the same way.
    const refused = historyRow(
      page,
      "The destination refused the connection. Check its host and port.",
    );
    await refused
      .getByText("connect ECONNREFUSED 10.0.0.5:445", { exact: false })
      .waitFor({ state: "attached" });

    // Automatic and Manual say what they mean.
    const automatic = historyRow(page, "Only on this server.").first();
    assert.equal(
      await automatic.getByText("Automatic", { exact: true }).getAttribute("title"),
      "Taken on the schedule set under Automatic backups.",
    );
    assert.equal(
      await refused.getByText("Manual", { exact: true }).getAttribute("title"),
      "Taken when someone pressed Back up now.",
    );

    // Only on this server: the way to copy it off-box is right under that line.
    await view.click(automatic.getByRole("button", { name: "Copy off-box now" }));
    await view.waitForWrite((write) => write.path === "/api/backups/oct22/deliver");
    await page.getByText("Waiting to copy to Synology", { exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Copy off-box now" }).count(),
      0,
      "once it is on its way, the button goes",
    );
    await app.shot(page, "backups-page-owner-history");
    await page.close();
  },
);

await app.check("Restore, download, copy and delete stay one or two presses away", async () => {
  const world = healthyWorld();
  const deleted: string[] = [];
  const view = await openBackups(world, [
    [
      "DELETE",
      /^\/api\/backups\/([^/]+)$/,
      ({ match }) => {
        deleted.push(match[1]);
        world.history = world.history.filter((row) => row.id !== match[1]);
        return { ok: true };
      },
    ],
    [
      "POST",
      "/api/backups/yesterday/deliver",
      () => {
        const queued = copy({ status: "pending", copiedAt: null });
        world.history[1] = { ...world.history[1], copies: [queued] };
        return { ok: true, alreadyRunning: false, copies: [queued] };
      },
    ],
  ]);
  const { page } = view;
  const latest = historyRow(page, "On this server and Synology.").first();
  assert.equal(
    await latest.getByRole("link", { name: "Download" }).getAttribute("href"),
    "/api/backups/latest/download",
  );

  // Restore asks first, and Cancel changes nothing.
  await view.click(latest.getByRole("button", { name: "Restore" }));
  const confirm = page.getByRole("dialog");
  await confirm.getByText(/^Restore the backup from Today at /).waitFor();
  await confirm
    .getByText(/Genosyn backs up what is here now first, so this can be undone\./)
    .waitFor();
  await view.click(confirm.getByRole("button", { name: "Cancel" }));
  await confirm.waitFor({ state: "detached" });
  assert.equal(view.writes.filter((write) => write.path.endsWith("/restore")).length, 0);

  // Copy off-box now, from the row's menu.
  const older = historyRow(page, /On this server and Synology\./).nth(1);
  await view.click(older.getByRole("button", { name: /^More for the backup from / }));
  await view.click(page.getByRole("menuitem", { name: "Copy off-box now" }));
  await view.waitForWrite((write) => write.path === "/api/backups/yesterday/deliver");
  await page.getByText("Waiting to copy to Synology", { exact: true }).waitFor();

  // Delete asks, says the off-box copies stay, then the row goes.
  await view.click(latest.getByRole("button", { name: /^More for the backup from / }));
  await view.click(page.getByRole("menuitem", { name: "Delete backup" }));
  await page
    .getByRole("dialog")
    .getByText(
      /Its copies on off-box destinations stay there until off-box retention removes them\./,
    )
    .waitFor();
  await view.click(page.getByRole("dialog").getByRole("button", { name: "Delete backup" }));
  await view.waitForWrite((write) => write.method === "DELETE");
  assert.deepEqual(deleted, ["latest"]);
  await page.close();
});

await app.check("A refused restore says why on its own row", async () => {
  const world = healthyWorld();
  const view = await openBackups(world, [
    [
      "POST",
      "/api/backups/latest/restore",
      () =>
        status(409, {
          error: "A backup is being copied off-box right now. Restore once the copy finishes.",
        }),
    ],
  ]);
  const { page } = view;
  const latest = historyRow(page, "On this server and Synology.").first();
  await view.click(latest.getByRole("button", { name: "Restore" }));
  await view.click(page.getByRole("dialog").getByRole("button", { name: "Restore this backup" }));
  await latest
    .getByRole("alert")
    .getByText("A backup is being copied off-box right now. Restore once the copy finishes.", {
      exact: true,
    })
    .waitFor();
  await page.close();
});

// ─────────────────────────── schedule, destinations ───────────────────────────

await app.check("Automatic backups read and save in plain words", async () => {
  const world = healthyWorld();
  const view = await openBackups(world, [
    [
      "PUT",
      "/api/backups/schedule",
      ({ body }) => {
        world.schedule = {
          ...world.schedule,
          ...body,
          nextRunAt: body.enabled === false ? null : world.schedule.nextRunAt,
        } as BackupSchedule;
        return world.schedule;
      },
    ],
  ]);
  const { page } = view;
  const toggle = page.getByRole("switch", { name: "Back up automatically" });
  assert.equal(await toggle.getAttribute("aria-checked"), "true");

  await view.click(page.getByRole("combobox", { name: "How often" }));
  await view.click(page.getByRole("option", { name: "Every week" }));
  await view.click(page.getByRole("combobox", { name: "On", exact: true }));
  await view.click(page.getByRole("option", { name: "Monday" }));
  await page.getByText(/^Once saved: Every Monday at .+ \(UTC\)\.$/).waitFor();
  await page.getByText("Unsaved changes", { exact: true }).first().waitFor();
  await view.click(page.getByRole("button", { name: "Save", exact: true }).first());
  const saved = await view.waitForWrite((write) => write.path === "/api/backups/schedule");
  assert.equal(saved.body.frequency, "weekly");
  assert.equal(saved.body.dayOfWeek, 1);
  await page.getByText(/^Every Monday at .+ \(UTC\)\. Next: /).waitFor();

  await view.click(toggle);
  assert.equal(
    await page.getByRole("combobox", { name: "How often" }).count(),
    0,
    "off hides the details",
  );
  await view.click(page.getByRole("button", { name: "Save", exact: true }).first());
  await view.waitForWrite(
    (write) => write.path === "/api/backups/schedule" && write.body.enabled === false,
  );
  await expectFact(page, "Automatic backups", "Off");
  await page.getByText(/^Automatic backups are off\./).waitFor();
  await page.close();
});

await app.check("Adding a destination tests it straight away, and pausing it says so", async () => {
  const world = healthyWorld();
  const view = await openBackups(world, [
    [
      "POST",
      "/api/backup-destinations",
      ({ body }) => {
        const added = destination({
          id: "spare",
          name: String(body.name),
          kind: "local",
          path: String(body.path),
          hint: String(body.path),
          lastStatus: "unknown",
          lastSyncedAt: null,
          createdAt: hoursAgo(0),
        });
        world.destinations = [...world.destinations, added];
        return added;
      },
    ],
    [
      "POST",
      "/api/backup-destinations/spare/test",
      () => ({
        ok: true,
        message: "Connected. Genosyn can write backups here.",
        stillFailing: false,
        testedAt: hoursAgo(0),
      }),
    ],
    [
      "PUT",
      "/api/backup-destinations/spare",
      ({ body }) => {
        world.destinations = world.destinations.map((dest) =>
          dest.id === "spare" ? { ...dest, ...(body as Partial<BackupDestination>) } : dest,
        );
        return world.destinations.find((dest) => dest.id === "spare");
      },
    ],
  ]);
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Add destination" }));
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Name", { exact: true }).fill("Spare disk");
  await modal.getByLabel("Folder", { exact: true }).fill("/mnt/spare");
  await view.click(modal.getByRole("button", { name: "Add destination" }));
  const created = await view.waitForWrite((write) => write.path === "/api/backup-destinations");
  assert.deepEqual(created.body, { name: "Spare disk", path: "/mnt/spare", kind: "local" });
  const row = destinationRow(page, "Spare disk");
  await row.getByRole("status").getByText("Connected. Genosyn can write backups here.").waitFor();

  await view.click(row.getByRole("button", { name: "More for Spare disk" }));
  await view.click(page.getByRole("menuitem", { name: "Pause copies here" }));
  const paused = await view.waitForWrite(
    (write) => write.path === "/api/backup-destinations/spare",
  );
  assert.deepEqual(paused.body, { enabled: false });
  await row.getByText("Paused").waitFor();
  await row.getByText("New backups aren't copied here.").waitFor();
  await page.close();
});

await app.check("Removing a destination being copied to says why it can't, beside it", async () => {
  const world = healthyWorld();
  const view = await openBackups(world, [
    [
      "DELETE",
      "/api/backup-destinations/synology",
      () =>
        status(409, {
          error:
            "A backup is being copied to Synology right now. Remove it once that copy finishes.",
        }),
    ],
  ]);
  const { page } = view;
  const row = destinationRow(page, "Synology");
  await view.click(row.getByRole("button", { name: "More for Synology" }));
  await view.click(page.getByRole("menuitem", { name: "Remove destination" }));
  await page
    .getByRole("dialog")
    .getByText(/Backups already on it stay there/)
    .waitFor();
  await view.click(page.getByRole("dialog").getByRole("button", { name: "Remove destination" }));
  await row
    .getByRole("alert")
    .getByText(
      "A backup is being copied to Synology right now. Remove it once that copy finishes.",
      { exact: true },
    )
    .waitFor();
  await page.close();
});

// ─────────────────────────── empty, loading, error ───────────────────────────

await app.check("A fresh install: every section says what to do first", async () => {
  const world: World = {
    history: [],
    destinations: [],
    schedule: schedule({ enabled: false, nextRunAt: null, retentionEnabled: false }),
    verification: null,
  };
  const view = await openBackups(world);
  const { page } = view;
  await page.getByRole("heading", { level: 2, name: "Not backed up yet" }).waitFor();
  await expectFact(page, "Last good backup", "None yet");
  await expectFact(page, "Where it is", "Nowhere yet");
  await expectFact(page, "Last verified", "Not run yet");
  const issues = page.getByRole("region", { name: "Needs attention" });
  await issues.getByText(/^Backups are only on this server\./).waitFor();
  await issues.getByText(/^Automatic backups are off\./).waitFor();
  await page.getByRole("heading", { name: "No off-box destination yet" }).waitFor();
  await page.getByRole("heading", { name: "No backups yet" }).waitFor();
  await page
    .getByRole("heading", { level: 2, name: /^Advanced/ })
    .getByText("Keep everything here, everything off-box · not verified yet", { exact: true })
    .waitFor();
  await app.shot(page, "backups-page-empty");
  await page.close();
});

await app.check("Loading and failing sections each say so, and recover on Try again", async () => {
  const world = healthyWorld();
  const historyGate = gate();
  let failHistory = true;
  const view = await openBackups(world, [
    [
      "GET",
      "/api/backups",
      async () => {
        await historyGate.opened;
        if (failHistory) return status(503, { error: "HTTP 503" });
        return world.history;
      },
    ],
    [
      "GET",
      "/api/backups/verification",
      () => status(500, { error: "The disk could not be read." }),
    ],
  ]);
  const { page } = view;
  await page.getByRole("heading", { level: 2, name: "Checking your backups…" }).waitFor();
  // The sections that loaded are usable meanwhile.
  await destinationRow(page, "Synology").waitFor();

  historyGate.open();
  await page.getByRole("heading", { level: 2, name: "Couldn't check your backups" }).waitFor();
  assert.equal(
    await page.getByText("HTTP 503", { exact: true }).count(),
    2,
    "status and History each say so",
  );
  failHistory = false;
  await view.click(page.getByRole("button", { name: "Try again" }).first());
  await page.getByRole("heading", { level: 2, name: "Your data is backed up" }).waitFor();
  assert.equal(
    await fact(page, "Last verified").textContent(),
    "…",
    "what didn't load isn't made up",
  );

  const advanced = page.getByRole("heading", { level: 2, name: /^Advanced/ }).getByRole("button");
  await view.click(advanced);
  await page.getByText("The disk could not be read.", { exact: true }).waitFor();
  await page.close();
});

// ─────────────────────────── Advanced ───────────────────────────

await app.check("Advanced keeps retention, verification, uploads, emails and storage", async () => {
  const world = healthyWorld();
  world.verification = null;
  const verifyGate = gate();
  const view = await openBackups(world, [
    [
      "PUT",
      "/api/backups/schedule",
      ({ body }) => {
        world.schedule = { ...world.schedule, ...(body as Partial<BackupSchedule>) };
        return { ...world.schedule, prunedNow: 2 };
      },
    ],
    [
      "POST",
      "/api/backups/verification",
      async () => {
        await verifyGate.opened;
        world.verification = verification([
          {
            key: "gone:x",
            severity: "error",
            message: "backup-x.zip is in History but its file is gone from this server.",
          },
        ]);
        return { verification: world.verification };
      },
    ],
    [
      "POST",
      "/api/backups/upload",
      () => status(400, { error: "The uploaded file is not a complete zip archive." }),
    ],
  ]);
  const { page } = view;
  const advanced = page.getByRole("heading", { level: 2, name: /^Advanced/ }).getByRole("button");
  await advanced
    .getByText("Keep 30 days here, everything off-box · not verified yet", { exact: true })
    .waitFor();
  await view.click(advanced);
  assert.equal(await advanced.getAttribute("aria-expanded"), "true");
  for (const part of [
    "How long backups are kept",
    "Daily verification",
    "Restore a backup made elsewhere",
    "Failure emails",
    "Where backups are kept on this server",
  ]) {
    await page.getByRole("heading", { level: 3, name: part }).waitFor();
  }
  assert.equal(
    await page.getByRole("link", { name: "Admin → Email transport" }).getAttribute("href"),
    "/c/acme/admin/email",
  );

  // Retention: one save covers both places; what it deleted is said.
  await page.getByLabel("Days to keep backups on this server").fill("14");
  await page.getByLabel("Delete backups older than").nth(1).check();
  await view.click(page.getByRole("button", { name: "Save", exact: true }).nth(1));
  const saved = await view.waitForWrite(
    (write) => write.path === "/api/backups/schedule" && "retentionDays" in write.body,
  );
  assert.deepEqual(saved.body, {
    retentionEnabled: true,
    retentionDays: 14,
    offBoxRetentionEnabled: true,
    offBoxRetentionDays: 90,
  });
  await page
    .getByText("Saved. 2 old backups were deleted from this server.", { exact: true })
    .waitFor();
  await advanced.getByText(/^Keep 14 days here, 90 days off-box · /).waitFor();

  // Verify now is busy while it runs, then shows what it found.
  const verify = page.getByRole("button", { name: "Verify now" });
  await view.click(verify);
  await page.getByRole("button", { name: "Verifying…" }).waitFor();
  verifyGate.open();
  await page.getByText("1 problem found", { exact: true }).waitFor();
  await page
    .getByText("backup-x.zip is in History but its file is gone from this server.")
    .first()
    .waitFor();

  // An upload that isn't a backup says why, there.
  await page.getByLabel("Backup file to upload").setInputFiles({
    name: "notes.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("not a zip"),
  });
  await page
    .getByText("The uploaded file is not a complete zip archive.", { exact: true })
    .waitFor();
  await app.shot(page, "backups-page-advanced-open");
  await page.close();
});

// ─────────────────────────── phone, dark ───────────────────────────

await app.check("On a phone nothing scrolls sideways, and dark mode reads", async () => {
  const world = healthyWorld();
  world.destinations = [
    destination({
      name: "Synology on the office network",
      hint: "//synology-ds920.office.example.internal/genosyn-backups/production",
      lastStatus: "error",
      lastError:
        "The copy to synology-ds920.office.example.internal dropped part-way through the copy",
      failingSince: hoursAgo(3 * DAY),
    }),
  ];
  const view = await openBackups(world, [], { width: 390 });
  const { page } = view;
  await page.getByRole("heading", { level: 2, name: "Backups need attention" }).waitFor();
  await noSidewaysScroll(page, "Admin → Backups on a phone");
  const backUp = page.getByRole("button", { name: "Back up now" });
  const box = await backUp.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "Back up now fits");
  await app.shot(page, "backups-page-mobile");
  await page
    .getByRole("heading", { level: 2, name: /^Advanced/ })
    .getByRole("button")
    .click();
  await noSidewaysScroll(page, "Admin → Backups on a phone, Advanced open");
  await page.close();

  const dark = await openBackups(healthyWorld(), [], { scheme: "dark" });
  await dark.page.getByRole("heading", { level: 2, name: "Your data is backed up" }).waitFor();
  await app.shot(dark.page, "backups-page-dark");
  await dark.page.close();
});

await app.finish();
