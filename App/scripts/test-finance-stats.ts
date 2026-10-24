/**
 * Real Chrome coverage for the figures Finance → Invoices and Finance →
 * Estimates lead with, on the real App against a deterministic API: each
 * panel lays out the server's figures; a click on a tile, or on a part of the
 * breakdown bar, narrows the list to exactly the documents the figure counts
 * — archived ones included where a figure counts them — and says so above
 * the list; the view lives in the address, survives a reload and ends with
 * Show all or any status tab; the list's statuses agree with the figures on
 * the company's day (an invoice due today is not overdue, an accepted
 * estimate never expires); the panel waits for its figures, says so when
 * they fail and tries again, and stays out of the way with nothing issued;
 * and it fits a phone and reads in the dark. The Recurring invoices panel,
 * drawn from the same pieces, still reads as before.
 * Run with `npm run test:finance-stats`.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type {
  EstimateListItem,
  InvoiceListItem,
  RecurringInvoiceListItem,
  RecurringRevenueMetrics,
} from "../client/lib/api";
import type { EstimateStats, InvoiceStats } from "../shared/financeStats";
import {
  API,
  gate,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  status,
  type ApiRoute,
  type AppView,
} from "./appFixture";

const app = await startApp("Finance figures — Invoices and Estimates");

// The fixture's clock reads 2026-10-09 09:00 UTC, so today is the 9th.
const TODAY = "2026-10-09";
const day = (date: string) => `${date}T00:00:00.000Z`;

// ───────────────────────────── fixtures ─────────────────────────────

const ACME = { id: "acct-acme", name: "Acme Corp", slug: "acme-corp", email: "ap@acme.example" };
const GLOBEX = { id: "acct-globex", name: "Globex", slug: "globex", email: "ap@globex.example" };
const INITECH = { id: "acct-initech", name: "Initech", slug: "initech", email: "ap@initech.example" };

type InvoiceSeed = {
  number: string;
  customer: typeof ACME;
  status: InvoiceListItem["status"];
  issued: string;
  due: string;
  totalCents: number;
  paidCents?: number;
  archived?: boolean;
};

function invoice(id: string, seed: InvoiceSeed): InvoiceListItem {
  const paid = seed.paidCents ?? (seed.status === "paid" ? seed.totalCents : 0);
  return {
    id,
    companyId: "company",
    customerId: seed.customer.id,
    subsidiaryId: null,
    issuerSnapshot: null,
    slug: seed.number ? seed.number.toLowerCase() : `draft-${id}`,
    numberSeq: 1,
    number: seed.number,
    status: seed.status,
    issueDate: day(seed.issued),
    dueDate: day(seed.due),
    currency: "USD",
    exchangeRate: seed.status === "draft" ? null : 1,
    subtotalCents: seed.totalCents,
    discountPercent: 0,
    discountAmountCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: seed.totalCents,
    paidCents: paid,
    creditedCents: 0,
    writtenOffCents: 0,
    balanceCents: seed.status === "void" ? 0 : seed.totalCents - paid,
    notes: "",
    footer: "",
    sentAt: seed.status === "draft" ? null : day(seed.issued),
    paidAt: seed.status === "paid" ? hoursAgo(200) : null,
    voidedAt: seed.status === "void" ? hoursAgo(100) : null,
    archivedAt: seed.archived ? hoursAgo(50) : null,
    recurringInvoiceId: null,
    createdById: "viewer",
    createdAt: day(seed.issued),
    updatedAt: day(seed.issued),
    customer: seed.customer,
    recurringInvoice: null,
    linesCount: 1,
    paymentsCount: paid > 0 ? 1 : 0,
  };
}

const INVOICES: InvoiceListItem[] = [
  invoice("inv-late-100", {
    number: "ACME-CORP-INV-0001",
    customer: ACME,
    status: "sent",
    issued: "2026-06-01",
    due: "2026-07-01",
    totalCents: 450_000,
  }),
  invoice("inv-late-45", {
    number: "GLOBEX-INV-0003",
    customer: GLOBEX,
    status: "sent",
    issued: "2026-07-26",
    due: "2026-08-25",
    totalCents: 120_000,
    paidCents: 20_000,
  }),
  invoice("inv-due-today", {
    number: "ACME-CORP-INV-0004",
    customer: ACME,
    status: "sent",
    issued: "2026-09-09",
    due: TODAY,
    totalCents: 80_000,
  }),
  invoice("inv-due-soon", {
    number: "INITECH-INV-0002",
    customer: INITECH,
    status: "sent",
    issued: "2026-09-30",
    due: "2026-10-30",
    totalCents: 200_000,
  }),
  invoice("inv-later", {
    number: "ACME-CORP-INV-0005",
    customer: ACME,
    status: "sent",
    issued: "2026-10-01",
    due: "2026-12-15",
    totalCents: 300_000,
  }),
  invoice("inv-paid", {
    number: "GLOBEX-INV-0002",
    customer: GLOBEX,
    status: "paid",
    issued: "2026-09-15",
    due: "2026-10-15",
    totalCents: 150_000,
  }),
  invoice("inv-paid-filed", {
    number: "ACME-CORP-INV-0002",
    customer: ACME,
    status: "paid",
    issued: "2026-09-01",
    due: "2026-10-01",
    totalCents: 90_000,
    archived: true,
  }),
  invoice("inv-draft", {
    number: "",
    customer: INITECH,
    status: "draft",
    issued: "2026-10-08",
    due: "2026-10-22",
    totalCents: 999_900,
  }),
  invoice("inv-void", {
    number: "GLOBEX-INV-0001",
    customer: GLOBEX,
    status: "void",
    issued: "2026-08-01",
    due: "2026-08-31",
    totalCents: 77_700,
  }),
];

const docs = (ids: string[], amountCents: number) => ({ count: ids.length, amountCents, ids });

const INVOICE_STATS: InvoiceStats = {
  currency: "USD",
  timeZone: "Europe/London",
  today: TODAY,
  issuedInvoices: 7,
  outstanding: {
    ...docs(["inv-late-100", "inv-late-45", "inv-due-today", "inv-due-soon", "inv-later"], 1_130_000),
    customers: 3,
  },
  ageing: [
    { bucket: "current", ...docs(["inv-due-today", "inv-due-soon", "inv-later"], 580_000) },
    { bucket: "1-30", ...docs([], 0) },
    { bucket: "31-60", ...docs(["inv-late-45"], 100_000) },
    { bucket: "61-90", ...docs([], 0) },
    { bucket: "90+", ...docs(["inv-late-100"], 450_000) },
  ],
  overdue: {
    ...docs(["inv-late-100", "inv-late-45"], 550_000),
    oldest: { id: "inv-late-100", number: "ACME-CORP-INV-0001", slug: "acme-corp-inv-0001", daysLate: 100 },
  },
  dueSoon: { ...docs(["inv-due-today", "inv-due-soon"], 280_000), days: 30 },
  paid: {
    ...docs(["inv-paid-filed", "inv-paid"], 240_000),
    days: 30,
    previousCents: 120_000,
    previousCount: 1,
  },
  daysToPay: { days: 90, averageDays: 12.5, count: 2, ids: ["inv-paid-filed", "inv-paid"] },
  largestCustomer: {
    id: ACME.id,
    name: ACME.name,
    slug: ACME.slug,
    ...docs(["inv-late-100", "inv-due-today", "inv-later"], 830_000),
  },
  converted: ["EUR"],
  unconverted: [],
};

type EstimateSeed = {
  number: string;
  customer: typeof ACME;
  status: EstimateListItem["status"];
  issued: string;
  validUntil: string;
  totalCents: number;
  invoiced?: boolean;
  archived?: boolean;
};

function estimate(id: string, seed: EstimateSeed): EstimateListItem {
  return {
    id,
    companyId: "company",
    customerId: seed.customer.id,
    subsidiaryId: null,
    issuerSnapshot: null,
    slug: seed.number ? seed.number.toLowerCase() : `edraft-${id}`,
    numberSeq: 1,
    number: seed.number,
    status: seed.status,
    issueDate: day(seed.issued),
    validUntil: day(seed.validUntil),
    currency: "USD",
    subtotalCents: seed.totalCents,
    discountPercent: 0,
    discountAmountCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: seed.totalCents,
    notes: "",
    footer: "",
    sentAt: seed.status === "draft" ? null : day(seed.issued),
    acceptedAt: seed.status === "accepted" ? hoursAgo(720) : null,
    declinedAt: seed.status === "declined" ? hoursAgo(300) : null,
    voidedAt: seed.status === "void" ? hoursAgo(10) : null,
    invoiceId: seed.invoiced ? `invoice-of-${id}` : null,
    convertedAt: seed.invoiced ? hoursAgo(500) : null,
    archivedAt: seed.archived ? hoursAgo(20) : null,
    createdById: "viewer",
    createdAt: day(seed.issued),
    updatedAt: day(seed.issued),
    customer: { ...seed.customer, billingAddress: "" },
    invoice: seed.invoiced
      ? { id: `invoice-of-${id}`, slug: `inv-of-${id}`, number: "INV-X", status: "sent" }
      : null,
    linesCount: 1,
  };
}

const ESTIMATES: EstimateListItem[] = [
  estimate("est-soon", {
    number: "ACME-CORP-EST-0001",
    customer: ACME,
    status: "sent",
    issued: "2026-09-15",
    validUntil: "2026-10-15",
    totalCents: 50_000,
  }),
  estimate("est-later", {
    number: "GLOBEX-EST-0001",
    customer: GLOBEX,
    status: "sent",
    issued: "2026-10-01",
    validUntil: "2026-11-30",
    totalCents: 100_000,
  }),
  estimate("est-last-day", {
    number: "INITECH-EST-0001",
    customer: INITECH,
    status: "sent",
    issued: "2026-09-09",
    validUntil: TODAY,
    totalCents: 30_000,
  }),
  estimate("est-won-waiting", {
    number: "ACME-CORP-EST-0002",
    customer: ACME,
    status: "accepted",
    issued: "2026-08-01",
    validUntil: "2026-09-01",
    totalCents: 70_000,
  }),
  estimate("est-invoiced", {
    number: "GLOBEX-EST-0002",
    customer: GLOBEX,
    status: "accepted",
    issued: "2026-08-20",
    validUntil: "2026-09-20",
    totalCents: 90_000,
    invoiced: true,
  }),
  estimate("est-declined", {
    number: "ACME-CORP-EST-0003",
    customer: ACME,
    status: "declined",
    issued: "2026-09-01",
    validUntil: "2026-10-01",
    totalCents: 25_000,
  }),
  estimate("est-lapsed", {
    number: "INITECH-EST-0002",
    customer: INITECH,
    status: "sent",
    issued: "2026-08-30",
    validUntil: "2026-09-30",
    totalCents: 20_000,
  }),
  estimate("est-declined-filed", {
    number: "ACME-CORP-EST-0004",
    customer: ACME,
    status: "declined",
    issued: "2026-08-15",
    validUntil: "2026-09-15",
    totalCents: 15_000,
    archived: true,
  }),
  estimate("est-draft", {
    number: "",
    customer: GLOBEX,
    status: "draft",
    issued: "2026-10-08",
    validUntil: "2026-11-08",
    totalCents: 400_000,
  }),
];

const ESTIMATE_STATS: EstimateStats = {
  currency: "USD",
  timeZone: "Europe/London",
  today: TODAY,
  issuedEstimates: 8,
  open: { ...docs(["est-last-day", "est-soon", "est-later"], 180_000), customers: 3 },
  expiringSoon: {
    ...docs(["est-last-day", "est-soon"], 80_000),
    days: 14,
    firstValidUntil: TODAY,
  },
  acceptedNotInvoiced: { ...docs(["est-won-waiting"], 70_000), oldestDaysWaiting: 30 },
  recent: {
    days: 90,
    outcomes: [
      { outcome: "invoiced", ...docs(["est-invoiced"], 90_000) },
      { outcome: "accepted", ...docs(["est-won-waiting"], 70_000) },
      { outcome: "open", ...docs(["est-last-day", "est-soon", "est-later"], 180_000) },
      { outcome: "expired", ...docs(["est-lapsed"], 20_000) },
      { outcome: "declined", ...docs(["est-declined", "est-declined-filed"], 40_000) },
    ],
    acceptance: {
      accepted: 2,
      decided: 5,
      ids: ["est-invoiced", "est-won-waiting", "est-lapsed", "est-declined", "est-declined-filed"],
    },
    lost: {
      ...docs(["est-lapsed", "est-declined", "est-declined-filed"], 60_000),
      declined: 2,
      expired: 1,
    },
  },
  largestCustomer: { id: GLOBEX.id, name: GLOBEX.name, slug: GLOBEX.slug, ...docs(["est-later"], 100_000) },
  converted: [],
  unconverted: [{ currency: "JPY", estimates: 1 }],
};

const EMPTY_INVOICE_STATS: InvoiceStats = {
  ...INVOICE_STATS,
  issuedInvoices: 0,
  outstanding: { ...docs([], 0), customers: 0 },
  ageing: INVOICE_STATS.ageing.map((band) => ({ ...band, ...docs([], 0) })),
  overdue: { ...docs([], 0), oldest: null },
  dueSoon: { ...docs([], 0), days: 30 },
  paid: { ...docs([], 0), days: 30, previousCents: 0, previousCount: 0 },
  daysToPay: { days: 90, averageDays: null, count: 0, ids: [] },
  largestCustomer: null,
  converted: [],
};

function invoiceRoutes(stats: () => unknown = () => INVOICE_STATS, list = INVOICES): ApiRoute[] {
  return [
    ["GET", `${API}/invoices/stats`, () => stats()],
    ["GET", `${API}/invoices`, () => list],
  ];
}

function estimateRoutes(stats: () => unknown = () => ESTIMATE_STATS, list = ESTIMATES): ApiRoute[] {
  return [
    ["GET", `${API}/estimates/stats`, () => stats()],
    ["GET", `${API}/estimates`, () => list],
  ];
}

// ───────────────────────────── helpers ─────────────────────────────

function panel(page: Page, name: "Invoice figures" | "Estimate figures" | "Recurring revenue") {
  return page.getByRole("region", { name });
}

/** `text` as a pattern that matches it literally: "90+ days" has a quantifier in it. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tile(region: Locator, label: string): Locator {
  return region.getByRole("button", { name: new RegExp(`^${literal(label)}`) });
}

/** The panel's headline figure. */
async function headline(region: Locator): Promise<string> {
  return ((await region.locator("p.text-3xl").textContent()) ?? "").trim();
}

