/**
 * Real Chrome coverage for New invoice's question — is this a one-time
 * invoice or a recurring invoice? — on the real App, against a deterministic
 * API: the question comes first, before any field, and takes focus without
 * picking an answer; each answer lands on its own form with the customer a
 * link named; switching mid-form keeps everything typed, both ways and back
 * again, and saves exactly what was carried; a customer the forms can't offer
 * is never swapped for another on the way; links that can only mean a
 * schedule skip the question; editing never offers the switch; and the
 * question and the switch work from the keyboard, on a phone and in the dark.
 * Run with `npm run test:invoice-kind`.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type {
  Customer,
  Invoice,
  Product,
  RecurringInvoice,
  Subsidiary,
  TaxRate,
} from "../client/lib/api";
import {
  API,
  gate,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  waitForFocus,
  type ApiRoute,
} from "./appFixture";

const app = await startApp("New invoice — one-time or recurring");

// ───────────────────────────── fixtures ─────────────────────────────

function customer(id: string, name: string, slug: string, currency: string): Customer {
  return {
    id,
    companyId: "company",
    name,
    slug,
    accountStatus: "customer",
    domain: `${slug}.example`,
    websiteUrl: "",
    industry: "",
    employeeCount: 0,
    headquartersAddress: "",
    parentCompanyName: "",
    parentCompanyDomain: "",
    ownerId: null,
    ownerEmployeeId: null,
    email: `ap@${slug}.example`,
    phone: "",
    billingAddress: "",
    shippingAddress: "",
    taxNumber: "",
    currency,
    annualContractValueCents: 0,
    notes: "",
    archivedAt: null,
    createdById: "viewer",
    createdAt: hoursAgo(900),
    updatedAt: hoursAgo(900),
    contacts: [],
  };
}

const ACME = customer("acct-acme", "Acme Corp", "acme-corp", "USD");
const GLOBEX = customer("acct-globex", "Globex", "globex", "EUR");

const VAT: TaxRate = {
  id: "tax-vat",
  companyId: "company",
  name: "VAT",
  ratePercent: 20,
  inclusive: false,
  archivedAt: null,
  createdAt: hoursAgo(900),
  updatedAt: hoursAgo(900),
};

const RETAINER: Product = {
  id: "product-retainer",
  companyId: "company",
  name: "Retainer",
  slug: "retainer",
  description: "Monthly",
  unitPriceCents: 880_000,
  currency: "USD",
  defaultTaxRateId: VAT.id,
  archivedAt: null,
  createdById: null,
  createdAt: hoursAgo(900),
  updatedAt: hoursAgo(900),
};

const EMEA: Subsidiary = {
  id: "sub-emea",
  companyId: "company",
  name: "Acme EMEA GmbH",
  address: "1 Platz der Republik, Berlin",
  country: "DE",
  taxNumber: "DE123456789",
  registrationNumber: "",
  email: "",
  phone: "",
  website: "",
  footer: "",
  archived: false,
  createdAt: hoursAgo(900),
  updatedAt: hoursAgo(900),
};

/** What both invoice forms, the lists and the palette ask for. */
const financeBase: ApiRoute[] = [
  ["GET", `${API}/customers`, () => [ACME, GLOBEX]],
  ["GET", `${API}/products`, () => [RETAINER]],
  ["GET", `${API}/tax-rates`, () => [VAT]],
  ["GET", `${API}/finance/subsidiaries`, () => [EMEA]],
  ["GET", `${API}/invoices`, () => []],
  ["GET", `${API}/recurring-invoices`, () => []],
  ["GET", `${API}/search`, () => ({ results: [] })],
  ["POST", `${API}/invoices`, ({ body }) => ({ ...body, id: "inv-new-id", slug: "inv-new" })],
  [
    "POST",
    `${API}/recurring-invoices`,
    ({ body }) => ({ ...body, id: "ri-new-id", slug: "ri-new" }),
  ],
];

/** What Globex's page asks for on its Billing tab. */
const globexPage: ApiRoute[] = [
  ["GET", `${API}/customers/globex`, () => GLOBEX],
  ["GET", `${API}/estimates`, () => []],
  ["GET", `${API}/credit-notes`, () => []],
  ["GET", `${API}/signature-envelopes`, () => []],
  ["GET", `${API}/members`, () => []],
  ["GET", `${API}/employees`, () => []],
  ["GET", `${API}/revenue/contacts`, () => ({ rows: [], total: 0 })],
  ["GET", `${API}/revenue/deals`, () => ({ rows: [], total: 0 })],
  ["GET", `${API}/revenue/activities`, () => ({ rows: [], total: 0 })],
];

