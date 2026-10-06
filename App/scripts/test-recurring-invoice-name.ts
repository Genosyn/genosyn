/**
 * Real Chrome coverage for a recurring invoice's Name defaulting to its
 * customer: the pre-fill, following the customer until the person types,
 * clearing, saving blank, arriving from a customer's link, a link to a
 * customer the form cannot offer, and editing an existing schedule. The APIs
 * are deterministic fixtures.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(root, "../output/playwright");
const fixture = await startBrowserFixture("recurringInvoiceFormHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await context.newPage();
const pageErrors: string[] = [];
const unhandled: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.setDefaultTimeout(20_000);

function customer(id: string, name: string, currency: string, domain = "", email = "") {
  return {
    id,
    companyId: "company",
    name,
    slug: id,
    accountStatus: "customer",
    domain,
    websiteUrl: "",
    industry: "",
    employeeCount: 0,
    headquartersAddress: "",
    parentCompanyName: "",
    parentCompanyDomain: "",
    ownerId: null,
    ownerEmployeeId: null,
    email,
    phone: "",
    billingAddress: "",
    shippingAddress: "",
    taxNumber: "",
    currency,
    annualContractValueCents: 0,
    notes: "",
    archivedAt: null,
    createdById: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    contacts: [],
  };
}

const HYPHEN = "SMC Partners LLC, d/b/a Hyphen";
const customers = [
  customer("c-hyphen", HYPHEN, "USD", "hyphen.example", "ap@hyphen.example"),
  customer("c-beta", "Beta Industries", "EUR", "beta.example"),
  customer("c-gamma", "Gamma GmbH", "CHF", "", "billing@gamma.example"),
];
const existing = {
  id: "ri-existing-id",
  companyId: "company",
  customerId: "c-hyphen",
  subsidiaryId: null,
  slug: "ri-existing",
  name: "Quarterly support — Hyphen",
  cronExpr: "0 9 1 1,4,7,10 *",
  frequency: "quarterly",
  intervalCount: 1,
  status: "active",
  daysUntilDue: 30,
  autoSend: false,
  currency: "USD",
  notes: "",
  footer: "",
  nextRunAt: "2027-01-01T09:00:00.000Z",
  lastRunAt: null,
  lastInvoiceSlug: "",
  runsCreated: 0,
  maxRuns: null,
  endsOn: null,
  createdById: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  customer: { id: "c-hyphen", name: HYPHEN, slug: "c-hyphen", email: "ap@hyphen.example" },
  lines: [
    {
      id: "line",
      recurringInvoiceId: "ri-existing-id",
      productId: null,
      description: "Quarterly support",
      quantity: 1,
      unitPriceCents: 90_000,
      taxRateId: null,
      sortOrder: 0,
    },
  ],
  totalCents: 90_000,
  latestRun: null,
};
const created: Array<Record<string, unknown>> = [];
const edited: Array<Record<string, unknown>> = [];

await context.route("**/api/**", async (route) => {
  const request = route.request();
  const { pathname } = new URL(request.url());
  const method = request.method();
  const base = "/api/companies/company";
  if (method === "GET" && pathname === `${base}/customers`) return route.fulfill({ json: customers });
  if (method === "GET" && pathname === `${base}/products`) return route.fulfill({ json: [] });
  if (method === "GET" && pathname === `${base}/tax-rates`) return route.fulfill({ json: [] });
  if (method === "GET" && pathname === `${base}/finance/subsidiaries`) {
    return route.fulfill({ json: [] });
  }
  if (method === "POST" && pathname === `${base}/recurring-invoices`) {
    const body = request.postDataJSON() as Record<string, unknown>;
    created.push(body);
    return route.fulfill({ json: { ...existing, ...body, slug: `ri-new-${created.length}` } });
  }
  if (pathname === `${base}/recurring-invoices/ri-existing`) {
    if (method === "GET") return route.fulfill({ json: existing });
    if (method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      edited.push(body);
      return route.fulfill({ json: { ...existing, ...body } });
    }
  }
  unhandled.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unhandled ${method} ${pathname}` } });
});

const nameField = (p: Page) => p.getByLabel("Name", { exact: true });
const customerField = (p: Page) => p.getByRole("combobox", { name: "Customer", exact: true });
const currencyField = (p: Page) => p.getByLabel("Currency", { exact: true });
const createButton = (p: Page) => p.getByRole("button", { name: "Create schedule", exact: true });
const blankHint = (p: Page) => p.getByText("Leave blank to use the customer's name.", { exact: true });
const unavailableNotice = (p: Page) =>
  p.getByText("The customer you came from is archived or no longer exists. Choose who to bill.", {
    exact: true,
  });

async function open(p: Page, appPath: string) {
  await p.goto(`${fixture.origin}/?path=${encodeURIComponent(appPath)}`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  });
}

async function pickCustomer(p: Page, name: string) {
  await customerField(p).click();
  const startsWith = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  await p.getByRole("option", { name: startsWith }).click();
}

/** Wait for the Name field to settle on `value`; the form updates it a render later. */
async function expectName(p: Page, value: string, message: string) {
  const deadline = Date.now() + 10_000;
  let current = await nameField(p).inputValue();
  while (current !== value && Date.now() < deadline) {
    await p.waitForTimeout(50);
    current = await nameField(p).inputValue();
  }
  assert.equal(current, value, message);
}