/** The numbers of the rows the list shows, in order. */
async function shownNumbers(page: Page): Promise<string[]> {
  await page.locator("tbody tr").first().waitFor();
  return page.locator("tbody tr td.font-mono a:first-child").allTextContents();
}

async function viewLine(page: Page): Promise<string> {
  const line = page.locator('p[role="status"]');
  await line.waitFor();
  return ((await line.textContent()) ?? "").replace(/\s+/g, " ").trim();
}

async function pressed(target: Locator): Promise<string | null> {
  return target.getAttribute("aria-pressed");
}

async function open(path: string, routes: ApiRoute[], extra: Partial<Parameters<typeof app.open>[0]> = {}) {
  const view = await app.open({ path, routes, ...extra });
  // The machine running these is shared and busy: give every wait room.
  view.page.setDefaultTimeout(60_000);
  return view;
}

async function close(view: AppView) {
  assert.deepEqual(view.unrouted, [], "every request the page made was answered");
  await view.page.close();
}

// ───────────────────────────── invoices ─────────────────────────────

await app.check("Invoices lead with what is outstanding, how late, and what came in", async () => {
  const view = await open("/c/acme/finance/invoices", invoiceRoutes());
  const { page } = view;
  const figures = panel(page, "Invoice figures");
  await figures.waitFor();
  assert.equal(await headline(figures), "$11,300");
  await figures.getByText("5 invoices · 3 customers · tax included").waitFor();
  // The ageing bar's legend carries every band that holds anything.
  for (const label of ["Not yet due", "31–60 days", "90+ days"]) {
    await figures.getByRole("button", { name: new RegExp(`^${literal(label)}`) }).waitFor();
  }
  assert.equal(await figures.getByRole("button", { name: /^1–30 days/ }).count(), 0, "empty bands are left out");
  assert.match((await tile(figures, "Overdue").textContent()) ?? "", /\$5,500.*2 invoices, the oldest 100 days late/);
  assert.match(
    (await tile(figures, "Due in the next 30 days").textContent()) ?? "",
    /\$2,800.*2 invoices, due by (Nov 8|8 Nov)/,
  );
  assert.match(
    (await tile(figures, "Paid in the last 30 days").textContent()) ?? "",
    /\$2,400.*Up 100% on the 30 days before/,
  );
  assert.match(
    (await tile(figures, "Average days to pay").textContent()) ?? "",
    /13 days.*Across 2 invoices paid in full in 90 days/,
  );
  assert.match(
    (await tile(figures, "Largest customer").textContent()) ?? "",
    /73%.*of outstanding, owed by Acme Corp/,
  );
  await figures.getByText(/EUR converts to USD at the rate each invoice and payment locked/).waitFor();
  await figures.getByText(/overdue from the day after its due date, by the calendar in Europe\/London/).waitFor();
  // The figures arrived with the list, and the list opens on Active.
  assert.deepEqual(await shownNumbers(page), [
    "ACME-CORP-INV-0001",
    "GLOBEX-INV-0003",
    "ACME-CORP-INV-0004",
    "INITECH-INV-0002",
    "ACME-CORP-INV-0005",
    "GLOBEX-INV-0002",
    "DRAFT",
  ]);
  await app.shot(page, "finance-stats-invoices-desktop");
  await close(view);
});