const QUESTION = "Is this a one-time invoice or a recurring invoice?";

const question = (page: Page) => page.getByRole("heading", { name: QUESTION, exact: true });
const heading = (page: Page, name: string) =>
  page.getByRole("heading", { name, exact: true, level: 1 });
const answer = (page: Page, name: "One-time invoice" | "Recurring invoice") =>
  page.getByRole("link", { name, exact: true });
const kindGroup = (page: Page) => page.getByRole("group", { name: "Invoice type" });
const switchTo = (page: Page, name: "One-time" | "Recurring") =>
  kindGroup(page).getByRole("link", { name, exact: true });
const combobox = (page: Page, name: string) => page.getByRole("combobox", { name, exact: true });
const field = (page: Page, label: string | RegExp) =>
  page.getByLabel(label, typeof label === "string" ? { exact: true } : undefined);
const unavailable = (page: Page) =>
  page.getByText(
    "The customer you came from is archived or no longer exists. Choose who to bill.",
    {
      exact: true,
    },
  );

async function pick(page: Page, name: string, option: string | RegExp) {
  await combobox(page, name).click();
  await page.getByRole("option", { name: option }).first().click();
}

/** Wait for a field to show `expected`: the forms fill in a render after their data arrives. */
async function expectValue(locator: Locator, expected: string | RegExp, message?: string) {
  const deadline = Date.now() + 10_000;
  let current = await locator.inputValue();
  const ok = () => (typeof expected === "string" ? current === expected : expected.test(current));
  while (!ok() && Date.now() < deadline) {
    await locator.page().waitForTimeout(50);
    current = await locator.inputValue();
  }
  if (typeof expected === "string") assert.equal(current, expected, message);
  else assert.match(current, expected, message);
}

/** The kind the switch marks as this form's own. */
async function currentKind(page: Page): Promise<string> {
  return ((await kindGroup(page).locator('[aria-current="page"]').textContent()) ?? "").trim();
}