async function landedOn(p: Page, appPath: string) {
  await p.getByText(`Opened ${appPath}`, { exact: true }).waitFor();
}

async function fillFirstLine(p: Page) {
  await p.getByPlaceholder("Description", { exact: true }).fill("Monthly retainer");
}

const PHONE_WIDTH = 390;

/** The element is laid out and entirely within a phone-width viewport. */
async function onScreen(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} is laid out`);
  assert.ok(box.x >= 0 && box.x + box.width <= PHONE_WIDTH, `${label} fits a phone`);
  return box;
}

try {
  // A new schedule opens named after the first customer.
  await open(page, "/c/acme/finance/recurring-invoices/new");
  await expectName(page, HYPHEN, "the Name is pre-filled with the customer's name");
  assert.match(await customerField(page).inputValue(), /^SMC Partners LLC, d\/b\/a Hyphen — /);
  assert.equal(await nameField(page).getAttribute("maxlength"), "200");
  assert.equal(await nameField(page).getAttribute("required"), null);
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "recurring-invoice-name-desktop.png") });

  // Until the person types, the Name follows the customer.
  await pickCustomer(page, "Beta Industries");
  await expectName(page, "Beta Industries", "the Name follows a customer change");
  assert.equal(await currencyField(page).inputValue(), "EUR");
  await pickCustomer(page, "Gamma GmbH");
  await expectName(page, "Gamma GmbH", "the Name keeps following");

  // A typed name is the person's: changing the customer leaves it alone.
  await nameField(page).fill("Gamma platform licence");
  await pickCustomer(page, "Beta Industries");
  await expectName(page, "Gamma platform licence", "a typed name survives a customer change");
  await pickCustomer(page, "SMC Partners");
  await expectName(page, "Gamma platform licence", "and another");

  // Clearing hands the name back: the field stays empty, says what blank means,
  // and the next customer change fills it in.
  await nameField(page).fill("");
  await blankHint(page).waitFor();
  assert.equal(await nameField(page).getAttribute("placeholder"), HYPHEN);
  assert.equal(await nameField(page).inputValue(), "", "clearing is never refilled mid-edit");
  await pickCustomer(page, "Beta Industries");
  await expectName(page, "Beta Industries", "a cleared Name follows the next customer");
  await blankHint(page).waitFor({ state: "hidden" });

  // Saved blank, the schedule takes the customer's name.
  await fillFirstLine(page);
  await nameField(page).fill("   ");
  assert.equal(await createButton(page).isDisabled(), false, "a blank Name never blocks saving");
  await createButton(page).click();
  await landedOn(page, "/c/acme/finance/recurring-invoices/ri-new-1");
  assert.equal(created.length, 1);
  assert.equal(created[0].name, "Beta Industries");
  assert.equal(created[0].customerId, "c-beta");
  assert.equal(created[0].currency, "EUR");

  // A link from a customer's page opens the form with that customer and its name.
  await open(page, "/c/acme/customers/c-gamma");
  await page.getByRole("link", { name: "New recurring invoice", exact: true }).click();
  await expectName(page, "Gamma GmbH", "arriving with a customer shows its name at once");
  assert.match(await customerField(page).inputValue(), /^Gamma GmbH — /);
  assert.equal(await currencyField(page).inputValue(), "CHF");
  await nameField(page).fill("Gamma annual licence");
  await fillFirstLine(page);
  await createButton(page).click();
  await landedOn(page, "/c/acme/finance/recurring-invoices/ri-new-2");
  assert.equal(created[1].name, "Gamma annual licence");
  assert.equal(created[1].customerId, "c-gamma");

  // A link to a customer the form cannot offer picks nobody rather than the wrong account.
  await open(page, "/c/acme/finance/recurring-invoices/new?customerId=c-archived");
  await unavailableNotice(page).waitFor();
  assert.equal(await customerField(page).inputValue(), "");
  assert.equal(await nameField(page).inputValue(), "");
  await fillFirstLine(page);
  assert.equal(await createButton(page).isDisabled(), true, "no customer, no schedule");
  await pickCustomer(page, "Beta Industries");
  await expectName(page, "Beta Industries", "picking a customer names the schedule");
  await unavailableNotice(page).waitFor({ state: "hidden" });
  assert.equal(await createButton(page).isDisabled(), false);

  // Editing keeps the saved name, whatever the customer becomes.
  await open(page, "/c/acme/finance/recurring-invoices/ri-existing/edit");
  await expectName(page, "Quarterly support — Hyphen", "an existing schedule keeps its name");
  await pickCustomer(page, "Gamma GmbH");
  await expectName(page, "Quarterly support — Hyphen", "changing the customer never renames it");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await landedOn(page, "/c/acme/finance/recurring-invoices/ri-existing");
  assert.equal(edited.length, 1);
  assert.equal(edited[0].name, "Quarterly support — Hyphen");
  assert.equal(edited[0].customerId, "c-gamma");

  // On a phone the Name and Customer fields stack, and they and their notes
  // stay on screen even with the longest customer label. (The header buttons
  // and line-item table predate this change and are not measured here.)
  await page.setViewportSize({ width: PHONE_WIDTH, height: 844 });
  await open(page, "/c/acme/finance/recurring-invoices/new?customerId=c-hyphen");
  await expectName(page, HYPHEN, "the linked customer's name on a phone");
  await nameField(page).fill("");
  await blankHint(page).waitFor();
  const nameBox = await onScreen(nameField(page), "Name");
  const customerBox = await onScreen(customerField(page), "Customer");
  await onScreen(blankHint(page), "blank-name hint");
  assert.ok(customerBox.y > nameBox.y + nameBox.height, "Customer stacks under Name");
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({
    path: path.join(artifacts, "recurring-invoice-name-mobile.png"),
    fullPage: true,
  });
  await open(page, "/c/acme/finance/recurring-invoices/new?customerId=c-archived");
  await unavailableNotice(page).waitFor();
  await onScreen(unavailableNotice(page), "unavailable-customer notice");
  await onScreen(customerField(page), "empty Customer");
  await page.screenshot({
    path: path.join(artifacts, "recurring-invoice-unavailable-customer-mobile.png"),
    fullPage: true,
  });

  assert.deepEqual(unhandled, []);
  assert.deepEqual(pageErrors, []);
  console.log(
    "Recurring invoice name browser checks passed: customer-name pre-fill, following until typed, clearing and saving blank, customer links, unavailable customer, edit never renames, mobile layout.",
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