await app.check("A tile narrows the invoice list to exactly the invoices it counts", async () => {
  const view = await open("/c/acme/finance/invoices", invoiceRoutes());
  const { page } = view;
  const figures = panel(page, "Invoice figures");
  const overdue = tile(figures, "Overdue");
  await view.click(overdue);
  await view.landedOn("/c/acme/finance/invoices?show=overdue");
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-INV-0001", "GLOBEX-INV-0003"]);
  assert.equal(await viewLine(page), "Overdue · 2 invoices");
  assert.equal(await pressed(overdue), "true");
  assert.equal(
    await page.getByRole("button", { name: /^Active/ }).evaluate((el) => el.className.includes("bg-indigo-50")),
    false,
    "no status tab is selected while a figure is",
  );
  for (const badge of await page.locator("tbody tr td:nth-child(4)").allTextContents()) {
    assert.equal(badge.trim(), "overdue");
  }
  await app.shot(page, "finance-stats-invoices-overdue");

  // Due soon: today's invoice is due, not overdue, and its badge agrees.
  await view.click(tile(figures, "Due in the next 30 days"));
  await view.landedOn("/c/acme/finance/invoices?show=due-soon");
  assert.equal(await pressed(overdue), "false");
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-INV-0004", "INITECH-INV-0002"]);
  const todayRow = page.locator("tbody tr", { hasText: "ACME-CORP-INV-0004" });
  assert.equal(((await todayRow.locator("td:nth-child(4)").textContent()) ?? "").trim(), "sent");

  // Cash received counts an archived invoice, which the view shows, marked.
  await view.click(tile(figures, "Paid in the last 30 days"));
  await view.landedOn("/c/acme/finance/invoices?show=paid");
  assert.deepEqual(await shownNumbers(page), ["GLOBEX-INV-0002", "ACME-CORP-INV-0002"]);
  const filed = page.locator("tbody tr", { hasText: "ACME-CORP-INV-0002" });
  await filed.getByText("Archived", { exact: true }).waitFor();
  assert.equal(await filed.getByRole("checkbox").isDisabled(), true, "an archived row is shown, not acted on");
  assert.equal(await viewLine(page), "Paid in the last 30 days · 2 invoices");

  await view.click(tile(figures, "Average days to pay"));
  assert.deepEqual(await shownNumbers(page), ["GLOBEX-INV-0002", "ACME-CORP-INV-0002"]);
  assert.equal(await viewLine(page), "Paid in full in the last 90 days · 2 invoices");

  await view.click(tile(figures, "Largest customer"));
  await view.landedOn("/c/acme/finance/invoices?show=largest-customer");
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-INV-0001", "ACME-CORP-INV-0004", "ACME-CORP-INV-0005"]);
  assert.equal(await viewLine(page), "Owed by Acme Corp · 3 invoices");

  // A band of the ageing bar filters the same way.
  const band = figures.getByRole("button", { name: /^31–60 days/ });
  await view.click(band);
  await view.landedOn("/c/acme/finance/invoices?show=age-31-60");
  assert.deepEqual(await shownNumbers(page), ["GLOBEX-INV-0003"]);
  assert.equal(await pressed(band), "true");
  assert.equal(await viewLine(page), "31–60 days overdue · 1 invoice");

  // The same figure again, Show all, or a status tab ends the view.
  await view.click(band);
  await view.landedOn("/c/acme/finance/invoices");
  assert.equal(await page.locator('p[role="status"]').count(), 0);
  await view.click(overdue);
  await view.landedOn("/c/acme/finance/invoices?show=overdue");
  await view.click(page.getByRole("button", { name: "Show all" }));
  await view.landedOn("/c/acme/finance/invoices");
  assert.equal((await shownNumbers(page)).length, 7);
  await view.click(tile(figures, "Overdue"));
  await view.landedOn("/c/acme/finance/invoices?show=overdue");
  // The Paid tab — its name is the word and its count — not the Paid figure.
  await view.click(page.getByRole("button", { name: /^Paid\s*\d+$/ }));
  await view.landedOn("/c/acme/finance/invoices");
  assert.deepEqual(await shownNumbers(page), ["GLOBEX-INV-0002"], "the Paid tab, not the figure");
  await close(view);
});

