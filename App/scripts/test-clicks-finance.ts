/**
 * Real Chrome coverage for the shorter Finance, Explore and Bases flows, on
 * the real App: Add line puts the cursor in the new line's description (and
 * an edit page's lines never take it); a product's, vendor's or account's
 * name opens it; Add chart works on a dashboard without entering Edit mode;
 * ⌘/Ctrl+S saves a chart from its title, once; and in a Base, Add row opens
 * the new row's first cell for typing, Enter commits and hands focus back to
 * the cell, and Enter on a cell edits it again. Each flow counts its clicks.
 * Run with `npm run test:clicks-finance`.
 */
import assert from "node:assert/strict";
import type {
  Base,
  BaseField,
  BaseRecord,
  BaseTable,
  BaseTableContent,
  Customer,
  Product,
  Vendor,
} from "../client/lib/api";
import { API, NOW, hoursAgo, startApp, waitForFocus, type ApiRoute } from "./appFixture";

const app = await startApp("Fewer clicks — Finance, Explore and Bases");

// ───────────────────────────── Finance ─────────────────────────────

const ACME = {
  id: "acct-acme",
  companyId: "company",
  name: "Acme",
  slug: "acme",
  accountStatus: "customer",
  domain: "acme.example",
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
} as Customer;

const financeBase: ApiRoute[] = [
  ["GET", `${API}/customers`, () => [ACME]],
  ["GET", `${API}/products`, () => []],
  ["GET", `${API}/tax-rates`, () => []],
  ["GET", `${API}/finance/subsidiaries`, () => []],
];