/** `locator` is laid out and entirely within a phone-width viewport. */
async function onPhoneScreen(locator: Locator, label: string, width = 390) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} is laid out`);
  assert.ok(
    box.x >= 0 && box.x + box.width <= width,
    `${label} fits a phone (${box.x}, ${box.width})`,
  );
  return box;
}

// ───────────────────────────── the question ─────────────────────────────

await app.check("New invoice on the Invoices list asks first, before any field", async () => {
  const view = await app.open({ path: "/c/acme/finance/invoices", routes: financeBase });
  const { page } = view;
  await view.click(page.getByRole("link", { name: "New invoice" }).first());
  await view.landedOn("/c/acme/finance/invoices/new");
  await heading(page, "New invoice").waitFor();
  await question(page).waitFor();
  assert.equal(
    await answer(page, "One-time invoice").getAttribute("href"),
    "/c/acme/finance/invoices/new?kind=one-time",
  );
  assert.equal(
    await answer(page, "Recurring invoice").getAttribute("href"),
    "/c/acme/finance/recurring-invoices/new",
  );
  // Nothing to fill in yet, and no answer picked for the person: the question
  // itself has focus, so a screen reader reads it out.
  assert.equal(await combobox(page, "Customer").count(), 0, "no form before the answer");
  assert.equal(await page.getByRole("button", { name: "Save draft" }).count(), 0);
  await waitForFocus(question(page), "the question has focus");
  await page.getByText("Picked the wrong one? Both forms have a switch at the top").waitFor();
  await app.shot(page, "invoice-kind-question-desktop");
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.check(
  "Recurring from a customer's New invoice lands on the recurring form with that customer",
  async () => {
    const view = await app.open({
      path: "/c/acme/customers/globex?tab=billing",
      routes: [...globexPage, ...financeBase],
    });
    const { page } = view;
    await view.click(page.getByRole("link", { name: "New invoice", exact: true }));
    await view.landedOn("/c/acme/finance/invoices/new?customerId=acct-globex");
    await question(page).waitFor();
    await page.getByText("For Globex, whichever you choose.", { exact: true }).waitFor();
    await app.shot(page, "invoice-kind-question-customer");
    await view.click(answer(page, "Recurring invoice"));
    await view.landedOn("/c/acme/finance/recurring-invoices/new?customerId=acct-globex");
    await heading(page, "New recurring invoice").waitFor();
    await expectValue(combobox(page, "Customer"), /^Globex — /, "the customer came along");
    await expectValue(field(page, "Currency"), "EUR");
    await expectValue(field(page, "Name"), "Globex", "named after the customer, as always");
    assert.equal(await currentKind(page), "Recurring");
    assert.equal(
      await switchTo(page, "One-time").getAttribute("href"),
      "/c/acme/finance/invoices/new?kind=one-time&customerId=acct-globex",
    );
    assert.equal(view.clicks(), 2, "New invoice, then Recurring");
    await page.close();
  },
);

await app.check(
  "One-time from a customer's link, chosen from the keyboard, opens the form with that customer",
  async () => {
    const view = await app.open({
      path: "/c/acme/finance/invoices/new?customerId=acct-globex",
      routes: financeBase,
    });
    const { page } = view;
    await waitForFocus(question(page), "the question has focus");
    await page.keyboard.press("Tab");
    await waitForFocus(answer(page, "One-time invoice"), "Tab reaches the first answer");
    await page.keyboard.press("ArrowRight");
    await waitForFocus(answer(page, "Recurring invoice"), "→ moves to the other answer");
    await page.keyboard.press("ArrowRight");
    await waitForFocus(answer(page, "One-time invoice"), "and wraps round");
    await page.keyboard.press("ArrowLeft");
    await waitForFocus(answer(page, "Recurring invoice"), "← goes back");
    await page.keyboard.press("ArrowUp");
    await waitForFocus(answer(page, "One-time invoice"), "↑ too");
    await page.keyboard.press("Enter");
    await view.landedOn("/c/acme/finance/invoices/new?kind=one-time&customerId=acct-globex");
    await heading(page, "New one-time invoice").waitFor();
    await expectValue(combobox(page, "Customer"), /^Globex — /, "the customer came along");
    await expectValue(field(page, "Currency"), "EUR");
    assert.equal(await currentKind(page), "One-time");
    assert.equal(
      await switchTo(page, "Recurring").getAttribute("href"),
      "/c/acme/finance/recurring-invoices/new?customerId=acct-globex",
    );
    assert.equal(view.clicks(), 0, "the keyboard alone");
    await page.close();
  },
);

// ───────────────────────────── switching ─────────────────────────────

await app.check(
  "Switching one-time → recurring → one-time → recurring keeps everything typed, and saves it",
  async () => {
    const view = await app.open({
      path: "/c/acme/finance/invoices/new?kind=one-time",
      routes: financeBase,
    });
    const { page } = view;
    await heading(page, "New one-time invoice").waitFor();
    await expectValue(combobox(page, "Customer"), /^Acme Corp — /, "the first customer to start");

    // Fill in the one-time invoice: every kind of field the two forms share.
    await pick(page, "Customer", /^Globex/);
    await expectValue(field(page, "Currency"), "EUR");
    await field(page, "Currency").fill("CHF");
    await pick(page, "Issued by", /^Acme EMEA GmbH/);
    await pick(page, "Line 1 product", "Retainer");
    await expectValue(field(page, "Line 1 unit price"), "8800.00");
    await field(page, "Line 1 description").fill("Monthly retainer\nOctober — strategy");
    await field(page, "Line 1 quantity").fill("2");
    await page.getByRole("button", { name: "Add line" }).click();
    await field(page, "Line 2 description").fill("Hosting");
    await field(page, "Line 2 unit price").fill("50.00");
    await pick(page, "Line 2 tax", /^VAT/);
    await page.getByRole("button", { name: "Add discount" }).click();
    await field(page, "Discount percentage").fill("10");
    await field(page, "Issue date").fill("2026-10-01");
    await field(page, "Due date").fill("2026-10-31");
    await field(page, /^Notes/).fill("Thanks for your business.");
    await field(page, /^Footer/).fill("IBAN DE00 0000");

    // It should have been a schedule: switch.
    await view.click(switchTo(page, "Recurring"));
    await view.landedOn("/c/acme/finance/recurring-invoices/new?customerId=acct-globex");
    await heading(page, "New recurring invoice").waitFor();
    await expectValue(combobox(page, "Customer"), /^Globex — /);
    await expectValue(field(page, "Currency"), "CHF", "a currency typed over the customer's");
    await expectValue(combobox(page, "Issued by"), /^Acme EMEA GmbH/);
    await expectValue(combobox(page, "Line 1 product"), "Retainer");
    await expectValue(
      field(page, "Line 1 description"),
      "Monthly retainer\nOctober — strategy",
      "a two-line description keeps its line break",
    );
    await expectValue(field(page, "Line 1 quantity"), "2");
    await expectValue(field(page, "Line 1 unit price"), "8800.00");
    await expectValue(combobox(page, "Line 1 tax"), /^VAT/);
    await expectValue(field(page, "Line 2 description"), "Hosting");
    await expectValue(field(page, "Line 2 unit price"), "50.00");
    await expectValue(combobox(page, "Line 2 tax"), /^VAT/);
    await expectValue(field(page, "Discount percentage"), "10");
    await expectValue(field(page, /^Notes/), "Thanks for your business.");
    await expectValue(field(page, /^Footer/), "IBAN DE00 0000");
    await expectValue(field(page, "Days until due"), "30", "the dates' payment terms");
    await expectValue(field(page, "Name"), "Globex");
    assert.equal(await currentKind(page), "Recurring");
    await app.shot(page, "invoice-kind-switched-to-recurring");

    // Set up the schedule, change the terms, and look at it as one-time again.
    await pick(page, "Frequency", "quarter");
    await field(page, "Name").fill("Globex retainer");
    await page.getByRole("checkbox", { name: /Auto-issue and email/ }).check();
    await field(page, "Max runs (optional)").fill("12");
    await field(page, "Days until due").fill("45");

    await view.click(switchTo(page, "One-time"));
    await view.landedOn("/c/acme/finance/invoices/new?kind=one-time&customerId=acct-globex");
    await heading(page, "New one-time invoice").waitFor();
    await expectValue(combobox(page, "Customer"), /^Globex — /);
    await expectValue(field(page, "Currency"), "CHF");
    await expectValue(combobox(page, "Issued by"), /^Acme EMEA GmbH/);
    await expectValue(field(page, "Line 1 description"), "Monthly retainer\nOctober — strategy");
    await expectValue(field(page, "Line 1 quantity"), "2");
    await expectValue(field(page, "Line 2 description"), "Hosting");
    await expectValue(field(page, "Discount percentage"), "10");
    await expectValue(field(page, /^Notes/), "Thanks for your business.");
    await expectValue(field(page, /^Footer/), "IBAN DE00 0000");
    await expectValue(field(page, "Issue date"), "2026-10-01", "the issue date comes back");
    await expectValue(field(page, "Due date"), "2026-11-15", "due 45 days later, as now agreed");
    assert.equal(await currentKind(page), "One-time");

    // And back: the schedule set up before is all still there.
    await view.click(switchTo(page, "Recurring"));
    await view.landedOn("/c/acme/finance/recurring-invoices/new?customerId=acct-globex");
    await heading(page, "New recurring invoice").waitFor();
    await expectValue(combobox(page, "Frequency"), "quarter");
    await expectValue(field(page, "Name"), "Globex retainer");
    assert.equal(
      await page.getByRole("checkbox", { name: /Auto-issue and email/ }).isChecked(),
      true,
    );
    await expectValue(field(page, "Max runs (optional)"), "12");
    await expectValue(field(page, "Days until due"), "45");
    await expectValue(field(page, "Line 2 description"), "Hosting");

    await page.getByRole("button", { name: "Create schedule", exact: true }).click();
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${API}/recurring-invoices`,
    );
    assert.equal(write.body.customerId, "acct-globex");
    assert.equal(write.body.subsidiaryId, "sub-emea");
    assert.equal(write.body.name, "Globex retainer");
    assert.equal(write.body.frequency, "quarterly");
    assert.equal(write.body.daysUntilDue, 45);
    assert.equal(write.body.autoSend, true);
    assert.equal(write.body.maxRuns, 12);
    assert.equal(write.body.currency, "CHF");
    assert.equal(write.body.notes, "Thanks for your business.");
    assert.equal(write.body.footer, "IBAN DE00 0000");
    assert.equal(write.body.discountPercent, 10);
    assert.deepEqual(
      (write.body.lines as Array<Record<string, unknown>>).map((line) => [
        line.description,
        line.quantity,
        line.unitPriceCents,
        line.taxRateId,
        line.productId,
      ]),
      [
        ["Monthly retainer\nOctober — strategy", 2, 880_000, VAT.id, RETAINER.id],
        ["Hosting", 1, 5_000, VAT.id, null],
      ],
    );
    await view.landedOn("/c/acme/finance/recurring-invoices/ri-new");
    assert.equal(view.clicks(), 3, "three switches, nothing typed twice");
    await page.close();
  },
);

