/**
 * Real Chrome coverage for the shorter Revenue and Customers flows, on the
 * real App: a Sequence or Signal opens (it never did — the pages read the
 * wrong route parameter) and creating one lands on it with the only AI
 * Employee, mailbox or connection already picked; Done on a deal or
 * partnership row in Follow-ups clears it in one click, moves focus to the
 * next row and announces it; New follow-up opens due the next working morning
 * and Enter creates it; the Deal page logs an activity with ⌘/Ctrl+Enter and
 * saves its Details with Enter; Deals remembers Board or List; a new Account
 * or Partnership opens on itself; Contacts and Accounts archive in one click
 * with Restore as the undo; the buying-committee remove button is reachable
 * on a phone and still confirms; and invoices, estimates and signature
 * requests started from a customer open with that customer, while a new or
 * edited customer lands on the customer. Each flow counts its clicks. Run
 * with `npm run test:clicks-revenue`.
 */
import assert from "node:assert/strict";
import type { Customer, Employee } from "../client/lib/api";
import type { MailAccount } from "../client/lib/mail";
import {
  dateTimeLocalToIso,
  defaultFollowUpDue,
  type FollowUpItem,
  type Partnership,
  type RevenueClassification,
} from "../client/lib/revenue";
import type { Deal, DealContactLink, DealStage } from "../client/pages/RevenueDeals";
import type { RevenueContact } from "../client/pages/RevenueContacts";
import type { HydratedSequence } from "../client/pages/RevenueSequences";
import type { Signal } from "../client/pages/RevenueSignals";
import {
  API,
  NOW,
  focused,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("Fewer clicks — Revenue and Customers");
const REV = `${API}/revenue`;

// ───────────────────────────── fixtures ─────────────────────────────

const ADA: Employee = {
  id: "ada",
  companyId: "company",
  name: "Ada Lovelace",
  slug: "ada",
  role: "SDR",
  avatarKey: null,
  model: null,
  modelCount: 0,
};

const MAILBOX: MailAccount = {
  id: "mailbox",
  connectionId: "conn",
  provider: "gmail",
  address: "sales@acme.example",
  senderName: "",
  status: "active",
  statusMessage: "",
  lastSyncAt: hoursAgo(0.1),
  syncState: "succeeded",
  syncAttemptId: null,
  syncStartedAt: hoursAgo(0.1),
  syncFinishedAt: hoursAgo(0.1),
  backfilledAt: hoursAgo(100),
  backfilledCount: 40,
  aiAnalysisEnabled: false,
  aiAnalysisEmployeeId: null,
  aiAnalysisModelId: null,
  createdAt: hoursAgo(500),
};

function sequence(id: string, name: string): HydratedSequence {
  return {
    id,
    companyId: "company",
    name,
    slug: id,
    description: "",
    status: "draft",
    mailAccountId: MAILBOX.id,
    employeeId: ADA.id,
    brief: "Nudge trials before they end.",
    autoSend: false,
    stopOnReply: true,
    dailyCap: 50,
    sendWindowJson: null,
    archivedAt: null,
    createdById: "viewer",
    createdByEmployeeId: null,
    createdAt: hoursAgo(24),
    updatedAt: hoursAgo(24),
    enrollmentCounts: {
      active: 0,
      paused: 0,
      completed: 0,
      stopped_replied: 0,
      stopped_bounced: 0,
      stopped_unsubscribed: 0,
      stopped_manual: 0,
      failed: 0,
    },
    activeCount: 0,
    totalEnrolled: 0,
    stepCount: 0,
  };
}

function signal(id: string, name: string): Signal {
  return {
    id,
    companyId: "company",
    name,
    slug: id,
    description: "",
    sourceKind: "sql",
    connectionId: "db",
    sql: "",
    cron: "0 * * * *",
    enabled: false,
    dedupeKeyColumn: "",
    emailColumn: "",
    domainColumn: "",
    amountColumn: "",
    actionKind: "activity",
    actionConfigJson: null,
    employeeId: null,
    lastRunAt: null,
    lastError: "",
    lastEventCount: 0,
    archivedAt: null,
    createdById: "viewer",
    createdAt: hoursAgo(24),
    updatedAt: hoursAgo(24),
  };
}

const STAGE: DealStage = {
  id: "stage-demo",
  companyId: "company",
  name: "Demo",
  slug: "demo",
  sortOrder: 1,
  probability: 40,
  kind: "open",
  color: "",
  description: "",
  archivedAt: null,
  createdAt: hoursAgo(900),
  updatedAt: hoursAgo(900),
};

function deal(changes: Partial<Deal> = {}): Deal {
  return {
    id: "deal-acme",
    companyId: "company",
    title: "Acme renewal",
    description: "",
    customerId: "acct-acme",
    primaryContactId: "contact-priya",
    stageId: STAGE.id,
    amountCents: 1_200_000,
    currency: "USD",
    probabilityOverride: null,
    expectedCloseDate: null,
    nextFollowUpAt: null,
    followUpReminderAt: null,
    status: "open",
    closedAt: null,
    lostReason: "",
    source: "",
    ownerId: null,
    ownerEmployeeId: null,
    nextStep: "",
    lastActivityAt: hoursAgo(30),
    archivedAt: null,
    createdById: "viewer",
    createdByEmployeeId: null,
    createdAt: hoursAgo(300),
    updatedAt: hoursAgo(30),
    stageName: STAGE.name,
    stageKind: "open",
    customerName: "Acme",
    contactName: "Priya Shah",
    weightedValueCents: 480_000,
    ...changes,
  };
}

function contact(changes: Partial<RevenueContact> = {}): RevenueContact {
  return {
    id: "contact-priya",
    companyId: "company",
    name: "Priya Shah",
    email: "priya@acme.example",
    phone: "",
    title: "Head of Ops",
    linkedinUrl: "",
    websiteUrl: "",
    customerId: "acct-acme",
    companyName: "Acme",
    lifecycleStage: "opportunity",
    ownerId: null,
    ownerEmployeeId: null,
    source: "",
    sourceDetail: "",
    score: 0,
    notes: "",
    doNotContact: false,
    unsubscribedAt: null,
    bouncedAt: null,
    lastActivityAt: hoursAgo(30),
    archivedAt: null,
    createdById: "viewer",
    createdByEmployeeId: null,
    createdAt: hoursAgo(400),
    updatedAt: hoursAgo(30),
    ...changes,
  };
}

function customer(id: string, name: string, changes: Partial<Customer> = {}): Customer {
  return {
    id,
    companyId: "company",
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    accountStatus: "customer",
    domain: `${name.toLowerCase()}.example`,
    websiteUrl: "",
    industry: "",
    employeeCount: 0,
    headquartersAddress: "",
    parentCompanyName: "",
    parentCompanyDomain: "",
    ownerId: null,
    ownerEmployeeId: null,
    email: "",
    phone: "",
    billingAddress: "",
    shippingAddress: "",
    taxNumber: "",
    currency: "USD",
    annualContractValueCents: 0,
    notes: "",
    archivedAt: null,
    createdById: "viewer",
    createdAt: hoursAgo(900),
    updatedAt: hoursAgo(900),
    contacts: [],
    ...changes,
  };
}

const ACME = customer("acct-acme", "Acme");
const GLOBEX = customer("acct-globex", "Globex", { currency: "EUR" });

function followUp(
  id: string,
  source: FollowUpItem["source"],
  title: string,
  changes: Partial<FollowUpItem> = {},
): FollowUpItem {
  return {
    id,
    source,
    title,
    dueAt: hoursAgo(3),
    reminderAt: null,
    status: "open",
    priority: "normal",
    overdue: true,
    dealId: source === "deal" ? id : null,
    partnershipId: source === "partnership" ? id : null,
    contactId: null,
    customerId: null,
    assignedUserId: null,
    assignedEmployeeId: null,
    assigneeName: null,
    recurrenceRule: null,
    ...changes,
  };
}

/** What every Revenue page around these flows asks for. */
const revenueBase: ApiRoute[] = [
  ["GET", `${API}/members`, () => []],
  ["GET", `${API}/employees`, () => [ADA]],
  ["GET", `${API}/mail/accounts`, () => ({ accounts: [MAILBOX] })],
  ["GET", `${API}/explore/connections`, () => []],
  ["GET", `${REV}/stages`, () => [STAGE]],
  ["GET", `${REV}/classifications`, () => ({ rows: [] as RevenueClassification[] })],
  ["GET", `${REV}/sequences`, () => []],
  ["GET", /\/revenue\/custom-values\//, () => ({ rows: [] })],
  ["GET", `${REV}/documents`, () => ({ rows: [] })],
  ["GET", `${REV}/contacts`, () => ({ rows: [contact()], total: 1 })],
  ["GET", `${REV}/accounts`, () => ({ rows: [], total: 0 })],
];

// ──────────────────────── Sequences and Signals ────────────────────────

await app.check("a Sequence opens from its link (it used to error on every visit)", async () => {
  const view = await app.open({
    path: "/c/acme/revenue/sequences/seq-trial",
    routes: [
      [
        "GET",
        `${REV}/sequences/seq-trial`,
        () => ({
          sequence: sequence("seq-trial", "Trial ending — nudge"),
          steps: [],
        }),
      ],
      ["GET", `${REV}/sequences/seq-trial/enrollments`, () => ({ rows: [], total: 0 })],
      ...revenueBase,
    ],
  });
  await view.page.getByRole("heading", { name: "Trial ending — nudge" }).waitFor();
  assert.ok(
    !view.unrouted.some((request) => request.includes("undefined")),
    `no request for an undefined id: ${view.unrouted.join(", ")}`,
  );
  await view.page.close();
});

await app.check(
  "New sequence: the only AI Employee and mailbox arrive picked; name, Enter, and it opens",
  async () => {
    let created: HydratedSequence | null = null;
    const view = await app.open({
      path: "/c/acme/revenue/sequences",
      routes: [
        [
          "POST",
          `${REV}/sequences`,
          ({ body }) => {
            created = sequence("seq-new", String(body.name));
            return created;
          },
        ],
        ["GET", `${REV}/sequences/seq-new`, () => ({ sequence: created, steps: [] })],
        ["GET", `${REV}/sequences/seq-new/enrollments`, () => ({ rows: [], total: 0 })],
        ...revenueBase,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "New sequence" }).first());
    const dialog = page.getByRole("dialog");
    await page.waitForFunction(() => {
      const values = [...document.querySelectorAll('[role="dialog"] select')].map(
        (select) => (select as HTMLSelectElement).value,
      );
      return values.includes("ada") && values.includes("mailbox");
    });
    const name = dialog.getByLabel("Name", { exact: true });
    await waitForFocus(name, "the name field has focus");
    await name.fill("Renewal check-in");
    await page.keyboard.press("Enter");
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${REV}/sequences`,
    );
    assert.equal(write.body.employeeId, "ada");
    assert.equal(write.body.mailAccountId, "mailbox");
    await view.landedOn("/c/acme/revenue/sequences/seq-new");
    await page.getByRole("heading", { name: "Renewal check-in" }).waitFor();
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check("New sequence: with two mailboxes, nothing is picked for you", async () => {
  const view = await app.open({
    path: "/c/acme/revenue/sequences",
    routes: [
      [
        "GET",
        `${API}/mail/accounts`,
        () => ({
          accounts: [MAILBOX, { ...MAILBOX, id: "mailbox-2", address: "ops@acme.example" }],
        }),
      ],
      ...revenueBase,
    ],
  });
  const { page } = view;
  await page.getByRole("button", { name: "New sequence" }).first().click();
  // The sole AI Employee still arrives picked; the mailbox waits for a choice.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"] select')].some(
      (select) => (select as HTMLSelectElement).value === "ada",
    ),
  );
  const values = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] select')].map(
      (select) => (select as HTMLSelectElement).value,
    ),
  );
  assert.ok(!values.includes("mailbox") && !values.includes("mailbox-2"), values.join(","));
  await page.close();
});

await app.check(
  "a Signal opens from its link, and New signal picks the only connection",
  async () => {
    let created: Signal | null = null;
    const view = await app.open({
      path: "/c/acme/revenue/signals",
      routes: [
        ["GET", `${REV}/signals`, () => []],
        [
          "GET",
          `${API}/explore/connections`,
          () => [
            {
              id: "db",
              provider: "postgres",
              label: "Product DB",
              accountHint: "",
              status: "connected",
            },
          ],
        ],
        [
          "POST",
          `${REV}/signals`,
          ({ body }) => {
            created = signal("sig-new", String(body.name));
            return created;
          },
        ],
        [
          "GET",
          `${REV}/signals/sig-new`,
          () => ({ signal: created, events: { rows: [], total: 0 } }),
        ],
        ...revenueBase,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "New signal" }).first());
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[role="dialog"] select')].some(
        (select) => (select as HTMLSelectElement).value === "db",
      ),
    );
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Trial ending in 3 days");
    await page.keyboard.press("Enter");
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${REV}/signals`,
    );
    assert.equal(write.body.connectionId, "db");
    await view.landedOn("/c/acme/revenue/signals/sig-new");
    await page.getByRole("heading", { name: "Trial ending in 3 days" }).waitFor();
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

// ───────────────────────────── Follow-ups ─────────────────────────────

function followUpRoutes(rows: FollowUpItem[]): ApiRoute[] {
  const live = [...rows];
  const drop = (source: string, id: string) => {
    const index = live.findIndex((row) => row.source === source && row.id === id);
    if (index >= 0) live.splice(index, 1);
  };
  return [
    ["GET", `${REV}/follow-ups`, () => ({ rows: live, nextCursor: null })],
    ["GET", `${REV}/follow-up-views`, () => []],
    [
      "PATCH",
      /\/revenue\/follow-ups\/([^/]+)$/,
      ({ match }) => {
        drop("task", match[1]);
        return { ok: true };
      },
    ],
    [
      "PATCH",
      /\/revenue\/deals\/([^/]+)$/,
      ({ match }) => {
        drop("deal", match[1]);
        return deal({ id: match[1] });
      },
    ],
    [
      "PATCH",
      /\/revenue\/partnerships\/([^/]+)$/,
      ({ match }) => {
        drop("partnership", match[1]);
        return { id: match[1] };
      },
    ],
    ["POST", `${REV}/follow-ups`, ({ body }) => ({ id: "task-new", ...body })],
    ...revenueBase,
  ];
}

const QUEUE = [
  followUp("deal-acme", "deal", "Follow up on Acme renewal"),
  followUp("p-northwind", "partnership", "Follow up with Northwind"),
  followUp("task-questionnaire", "task", "Send the security questionnaire", {
    customerId: "acct-acme",
  }),
];

await app.check(
  "Follow-ups: Done on a deal row clears it in one click; focus moves on",
  async () => {
    const view = await app.open({
      path: "/c/acme/revenue/follow-ups",
      routes: followUpRoutes(QUEUE),
    });
    const { page } = view;
    const done = page.getByRole("button", { name: "Complete Follow up on Acme renewal" });
    await view.click(done);
    const write = await view.waitForWrite(
      (w) => w.method === "PATCH" && w.path === `${REV}/deals/deal-acme`,
    );
    assert.deepEqual(write.body, { nextFollowUpAt: null, followUpReminderAt: null });
    await done.waitFor({ state: "detached" });
    await waitForFocus(
      page.getByRole("button", { name: "Complete Follow up with Northwind" }),
      "focus moves to the next row's Done",
    );
    await page.getByText("Done: Follow up on Acme renewal.").waitFor({ state: "attached" });
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check(
  "Follow-ups: keyboard — Enter on a partnership's Done, then the last row's, lands on New follow-up",
  async () => {
    const view = await app.open({
      path: "/c/acme/revenue/follow-ups",
      routes: followUpRoutes([QUEUE[1], QUEUE[2]]),
    });
    const { page } = view;
    const partner = page.getByRole("button", { name: "Complete Follow up with Northwind" });
    await partner.focus();
    await page.keyboard.press("Enter");
    const write = await view.waitForWrite(
      (w) => w.method === "PATCH" && w.path === `${REV}/partnerships/p-northwind`,
    );
    assert.deepEqual(write.body, { nextFollowUpAt: null, reminderAt: null });
    const task = page.getByRole("button", { name: "Complete Send the security questionnaire" });
    await waitForFocus(task, "focus moves to the remaining row");
    await page.keyboard.press("Enter");
    await view.waitForWrite(
      (w) => w.method === "PATCH" && w.path === `${REV}/follow-ups/task-questionnaire`,
    );
    await page.getByText("Nothing due here").waitFor();
    await waitForFocus(
      page.getByRole("button", { name: "New follow-up" }),
      "with the queue clear, focus lands on New follow-up",
    );
    assert.equal(view.clicks(), 0);
    await page.close();
  },
);

await app.check("Follow-ups: a task about an account links to the account", async () => {
  const view = await app.open({
    path: "/c/acme/revenue/follow-ups",
    routes: followUpRoutes(QUEUE),
  });
  const link = view.page.getByRole("link", { name: "Send the security questionnaire" });
  assert.equal(await link.getAttribute("href"), "/c/acme/revenue/accounts/acct-acme");
  await view.page.close();
});

await app.check(
  "Follow-ups: New follow-up is due the next working morning — type, Enter, created",
  async () => {
    const view = await app.open({
      path: "/c/acme/revenue/follow-ups",
      routes: followUpRoutes([]),
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "New follow-up" }));
    const dialog = page.getByRole("dialog");
    const expected = defaultFollowUpDue(NOW);
    assert.equal(await dialog.getByLabel("Due", { exact: true }).inputValue(), expected);
    const subject = dialog.getByLabel("What needs doing?");
    await waitForFocus(subject, "the subject has focus");
    await subject.fill("Call Priya about the renewal");
    await page.keyboard.press("Enter");
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${REV}/follow-ups`,
    );
    assert.equal(write.body.subject, "Call Priya about the renewal");
    assert.equal(write.body.dueAt, dateTimeLocalToIso(expected), "sent as the instant it means");
    await dialog.waitFor({ state: "detached" });
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

await app.check("Follow-ups at phone width: Done on every row, no sideways scroll", async () => {
  const view = await app.open({
    path: "/c/acme/revenue/follow-ups",
    routes: followUpRoutes(QUEUE),
    touch: true,
    width: 375,
    height: 812,
  });
  const { page } = view;
  await page.getByRole("button", { name: "Complete Follow up on Acme renewal" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Complete / }).count(), 3);
  await noSidewaysScroll(page, "Follow-ups at 375px");
  await page.close();
});

// ───────────────────────────── Deals ─────────────────────────────

function dealRoutes(current: Deal, links: DealContactLink[] = []): ApiRoute[] {
  return [
    [
      "GET",
      `${REV}/deals/${current.id}`,
      () => ({
        deal: current,
        activities: [],
        activityTotal: 0,
        contacts: links,
      }),
    ],
    ["PATCH", `${REV}/deals/${current.id}`, ({ body }) => ({ ...current, ...body })],
    [
      "POST",
      `${REV}/activities`,
      ({ body }) => ({
        id: "activity-new",
        companyId: "company",
        occurredAt: NOW.toISOString(),
        ...body,
      }),
    ],
    ["POST", `${REV}/follow-ups`, ({ body }) => ({ id: "task-new", ...body })],
    ["DELETE", /\/revenue\/deals\/[^/]+\/contacts\/[^/]+$/, () => ({ ok: true })],
    [
      "GET",
      `${REV}/deals/board`,
      () => ({
        columns: [{ stage: STAGE, deals: [current], totalCents: 0, weightedCents: 0 }],
      }),
    ],
    ["GET", `${REV}/deals`, () => ({ rows: [current], total: 1 })],
    ...revenueBase,
  ];
}

await app.check("Deal: ⌘/Ctrl+Enter in the activity box logs it", async () => {
  const view = await app.open({
    path: "/c/acme/revenue/deals/deal-acme",
    routes: dealRoutes(deal()),
  });
  const { page } = view;
  const details = page.getByLabel("Details", { exact: true });
  await details.fill("Walked through pricing; they want the annual plan.");
  await details.press("ControlOrMeta+Enter");
  const write = await view.waitForWrite(
    (w) => w.method === "POST" && w.path === `${REV}/activities`,
  );
  assert.equal(write.body.bodyText, "Walked through pricing; they want the annual plan.");
  assert.equal(write.body.kind, "note");
  assert.equal(await details.inputValue(), "", "the box is ready for the next one");
  assert.equal(view.clicks(), 0);
  await page.close();
});

await app.check(
  "Deal: Enter in Amount saves the Details; nothing is sent until a change",
  async () => {
    const view = await app.open({
      path: "/c/acme/revenue/deals/deal-acme",
      routes: dealRoutes(deal()),
    });
    const { page } = view;
    const amount = page.getByLabel("Amount", { exact: true });
    await amount.press("Enter");
    await page.waitForTimeout(300);
    assert.equal(view.writes.length, 0, "an unchanged form sends nothing");
    await amount.fill("15000");
    await amount.press("Enter");
    const write = await view.waitForWrite(
      (w) => w.method === "PATCH" && w.path === `${REV}/deals/deal-acme`,
    );
    assert.deepEqual(write.body, { amountCents: 1_500_000 });
    assert.equal(view.clicks(), 0);
    await page.close();
  },
);

await app.check(
  "Deal: a follow-up task for a deal with no date starts due the next working morning",
  async () => {
    const view = await app.open({
      path: "/c/acme/revenue/deals/deal-acme",
      routes: dealRoutes(deal()),
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: /Follow-up task/ }).first());
    const dialog = page.getByRole("dialog");
    const expected = defaultFollowUpDue(NOW);
    assert.equal(await dialog.getByLabel("Due", { exact: true }).inputValue(), expected);
    await view.click(dialog.getByRole("button", { name: "Create task" }));
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${REV}/follow-ups`,
    );
    assert.equal(write.body.dueAt, dateTimeLocalToIso(expected));
    assert.equal(write.body.dealId, "deal-acme");
    assert.equal(view.clicks(), 2);
    await page.close();
  },
);

await app.check(
  "Deal on a phone: the committee's remove button shows without a hover, and still confirms",
  async () => {
    const link: DealContactLink = {
      id: "link-1",
      companyId: "company",
      dealId: "deal-acme",
      contactId: "contact-priya",
      role: "champion",
      sortOrder: 0,
      createdAt: hoursAgo(20),
      contact: contact(),
    } as DealContactLink;
    const view = await app.open({
      path: "/c/acme/revenue/deals/deal-acme",
      routes: dealRoutes(deal(), [link]),
      touch: true,
      width: 375,
      height: 812,
    });
    const { page } = view;
    const remove = page.getByRole("button", { name: "Remove Priya Shah" });
    await remove.waitFor();
    const opacity = await remove.evaluate((el) => getComputedStyle(el).opacity);
    assert.equal(opacity, "1", "visible on a touch screen, where there is no hover");
    await view.click(remove);
    await page.getByRole("alertdialog").or(page.getByRole("dialog")).first().waitFor();
    assert.equal(
      view.writes.filter((w) => w.method === "DELETE").length,
      0,
      "the seat is not removed before the confirm",
    );
    await noSidewaysScroll(page, "Deal page at 375px");
    await page.close();
  },
);

await app.check("Deals: List stays chosen on the next visit", async () => {
  const view = await app.open({ path: "/c/acme/revenue/deals", routes: dealRoutes(deal()) });
  const { page } = view;
  await page.getByRole("button", { name: "Board", pressed: true }).waitFor();
  await view.click(page.getByRole("button", { name: "List", pressed: false }));
  await page.getByLabel("Search deals").waitFor();
  await page.reload();
  await page.getByRole("button", { name: "List", pressed: true }).waitFor();
  await page.getByLabel("Search deals").waitFor();
  assert.equal(view.clicks(), 1, "one click, once — not on every visit");
  await page.close();
});

// ──────────────────────── Accounts and Partnerships ────────────────────────

await app.check("New account: Enter creates it and opens it", async () => {
  const created = customer("acct-initech", "Initech", { accountStatus: "prospect" });
  const view = await app.open({
    path: "/c/acme/revenue/accounts",
    routes: [
      ["POST", `${REV}/accounts`, () => created],
      [
        "GET",
        `${REV}/accounts/acct-initech`,
        () => ({ account: created, contacts: [], deals: [] }),
      ],
      ...revenueBase,
    ],
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: /New account/ }).first());
  const name = page.getByRole("dialog").getByLabel("Company name");
  await waitForFocus(name, "the name field has focus");
  await name.fill("Initech");
  await page.keyboard.press("Enter");
  await view.landedOn("/c/acme/revenue/accounts/acct-initech");
  await page.getByRole("heading", { name: "Initech" }).waitFor();
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.check("New partnership: Enter creates it and opens it", async () => {
  const created: Partnership = {
    id: "p-new",
    companyId: "company",
    name: "Hooli",
    type: "",
    status: "",
    customerId: null,
    websiteUrl: "",
    integrationContext: "",
    channelContext: "",
    notes: "",
    ownerId: null,
    ownerEmployeeId: null,
    nextFollowUpAt: null,
    reminderAt: null,
    lastActivityAt: null,
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
  const view = await app.open({
    path: "/c/acme/revenue/partnerships",
    routes: [
      ["GET", `${REV}/partnerships`, () => ({ rows: [] })],
      ["POST", `${REV}/partnerships`, () => created],
      [
        "GET",
        `${REV}/partnerships/p-new`,
        () => ({
          partnership: created,
          contacts: [],
          activities: [],
          activityTotal: 0,
        }),
      ],
      ...revenueBase,
    ],
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: /New partnership/ }).first());
  const name = page.getByRole("dialog").getByLabel("Partner name");
  await waitForFocus(name, "the name field has focus");
  await name.fill("Hooli");
  await page.keyboard.press("Enter");
  await view.landedOn("/c/acme/revenue/partnerships/p-new");
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.check(
  "Contact: Archive is one click — no confirm — and Restore, in the same place, undoes it",
  async () => {
    let current = contact();
    const view = await app.open({
      path: "/c/acme/revenue/contacts/contact-priya",
      routes: [
        [
          "GET",
          `${REV}/contacts/contact-priya`,
          () => ({
            contact: current,
            activities: [],
            activityTotal: 0,
            openDeals: [],
          }),
        ],
        [
          "POST",
          `${REV}/contacts/contact-priya/archive`,
          () => {
            current = contact({ archivedAt: NOW.toISOString() });
            return current;
          },
        ],
        [
          "POST",
          `${REV}/contacts/contact-priya/restore`,
          () => {
            current = contact();
            return current;
          },
        ],
        ["GET", /\/revenue\/contacts\/contact-priya\/enrollments/, () => ({ rows: [] })],
        ...revenueBase,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Archive", exact: true }));
    await view.waitForWrite((w) => w.path === `${REV}/contacts/contact-priya/archive`);
    assert.equal(await page.getByRole("dialog").count(), 0, "no confirm to click through");
    const restore = page.getByRole("button", { name: "Restore", exact: true });
    await restore.waitFor();
    await page.getByText("Archived Priya Shah. Restore puts them back.").waitFor({
      state: "attached",
    });
    await view.click(restore);
    await view.waitForWrite((w) => w.path === `${REV}/contacts/contact-priya/restore`);
    await page.getByRole("button", { name: "Archive", exact: true }).waitFor();
    // The account on the contact is one click away.
    const account = page.getByRole("link", { name: "Acme", exact: true });
    assert.equal(await account.getAttribute("href"), "/c/acme/revenue/accounts/acct-acme");
    assert.equal(view.clicks(), 2);
    await page.close();
  },
);

await app.check(
  "Account: Archive is one click; the banner and Restore appear at once",
  async () => {
    const release = (() => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    })();
    const view = await app.open({
      path: "/c/acme/revenue/accounts/acct-acme",
      routes: [
        ["GET", `${REV}/accounts/acct-acme`, () => ({ account: ACME, contacts: [], deals: [] })],
        [
          "POST",
          `${REV}/accounts/acct-acme/archive`,
          async () => {
            await release.opened;
            return { ...ACME, archivedAt: NOW.toISOString() };
          },
        ],
        ...revenueBase,
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Archive", exact: true }));
    // Shown before the server answers: the change is the page's, at once.
    await page.getByText("This Account is archived.").waitFor();
    await page.getByRole("button", { name: "Restore", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "no confirm to click through");
    release.open();
    await view.waitForWrite((w) => w.path === `${REV}/accounts/acct-acme/archive`);
    assert.equal(view.clicks(), 1);
    await page.close();
  },
);

// ──────────────────────────── Customers ────────────────────────────

const financeBase: ApiRoute[] = [
  ["GET", `${API}/customers`, () => [ACME, GLOBEX]],
  ["GET", `${API}/products`, () => []],
  ["GET", `${API}/tax-rates`, () => []],
  ["GET", `${API}/finance/subsidiaries`, () => []],
  ...revenueBase,
];

/** What the Customer field shows: the picked customer's label, or "" for nobody. */
const customerField = (page: import("playwright-core").Page) =>
  page.getByRole("combobox", { name: "Customer", exact: true });

await app.check(
  "a customer's New invoice, New estimate and New request links carry the customer",
  async () => {
    const view = await app.open({
      path: "/c/acme/customers/globex?tab=billing",
      routes: [
        ["GET", `${API}/customers/globex`, () => GLOBEX],
        ["GET", `${API}/invoices`, () => []],
        ["GET", `${API}/estimates`, () => []],
        ["GET", `${API}/recurring-invoices`, () => []],
        ["GET", `${API}/credit-notes`, () => []],
        ["GET", `${API}/signature-envelopes`, () => []],
        ...financeBase,
      ],
    });
    const { page } = view;
    const link = (name: string) => page.getByRole("link", { name, exact: true });
    await link("New invoice").waitFor();
    assert.equal(
      await link("New invoice").getAttribute("href"),
      "/c/acme/finance/invoices/new?customerId=acct-globex",
    );
    assert.equal(
      await link("New estimate").getAttribute("href"),
      "/c/acme/finance/estimates/new?customerId=acct-globex",
    );
    await view.click(page.getByRole("tab", { name: /Documents/ }));
    await link("New request").waitFor();
    assert.equal(
      await link("New request").getAttribute("href"),
      "/c/acme/signatures/new?customerId=acct-globex",
    );
    await page.close();
  },
);

await app.check(
  "New invoice from a customer starts with that customer and currency, not the first",
  async () => {
    const view = await app.open({
      path: "/c/acme/finance/invoices/new?customerId=acct-globex",
      routes: financeBase,
    });
    const { page } = view;
    await page.waitForFunction(() =>
      [...document.querySelectorAll("select")].some((s) => s.value === "acct-globex"),
    );
    assert.match(await customerField(page).inputValue(), /^Globex/);
    assert.equal(await page.getByLabel("Currency", { exact: true }).inputValue(), "EUR");
    await page.close();
  },
);

await app.check("New estimate for a customer who is gone picks nobody and says so", async () => {
  const view = await app.open({
    path: "/c/acme/finance/estimates/new?customerId=acct-gone",
    routes: financeBase,
  });
  const { page } = view;
  await page.getByText("The customer you came from is archived or no longer exists.").waitFor();
  assert.equal(await customerField(page).inputValue(), "", "never swapped for the first customer");
  await page.close();
});

await app.check("New signature request from a customer starts linked to them", async () => {
  const view = await app.open({
    path: "/c/acme/signatures/new?customerId=acct-globex",
    routes: [["GET", `${API}/signature-envelopes`, () => []], ...financeBase],
  });
  const { page } = view;
  await page.waitForFunction(() =>
    [...document.querySelectorAll("select")].some((s) => s.value === "acct-globex"),
  );
  await page.close();
});

await app.check("New customer: Name has the cursor, and Create opens the customer", async () => {
  const created = customer("acct-initech", "Initech");
  const view = await app.open({
    path: "/c/acme/customers/new",
    routes: [["POST", `${API}/customers`, () => created], ...financeBase],
  });
  const { page } = view;
  const name = page.getByLabel("Name", { exact: true });
  await waitForFocus(name, "the Name field has focus");
  await page.keyboard.type("Initech");
  await page.keyboard.press("Enter");
  await view.landedOn("/c/acme/customers/initech");
  assert.equal(view.clicks(), 0);
  await page.close();
});

await app.check("Edit customer: Save returns to the customer, as do Back and Cancel", async () => {
  const view = await app.open({
    path: "/c/acme/customers/globex/edit",
    routes: [
      ["GET", `${API}/customers/globex`, () => GLOBEX],
      ["PATCH", `${API}/customers/globex`, ({ body }) => ({ ...GLOBEX, ...body })],
      ...financeBase,
    ],
  });
  const { page } = view;
  const name = page.getByLabel("Name", { exact: true });
  await name.waitFor();
  assert.notEqual(await focused(page), "input:Name", "editing does not grab the cursor");
  assert.equal(
    await page.getByRole("link", { name: "Back to the customer" }).getAttribute("href"),
    "/c/acme/customers/globex",
  );
  await name.fill("Globex Corporation");
  await view.click(page.getByRole("button", { name: "Save changes" }));
  await view.landedOn("/c/acme/customers/globex");
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.finish();