await app.check("New invoice: Add line puts the cursor in the new line's description", async () => {
  const view = await app.open({ path: "/c/acme/finance/invoices/new", routes: financeBase });
  const { page } = view;
  const first = page.getByLabel("Line 1 description");
  await first.waitFor();
  assert.notEqual(
    await first.evaluate((el) => el === document.activeElement),
    true,
    "the line already there does not grab the cursor",
  );
  await view.click(page.getByRole("button", { name: "Add line" }));
  await waitForFocus(page.getByLabel("Line 2 description"), "the new line has the cursor");
  await page.keyboard.type("Onboarding workshop");
  assert.equal(await page.getByLabel("Line 2 description").inputValue(), "Onboarding workshop");
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.check("New recurring invoice: Add line puts the cursor in the new line", async () => {
  const view = await app.open({
    path: "/c/acme/finance/recurring-invoices/new",
    routes: financeBase,
  });
  const { page } = view;
  await page.getByLabel("Line 1 description").waitFor();
  await view.click(page.getByRole("button", { name: "Add line" }));
  await waitForFocus(page.getByLabel("Line 2 description"), "the new line has the cursor");
  await page.close();
});

const PRODUCT = {
  id: "product-seat",
  companyId: "company",
  name: "Seat licence",
  slug: "seat-licence",
  description: "One seat, billed monthly.",
  unitPriceCents: 4900,
  currency: "USD",
  defaultTaxRateId: null,
  archivedAt: null,
  createdAt: hoursAgo(300),
  updatedAt: hoursAgo(300),
} as unknown as Product;

await app.check("Products: the name opens it for editing — one click, not two", async () => {
  const view = await app.open({
    path: "/c/acme/finance/products",
    routes: [["GET", `${API}/products`, () => [PRODUCT]], ...financeBase],
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Seat licence" }));
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel("Name", { exact: true }).inputValue(), "Seat licence");
  assert.equal(view.clicks(), 1);
  await page.close();
});

const VENDOR = {
  id: "vendor-aws",
  companyId: "company",
  name: "Amazon Web Services",
  slug: "aws",
  email: "billing@aws.example",
  phone: "",
  address: "",
  taxNumber: "",
  currency: "USD",
  defaultExpenseAccountId: null,
  notes: "",
  archivedAt: null,
  createdAt: hoursAgo(300),
  updatedAt: hoursAgo(300),
} as unknown as Vendor;

await app.check("Vendors: a read-only Member's click on the name opens it to read", async () => {
  const view = await app.open({
    path: "/c/acme/finance/vendors",
    role: "member",
    company: { financeAccess: "read" },
    routes: [
      ["GET", `${API}/vendors`, () => [VENDOR]],
      ["GET", /\/finance\/accounts/, () => []],
      ["GET", `${API}/accounts`, () => []],
      ...financeBase,
    ],
  });
  const { page } = view;
  await view.click(page.getByRole("button", { name: "Amazon Web Services", exact: true }));
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(view.writes.length, 0, "opening a vendor to read changes nothing");
  assert.equal(view.clicks(), 1);
  await page.close();
});

// ───────────────────────────── Explore ─────────────────────────────

await app.check("Explore: Add chart works on a dashboard without entering Edit mode", async () => {
  const view = await app.open({
    path: "/c/acme/explore/dashboards/growth",
    routes: [
      [
        "GET",
        `${API}/explore/charts`,
        () => [
          {
            id: "chart-1",
            slug: "signups",
            title: "Signups",
            vizType: "line",
            updatedAt: hoursAgo(5),
          },
        ],
      ],
      [
        "GET",
        `${API}/explore/dashboards`,
        () => [
          { id: "dash-1", slug: "growth", title: "Growth", cardCount: 0, updatedAt: hoursAgo(5) },
        ],
      ],
      [
        "GET",
        `${API}/explore/dashboards/growth`,
        () => ({
          id: "dash-1",
          slug: "growth",
          title: "Growth",
          description: "",
          cards: [],
          charts: [],
        }),
      ],
      ["GET", `${API}/explore/connections`, () => []],
      ["GET", /\/tags/, () => []],
    ],
  });
  const { page } = view;
  const header = page.locator("header").filter({ hasText: "Growth" }).first();
  await view.click(header.getByRole("button", { name: "Add chart" }));
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Done" }).count(),
    0,
    "still out of Edit mode",
  );
  assert.equal(view.clicks(), 1);
  await page.close();
});

await app.check("Explore: ⌘/Ctrl+S in a chart's title saves it — once", async () => {
  const chart = {
    id: "chart-1",
    slug: "signups",
    title: "Signups",
    description: "",
    connectionId: "db",
    sql: "SELECT 1 AS value",
    vizType: "table",
    vizConfig: {},
    updatedAt: hoursAgo(5),
  };
  const view = await app.open({
    path: "/c/acme/explore/charts/signups",
    routes: [
      [
        "GET",
        `${API}/explore/charts`,
        () => [
          {
            id: "chart-1",
            slug: "signups",
            title: "Signups",
            vizType: "table",
            updatedAt: hoursAgo(5),
          },
        ],
      ],
      ["GET", `${API}/explore/dashboards`, () => []],
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
      ["GET", `${API}/explore/charts/signups`, () => chart],
      [
        "POST",
        `${API}/explore/run`,
        () => ({ columns: ["value"], rows: [{ value: 1 }], rowCount: 1 }),
      ],
      ["PATCH", `${API}/explore/charts/signups`, ({ body }) => ({ ...chart, ...body })],
      ["GET", /\/explore\/connections\/[^/]+\/schema/, () => ({ tables: [] })],
      ["GET", /\/tags/, () => []],
    ],
  });
  const { page } = view;
  const title = page.getByRole("textbox", { name: /title/i }).first();
  await title.waitFor();
  await title.fill("Weekly signups");
  await title.press("ControlOrMeta+s");
  const write = await view.waitForWrite(
    (w) => w.method === "PATCH" && w.path === `${API}/explore/charts/signups`,
  );
  assert.equal(write.body.title, "Weekly signups");
  await page.waitForTimeout(400);
  assert.equal(view.writes.filter((w) => w.method === "PATCH").length, 1, "one press, one save");
  assert.equal(view.clicks(), 0);
  await page.close();
});

// ───────────────────────────── Bases ─────────────────────────────

const BASE: Base = {
  id: "base-1",
  companyId: "company",
  name: "Hiring",
  slug: "hiring",
  description: "",
  icon: "users",
  color: "indigo",
  createdById: "viewer",
  createdAt: hoursAgo(100),
} as Base;
const TABLE: BaseTable = {
  id: "table-1",
  baseId: BASE.id,
  name: "Candidates",
  slug: "candidates",
  sortOrder: 0,
  archivedAt: null,
  createdAt: hoursAgo(100),
};
const NAME: BaseField = {
  id: "field-name",
  tableId: TABLE.id,
  name: "Name",
  type: "text",
  config: {},
  isPrimary: true,
  sortOrder: 0,
};

await app.check(
  "Bases: Add row opens its first cell for typing; Enter saves and focus comes back",
  async () => {
    const records: BaseRecord[] = [];
    const content = (): BaseTableContent => ({
      table: TABLE,
      fields: [NAME],
      records: records.map((r) => ({ ...r, data: { ...r.data } })),
      linkOptions: {},
      resourceOptions: {},
      views: [],
    });
    const view = await app.open({
      path: "/c/acme/bases/hiring/candidates",
      routes: [
        ["GET", `${API}/bases`, () => [BASE]],
        ["GET", `${API}/bases/hiring`, () => ({ base: BASE, tables: [TABLE] })],
        ["GET", `${API}/bases/hiring/tables/table-1/rows`, () => content()],
        [
          "POST",
          `${API}/bases/hiring/tables/table-1/rows`,
          () => {
            const row: BaseRecord = {
              id: `row-${records.length + 1}`,
              tableId: TABLE.id,
              data: {},
              sortOrder: records.length,
              createdAt: NOW.toISOString(),
              updatedAt: NOW.toISOString(),
            };
            records.push(row);
            return row;
          },
        ],
        [
          "PATCH",
          /\/bases\/hiring\/tables\/table-1\/rows\/([^/]+)$/,
          ({ match, body }) => {
            const row = records.find((r) => r.id === match[1])!;
            row.data[String(body.fieldId)] = body.value;
            return row;
          },
        ],
        ["GET", /\/bases\/hiring\/(grants|forms|views)/, () => []],
        ["GET", `${API}/employees`, () => []],
        ["GET", /\/tags/, () => []],
      ],
    });
    const { page } = view;
    await view.click(page.getByRole("button", { name: "Add row" }));
    const cell = page.getByRole("textbox", { name: "Name" });
    await waitForFocus(cell, "the new row's Name cell is open with the cursor in it");
    await page.keyboard.type("Ada Lovelace");
    await page.keyboard.press("Enter");
    const write = await view.waitForWrite((w) => w.method === "PATCH");
    assert.deepEqual(write.body, { fieldId: "field-name", value: "Ada Lovelace" });
    const gridCell = page.getByRole("cell", { name: "Ada Lovelace" });
    await waitForFocus(gridCell, "focus returns to the cell, not <body>");
    // Enter edits the focused cell again, without a click.
    await page.keyboard.press("Enter");
    await waitForFocus(page.getByRole("textbox", { name: "Name" }), "Enter reopens the editor");
    await page.keyboard.press("Escape");
    assert.equal(view.clicks(), 1, "Add row — then the keyboard");
    await page.close();
  },
);

await app.finish();