await app.check(
  "Switching a customer's new schedule to one-time saves a one-time invoice with what was typed",
  async () => {
    const save = gate();
    const view = await app.open({
      path: "/c/acme/finance/recurring-invoices/new?customerId=acct-globex",
      routes: [
        [
          "POST",
          `${API}/invoices`,
          async ({ body }) => {
            await save.opened;
            return { ...body, id: "inv-new-id", slug: "inv-new" };
          },
        ],
        ...financeBase,
      ],
    });
    const { page } = view;
    // A customer's New recurring invoice can only mean a schedule: no question.
    await heading(page, "New recurring invoice").waitFor();
    assert.equal(await question(page).count(), 0);
    await expectValue(combobox(page, "Customer"), /^Globex — /);
    await field(page, "Line 1 description").fill("Onboarding workshop");
    await field(page, "Line 1 unit price").fill("1200.00");
    await field(page, "Days until due").fill("7");
    await field(page, /^Notes/).fill("See you on Monday.");

    await view.click(switchTo(page, "One-time"));
    await view.landedOn("/c/acme/finance/invoices/new?kind=one-time&customerId=acct-globex");
    await heading(page, "New one-time invoice").waitFor();
    await expectValue(combobox(page, "Customer"), /^Globex — /);
    await expectValue(field(page, "Line 1 description"), "Onboarding workshop");
    await expectValue(field(page, "Line 1 unit price"), "1200.00");
    await expectValue(field(page, /^Notes/), "See you on Monday.");
    // Issued today (the fixture's clock), due the 7 days the schedule said.
    await expectValue(field(page, "Issue date"), "2026-10-09");
    await expectValue(field(page, "Due date"), "2026-10-16");

    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const write = await view.waitForWrite(
      (w) => w.method === "POST" && w.path === `${API}/invoices`,
    );
    // While it saves, the switch holds still rather than leave mid-save.
    assert.equal(await switchTo(page, "Recurring").count(), 0, "no switch while saving");
    await kindGroup(page).locator('[aria-disabled="true"]').waitFor();
    save.open();
    assert.equal(write.body.customerId, "acct-globex");
    assert.equal(write.body.currency, "EUR");
    assert.equal(write.body.notes, "See you on Monday.");
    assert.match(String(write.body.issueDate), /^2026-10-09T/);
    assert.match(String(write.body.dueDate), /^2026-10-16T/);
    assert.deepEqual(
      (write.body.lines as Array<Record<string, unknown>>).map((line) => [
        line.description,
        line.quantity,
        line.unitPriceCents,
      ]),
      [["Onboarding workshop", 1, 120_000]],
    );
    await view.landedOn("/c/acme/finance/invoices/inv-new");
    await page.close();
  },
);