await app.check("A link to a figure opens the list already narrowed to it", async () => {
  const view = await open("/c/acme/finance/invoices?show=age-over-90", invoiceRoutes());
  const { page } = view;
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-INV-0001"]);
  assert.equal(await viewLine(page), "90+ days overdue · 1 invoice");
  assert.equal(await pressed(panel(page, "Invoice figures").getByRole("button", { name: /^90\+ days/ })), "true");
  await close(view);

  // A key that names no figure is ignored rather than emptying the list.
  const junk = await open("/c/acme/finance/invoices?show=nonsense", invoiceRoutes());
  assert.equal((await shownNumbers(junk.page)).length, 7);
  assert.equal(await junk.page.locator('p[role="status"]').count(), 0);
  await close(junk);
});

await app.check("The invoice figures wait to land with the list, and say so when they fail", async () => {
  const held = gate();
  const view = await open(
    "/c/acme/finance/invoices",
    invoiceRoutes(async () => {
      await held.opened;
      return INVOICE_STATS;
    }),
  );
  const { page } = view;
  await page.getByRole("heading", { name: "Invoices" }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole("button", { name: /^Active/ }).count(), 0, "no tabs to push down yet");
  assert.equal(await panel(page, "Invoice figures").count(), 0);
  held.open();
  await panel(page, "Invoice figures").waitFor();
  await page.getByRole("button", { name: /^Active/ }).waitFor();
  await close(view);

  let failing = true;
  const flaky = await open(
    "/c/acme/finance/invoices",
    invoiceRoutes(() => (failing ? status(500, { error: "Database is busy" }) : INVOICE_STATS)),
  );
  await flaky.page.getByText("Couldn't load the invoice figures.").waitFor();
  assert.equal((await shownNumbers(flaky.page)).length, 7, "the list stands without them");
  failing = false;
  await flaky.click(flaky.page.getByRole("button", { name: "Try again" }));
  await panel(flaky.page, "Invoice figures").waitFor();
  assert.equal(await flaky.page.getByText("Couldn't load the invoice figures.").count(), 0);
  await close(flaky);
});