await app.check(
  "A customer the forms can't offer is never swapped for another, through the question or a switch",
  async () => {
    const view = await app.open({
      path: "/c/acme/finance/invoices/new?customerId=acct-gone",
      routes: financeBase,
    });
    const { page } = view;
    await question(page).waitFor();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByText(/whichever you choose/).count(), 0, "no name to show");
    await view.click(answer(page, "One-time invoice"));
    await view.landedOn("/c/acme/finance/invoices/new?kind=one-time&customerId=acct-gone");
    await unavailable(page).waitFor();
    await expectValue(combobox(page, "Customer"), "", "nobody, rather than the first customer");
    await field(page, "Line 1 description").fill("Consulting");

    await view.click(switchTo(page, "Recurring"));
    await view.landedOn("/c/acme/finance/recurring-invoices/new?customerId=acct-gone");
    await unavailable(page).waitFor();
    await expectValue(combobox(page, "Customer"), "", "still nobody after the switch");
    await expectValue(field(page, "Name"), "");
    await expectValue(field(page, "Line 1 description"), "Consulting");
    assert.equal(
      await page.getByRole("button", { name: "Create schedule", exact: true }).isDisabled(),
      true,
      "no customer, no schedule",
    );
    await page.close();
  },
);

// ───────────────────────────── other ways in ─────────────────────────────

await app.check(
  "The palette's New invoice asks first; New recurring invoice and New schedule go straight to a schedule",
  async () => {
    const view = await app.open({ path: "/c/acme/finance/invoices", routes: financeBase });
    const { page } = view;
    await heading(page, "Invoices").waitFor();

    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search" }).waitFor();
    await page.keyboard.type("new invoice");
    await page
      .getByRole("option", { name: /^New invoice/ })
      .first()
      .click();
    await view.landedOn("/c/acme/finance/invoices/new");
    await question(page).waitFor();

    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search" }).waitFor();
    await page.keyboard.type("new recurring invoice");
    await page
      .getByRole("option", { name: /^New recurring invoice/ })
      .first()
      .click();
    await view.landedOn("/c/acme/finance/recurring-invoices/new");
    await heading(page, "New recurring invoice").waitFor();
    assert.equal(await question(page).count(), 0);
    await page.close();

    const list = await app.open({
      path: "/c/acme/finance/recurring-invoices",
      routes: financeBase,
    });
    await list.click(list.page.getByRole("link", { name: "New schedule" }).first());
    await list.landedOn("/c/acme/finance/recurring-invoices/new");
    await heading(list.page, "New recurring invoice").waitFor();
    assert.equal(await question(list.page).count(), 0);
    await list.page.close();
  },
);

const DRAFT: Invoice = {
  id: "inv-7-id",
  companyId: "company",
  customerId: GLOBEX.id,
  subsidiaryId: null,
  issuerSnapshot: null,
  slug: "inv-7",
  numberSeq: 0,
  number: "",
  status: "draft",
  issueDate: "2026-10-01T00:00:00.000Z",
  dueDate: "2026-10-15T00:00:00.000Z",
  currency: "EUR",
  exchangeRate: null,
  subtotalCents: 10_000,
  discountPercent: 0,
  discountAmountCents: 0,
  discountCents: 0,
  taxCents: 0,
  totalCents: 10_000,
  paidCents: 0,
  creditedCents: 0,
  writtenOffCents: 0,
  balanceCents: 10_000,
  notes: "",
  footer: "",
  sentAt: null,
  paidAt: null,
  voidedAt: null,
  archivedAt: null,
  recurringInvoiceId: null,
  createdById: "viewer",
  createdAt: hoursAgo(48),
  updatedAt: hoursAgo(48),
  customer: { id: GLOBEX.id, name: GLOBEX.name, slug: GLOBEX.slug, email: GLOBEX.email },
  recurringInvoice: null,
  lines: [
    {
      id: "line-1",
      invoiceId: "inv-7-id",
      productId: null,
      description: "Audit",
      quantity: 1,
      unitPriceCents: 10_000,
      taxRateId: null,
      taxPercent: 0,
      lineSubtotalCents: 10_000,
      lineTaxCents: 0,
      lineTotalCents: 10_000,
      sortOrder: 0,
    },
  ],
  payments: [],
} as unknown as Invoice;

const SCHEDULE = {
  id: "ri-7-id",
  companyId: "company",
  customerId: GLOBEX.id,
  subsidiaryId: null,
  slug: "ri-7",
  name: "Globex support",
  cronExpr: "0 9 1 * *",
  frequency: "monthly",
  intervalCount: 1,
  status: "active",
  daysUntilDue: 14,
  autoSend: false,
  currency: "EUR",
  notes: "",
  footer: "",
  discountPercent: 0,
  discountAmountCents: 0,
  nextRunAt: "2026-11-01T09:00:00.000Z",
  lastRunAt: null,
  lastInvoiceSlug: "",
  runsCreated: 0,
  maxRuns: null,
  endsOn: null,
  archivedAt: null,
  createdById: null,
  createdAt: hoursAgo(48),
  updatedAt: hoursAgo(48),
  customer: { id: GLOBEX.id, name: GLOBEX.name, slug: GLOBEX.slug, email: GLOBEX.email },
  lines: [
    {
      id: "ri-line",
      recurringInvoiceId: "ri-7-id",
      productId: null,
      description: "Support",
      quantity: 1,
      unitPriceCents: 50_000,
      taxRateId: null,
      sortOrder: 0,
    },
  ],
  totalCents: 50_000,
  latestRun: null,
} as unknown as RecurringInvoice;