await app.check("With nothing issued, the invoice list has no figures to lead with", async () => {
  const drafts = INVOICES.filter((inv) => inv.status === "draft");
  const view = await open("/c/acme/finance/invoices", invoiceRoutes(() => EMPTY_INVOICE_STATS, drafts));
  const { page } = view;
  assert.deepEqual(await shownNumbers(page), ["DRAFT"]);
  assert.equal(await panel(page, "Invoice figures").count(), 0);
  await close(view);

  // Nothing at all, and the figures failing too: still only the list's own empty state.
  const empty = await open(
    "/c/acme/finance/invoices",
    invoiceRoutes(() => status(500), []),
  );
  await empty.page.getByText("Create one to start billing customers.").waitFor();
  assert.equal(await empty.page.getByText("Couldn't load the invoice figures.").count(), 0);
  await close(empty);
});

await app.check("Settled invoices show a quiet panel: nothing outstanding, cash still counted", async () => {
  const settled = INVOICES.filter((inv) => inv.status === "paid");
  const stats: InvoiceStats = {
    ...EMPTY_INVOICE_STATS,
    issuedInvoices: 2,
    paid: { ...docs(["inv-paid-filed", "inv-paid"], 240_000), days: 30, previousCents: 0, previousCount: 0 },
    daysToPay: { days: 90, averageDays: 0, count: 2, ids: ["inv-paid-filed", "inv-paid"] },
  };
  const view = await open("/c/acme/finance/invoices", invoiceRoutes(() => stats, settled));
  const figures = panel(view.page, "Invoice figures");
  await figures.getByText("Nothing outstanding: every issued invoice is settled.").waitFor();
  assert.equal(await figures.getByText("By days overdue").count(), 0, "no bar with nothing to split");
  // A tile with nothing behind it is a figure, not a button.
  assert.equal(await tile(figures, "Overdue").count(), 0);
  await figures.getByText("Nothing overdue").waitFor();
  assert.match((await tile(figures, "Paid in the last 30 days").textContent()) ?? "", /Nothing in the 30 days before/);
  assert.match((await tile(figures, "Average days to pay").textContent()) ?? "", /0 days/);
  await close(view);
});

await app.check("A read-only Member gets the figures and the filters, and nothing to tick", async () => {
  const view = await open("/c/acme/finance/invoices", invoiceRoutes(), {
    role: "member",
    company: { financeAccess: "read" },
  });
  const { page } = view;
  const figures = panel(page, "Invoice figures");
  await view.click(tile(figures, "Overdue"));
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-INV-0001", "GLOBEX-INV-0003"]);
  assert.equal(await page.getByRole("checkbox").count(), 0);
  assert.equal(await page.getByRole("link", { name: "New invoice" }).count(), 0);
  await close(view);
});

// ───────────────────────────── estimates ─────────────────────────────

await app.check("Estimates lead with what is open, how recent quotes went, and what waits", async () => {
  const view = await open("/c/acme/finance/estimates", estimateRoutes());
  const { page } = view;
  const figures = panel(page, "Estimate figures");
  await figures.waitFor();
  assert.equal(await headline(figures), "$1,800");
  await figures.getByText("3 estimates · 3 customers · tax included").waitFor();
  await figures.getByRole("heading", { name: "Issued in the last 90 days" }).waitFor();
  for (const label of ["Invoiced", "Accepted", "Open", "Expired", "Declined"]) {
    await figures.getByRole("button", { name: new RegExp(`^${literal(label)}\\b`) }).first().waitFor();
  }
  assert.match((await tile(figures, "Acceptance rate").textContent()) ?? "", /40%.*2 of 5 decided estimates, last 90 days/);
  assert.match(
    (await tile(figures, "Expiring in 14 days").textContent()) ?? "",
    /\$800.*2 estimates, the first valid until (Oct 9|9 Oct)/,
  );
  assert.match(
    (await tile(figures, "Accepted, not invoiced").textContent()) ?? "",
    /\$700.*1 estimate, the oldest accepted 30 days ago/,
  );
  assert.match(
    (await tile(figures, "Declined or expired").textContent()) ?? "",
    /\$600.*2 declined · 1 expired, last 90 days/,
  );
  assert.match((await tile(figures, "Largest customer").textContent()) ?? "", /56%.*of open value, with Globex/);
  await figures.getByText(/1 estimate quoted in JPY isn't counted/).waitFor();
  await figures.getByRole("link", { name: "Add a rate" }).waitFor();
  // The statuses agree with the figures on the company's day: the last valid
  // day is still Sent, and the accepted estimate past its date is Accepted.
  const badge = (number: string) =>
    page.locator("tbody tr", { hasText: number }).locator("td:nth-child(4)");
  assert.equal(((await badge("INITECH-EST-0001").textContent()) ?? "").trim(), "sent");
  assert.equal(((await badge("ACME-CORP-EST-0002").textContent()) ?? "").trim(), "accepted");
  assert.equal(((await badge("INITECH-EST-0002").textContent()) ?? "").trim(), "expired");
  await app.shot(page, "finance-stats-estimates-desktop");
  await close(view);
});

await app.check("A tile narrows the estimate list to exactly the estimates it counts", async () => {
  const view = await open("/c/acme/finance/estimates", estimateRoutes());
  const { page } = view;
  const figures = panel(page, "Estimate figures");

  await view.click(tile(figures, "Accepted, not invoiced"));
  await view.landedOn("/c/acme/finance/estimates?show=accepted");
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-EST-0002"]);
  assert.equal(await viewLine(page), "Accepted, not yet invoiced · 1 estimate");

  await view.click(tile(figures, "Declined or expired"));
  await view.landedOn("/c/acme/finance/estimates?show=lost");
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-EST-0003", "INITECH-EST-0002", "ACME-CORP-EST-0004"]);
  const filed = page.locator("tbody tr", { hasText: "ACME-CORP-EST-0004" });
  await filed.getByText("Archived", { exact: true }).waitFor();
  assert.equal(await filed.getByRole("checkbox").isDisabled(), true);

  await view.click(tile(figures, "Acceptance rate"));
  assert.equal((await shownNumbers(page)).length, 5);
  assert.equal(await viewLine(page), "Decided, issued in the last 90 days · 5 estimates");

  await view.click(tile(figures, "Expiring in 14 days"));
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-EST-0001", "INITECH-EST-0001"]);

  await view.click(tile(figures, "Largest customer"));
  assert.deepEqual(await shownNumbers(page), ["GLOBEX-EST-0001"]);
  assert.equal(await viewLine(page), "Open with Globex · 1 estimate");

  const openPart = figures.getByRole("button", { name: /^Open\b/ });
  await view.click(openPart);
  await view.landedOn("/c/acme/finance/estimates?show=recent-open");
  assert.deepEqual(await shownNumbers(page), ["ACME-CORP-EST-0001", "GLOBEX-EST-0001", "INITECH-EST-0001"]);
  assert.equal(await pressed(openPart), "true");
  await view.click(page.getByRole("button", { name: /^Drafts/ }));
  await view.landedOn("/c/acme/finance/estimates");
  assert.deepEqual(await shownNumbers(page), ["DRAFT"]);
  await close(view);
});

await app.check("The estimate figures say so when they fail, and stay out of a list with nothing issued", async () => {
  let failing = true;
  const view = await open(
    "/c/acme/finance/estimates",
    estimateRoutes(() => (failing ? status(500) : ESTIMATE_STATS)),
  );
  await view.page.getByText("Couldn't load the estimate figures.").waitFor();
  failing = false;
  await view.click(view.page.getByRole("button", { name: "Try again" }));
  await panel(view.page, "Estimate figures").waitFor();
  await close(view);

  const drafts = ESTIMATES.filter((est) => est.status === "draft");
  const quiet = await open(
    "/c/acme/finance/estimates",
    estimateRoutes(() => ({ ...ESTIMATE_STATS, issuedEstimates: 0 }), drafts),
  );
  assert.deepEqual(await shownNumbers(quiet.page), ["DRAFT"]);
  assert.equal(await panel(quiet.page, "Estimate figures").count(), 0);
  await close(quiet);
});

// ───────────────────────────── phone and dark ─────────────────────────────

async function onScreen(target: Locator, label: string, width: number) {
  const box = await target.boundingBox();
  assert.ok(box, `${label} is drawn`);
  assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${label} fits (${box.x}, ${box.width})`);
  return box;
}

await app.check("On a phone, both panels stack, two tiles a row, and nothing scrolls sideways", async () => {
  for (const [path, routes, name, first, second, last] of [
    ["/c/acme/finance/invoices", invoiceRoutes(), "Invoice figures", "Overdue", "Due in the next 30 days", "Largest customer"],
    ["/c/acme/finance/estimates", estimateRoutes(), "Estimate figures", "Acceptance rate", "Expiring in 14 days", "Largest customer"],
  ] as const) {
    const view = await open(path, [...routes], { touch: true });
    const { page } = view;
    const figures = panel(page, name);
    await figures.waitFor();
    const width = page.viewportSize()!.width;
    await onScreen(figures, name, width);
    const a = await onScreen(tile(figures, first), first, width);
    const b = await onScreen(tile(figures, second), second, width);
    const c = await onScreen(tile(figures, last), last, width);
    assert.ok(Math.abs(a.y - b.y) < 1, `${first} and ${second} share a row`);
    assert.ok(c.width > a.width * 1.8, `${last}, the fifth tile, spans the row`);
    await noSidewaysScroll(page, `${name} on a phone`);
    await view.click(tile(figures, first));
    await page.locator('p[role="status"]').waitFor();
    await noSidewaysScroll(page, `${name}, filtered, on a phone`);
    await app.shot(page, `finance-stats-${name.split(" ")[0].toLowerCase()}-mobile`);
    await close(view);
  }
});

await app.check("In the dark, the panels are dark cards with legible figures", async () => {
  for (const [path, routes, name, firstLabel] of [
    ["/c/acme/finance/invoices", invoiceRoutes(), "Invoice figures", "Overdue"],
    ["/c/acme/finance/estimates", estimateRoutes(), "Estimate figures", "Acceptance rate"],
  ] as const) {
    const view = await open(path, [...routes], { scheme: "dark" });
    const { page } = view;
    const figures = panel(page, name);
    await figures.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), true);
    const card = await figures.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(card, "rgb(255, 255, 255)", `${name} is not a white card on a dark page`);
    const headline = await figures.locator("p.text-3xl").evaluate((el) => getComputedStyle(el).color);
    assert.notEqual(headline, "rgb(15, 23, 42)", "the headline is not dark ink on a dark card");
    const firstTile = tile(figures, firstLabel);
    const tileBackground = await firstTile.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(tileBackground, "rgb(255, 255, 255)", "the tiles are dark too");
    await view.click(firstTile);
    const selected = await firstTile.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(selected, "rgb(238, 242, 255)", "the pressed tile is not a light-mode wash");
    await page.locator('p[role="status"]').waitFor();
    await app.shot(page, `finance-stats-${name.split(" ")[0].toLowerCase()}-dark`);
    await close(view);
  }
});

// ─────────────────────────── recurring invoices ───────────────────────────

const SCHEDULE = {
  id: "ri-1",
  companyId: "company",
  customerId: ACME.id,
  subsidiaryId: null,
  slug: "acme-retainer",
  name: "Acme retainer",
  cronExpr: "0 9 1 * *",
  frequency: "monthly",
  intervalCount: 1,
  status: "active",
  daysUntilDue: 14,
  autoSend: true,
  currency: "USD",
  notes: "",
  footer: "",
  discountPercent: 0,
  discountAmountCents: 0,
  nextRunAt: "2026-11-01T09:00:00.000Z",
  lastRunAt: null,
  lastInvoiceSlug: "",
  runsCreated: 3,
  maxRuns: null,
  endsOn: null,
  archivedAt: null,
  createdById: "viewer",
  createdAt: hoursAgo(2000),
  updatedAt: hoursAgo(2000),
  customer: ACME,
  linesCount: 1,
  subtotalCents: 1_000_000,
  totalCents: 1_000_000,
  latestRun: null,
} as unknown as RecurringInvoiceListItem;

const METRICS: RecurringRevenueMetrics = {
  currency: "USD",
  arrCents: 12_000_000,
  mrrCents: 1_000_000,
  activeSchedules: 1,
  activeCustomers: 1,
  cadences: [{ frequency: "monthly", schedules: 1, arrCents: 12_000_000 }],
  largestCustomer: { id: ACME.id, name: ACME.name, slug: ACME.slug, arrCents: 12_000_000 },
  upcoming: { days: 30, invoices: 1, totalCents: 1_000_000 },
  paused: { schedules: 0, arrCents: 0 },
  ending: { days: 90, schedules: 0, arrCents: 0, firstEndsAt: null },
  converted: [],
  unconverted: [],
};

await app.check("Recurring invoices still lead with recurring revenue, in the shared panel", async () => {
  const view = await open("/c/acme/finance/recurring-invoices", [
    ["GET", `${API}/recurring-invoices/metrics`, () => METRICS],
    ["GET", `${API}/recurring-invoices`, () => [SCHEDULE]],
    ["GET", `${API}/finance/subsidiaries`, () => []],
  ]);
  const { page } = view;
  const figures = panel(page, "Recurring revenue");
  await figures.getByText("Annual recurring revenue").waitFor();
  assert.equal(await headline(figures), "$120,000");
  await figures.getByText("By billing cadence").waitFor();
  await figures.getByText(/a month · 1 active schedule · 1 customer/).waitFor();
  for (const label of ["Next 30 days", "Paused", "Ending in 90 days", "Largest customer"]) {
    await figures.getByText(label, { exact: true }).waitFor();
  }
  await figures.getByRole("link", { name: "Acme Corp" }).waitFor();
  assert.equal(await figures.getByRole("button").count(), 0, "its figures inform; they don't filter");
  await figures.getByText(/ARR is each active schedule's amount per invoice/).waitFor();
  await app.shot(page, "finance-stats-recurring-desktop");
  await close(view);
});

await app.finish();