await app.check("Editing an invoice or a schedule offers no switch", async () => {
  const invoice = await app.open({
    path: "/c/acme/finance/invoices/inv-7/edit",
    routes: [["GET", `${API}/invoices/inv-7`, () => DRAFT], ...financeBase],
  });
  await heading(invoice.page, "Edit invoice").waitFor();
  await expectValue(field(invoice.page, "Line 1 description"), "Audit");
  assert.equal(await kindGroup(invoice.page).count(), 0, "an invoice stays an invoice");
  assert.equal(await question(invoice.page).count(), 0);
  await invoice.page.close();

  const schedule = await app.open({
    path: "/c/acme/finance/recurring-invoices/ri-7/edit",
    routes: [["GET", `${API}/recurring-invoices/ri-7`, () => SCHEDULE], ...financeBase],
  });
  await heading(schedule.page, "Edit schedule").waitFor();
  await expectValue(field(schedule.page, "Name"), "Globex support");
  assert.equal(await kindGroup(schedule.page).count(), 0, "a schedule stays a schedule");
  await schedule.page.close();
});

// ───────────────────────────── phone and dark ─────────────────────────────

await app.check("On a phone, the answers stack and the switch fits", async () => {
  const view = await app.open({
    path: "/c/acme/finance/invoices/new?customerId=acct-globex",
    routes: financeBase,
    touch: true,
  });
  const { page } = view;
  await question(page).waitFor();
  await page.getByText("For Globex, whichever you choose.", { exact: true }).waitFor();
  const oneTime = await onPhoneScreen(answer(page, "One-time invoice"), "One-time invoice");
  const recurring = await onPhoneScreen(answer(page, "Recurring invoice"), "Recurring invoice");
  assert.ok(recurring.y >= oneTime.y + oneTime.height, "the answers stack");
  await onPhoneScreen(question(page), "the question");
  await noSidewaysScroll(page, "the question on a phone");
  await app.shot(page, "invoice-kind-question-mobile");

  await view.click(answer(page, "One-time invoice"));
  await view.landedOn("/c/acme/finance/invoices/new?kind=one-time&customerId=acct-globex");
  await expectValue(combobox(page, "Customer"), /^Globex — /);
  await onPhoneScreen(kindGroup(page), "the switch on the one-time form");
  await onPhoneScreen(heading(page, "New one-time invoice"), "the one-time form's heading");
  await onPhoneScreen(page.getByRole("button", { name: "Save draft" }), "Save draft");
  await app.shot(page, "invoice-kind-one-time-mobile");

  await view.click(switchTo(page, "Recurring"));
  await view.landedOn("/c/acme/finance/recurring-invoices/new?customerId=acct-globex");
  await expectValue(combobox(page, "Customer"), /^Globex — /);
  await onPhoneScreen(kindGroup(page), "the switch on the recurring form");
  await onPhoneScreen(page.getByRole("button", { name: "Create schedule" }), "Create schedule");
  await app.shot(page, "invoice-kind-recurring-mobile");
  await page.close();
});

await app.check("In the dark, the question and the switch keep their contrast", async () => {
  const view = await app.open({
    path: "/c/acme/finance/invoices/new",
    routes: financeBase,
    scheme: "dark",
  });
  const { page } = view;
  await question(page).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    true,
  );
  const card = await answer(page, "Recurring invoice").evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  assert.notEqual(card, "rgb(255, 255, 255)", "the answers are not white cards on a dark page");
  await app.shot(page, "invoice-kind-question-dark");
  await view.click(answer(page, "One-time invoice"));
  await kindGroup(page).waitFor();
  await app.shot(page, "invoice-kind-one-time-dark");
  await page.close();
});

await app.finish();
