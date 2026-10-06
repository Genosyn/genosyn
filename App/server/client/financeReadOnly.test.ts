import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every Finance page that can change finances asks `canWriteFinance` first,
 * and so does every Customer page that can change a customer.
 *
 * `client/pages/FinanceReadOnly.test.ts` and `client/pages/closedPages.test.ts`
 * render what a page draws before its data arrives. What it draws afterwards —
 * a row's menu, an invoice's Send and Void, Record payment, a proposal's Apply,
 * a customer's Edit — exists only once a request has come back, which server
 * rendering never waits for. So the rule is held here, at the source: a page
 * that sends a write, or links to a form that does, must consult
 * `canWriteFinance(company)`, the client's copy of the server's
 * `requireFinanceWrite`. Lint fails a `canWrite` that is never read, so
 * consulting it means using it.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pagesDir = path.join(appRoot, "client/pages");

/** A write the finance routes would refuse a read-only Member. */
const WRITE = /\bapi\.(?:post|patch|put|del)\b|\bfinanceSubsidiaries\.(?:create|update)\b/;
/** A link or redirect into a create or edit form. */
const FORM_LINK = /\/(?:new|edit)`/;
const ASKS = /\bcanWriteFinance\(company\)/;

/**
 * Pages held to a stricter rule than Full access, with the line that applies
 * it. Owners and admins always have Full, so an owner-or-admin gate already
 * keeps every read-only Member out.
 */
const STRICTER: Record<string, RegExp> = {
  "FinanceAiAccess.tsx": /canManage = company\.role === "owner" \|\| company\.role === "admin"/,
  "FinanceSubsidiaries.tsx": /canManage = company\.role === "owner" \|\| company\.role === "admin"/,
};

/**
 * Customers is its own section, but the finance router answers every
 * `/customers…` path, so the list, a customer's overview, and its New and
 * Edit forms follow finance access. The section also holds contracts,
 * signature requests, files, and custom fields, whose routes finance access
 * doesn't gate and which stay open to every Member. So a Customer page is held
 * to the rule only where it reaches the finance routes: a write to a customer,
 * or a link to a form that saves one — a customer's New or Edit, or Finance's
 * own, like the Billing tab's New invoice.
 */
const CUSTOMER_WRITE =
  /\bapi\.(?:post|patch|put|del)\b[^`;]*`\/api\/companies\/\$\{[^}]+\}\/customers\b/;
const FINANCE_FORM_LINK = /`[^`]*(?:customers|finance)[^`]*\/(?:new|edit)`|\bnewRecurringInvoicePath\(/;

function pagesNamed(name: RegExp): { file: string; source: string }[] {
  return fs
    .readdirSync(pagesDir)
    .filter((file) => name.test(file))
    .map((file) => ({ file, source: fs.readFileSync(path.join(pagesDir, file), "utf8") }));
}

function financePages(): { file: string; source: string }[] {
  return pagesNamed(/^Finance.*\.tsx$/).filter(({ file }) => file !== "FinanceLayout.tsx");
}

/** The Customers section's pages and the panels they're built from. */
function customerPages(): { file: string; source: string }[] {
  return pagesNamed(/^Customers?[A-Z].*\.tsx$/);
}

describe("Finance pages and read-only access", () => {
  test("ask canWriteFinance wherever they can change finances or open a form that does", () => {
    const pages = financePages().filter(
      ({ source }) => WRITE.test(source) || FORM_LINK.test(source),
    );
    // Guard the guard: a pattern that stopped matching would pass vacuously.
    assert.ok(pages.length >= 25, `found only ${pages.length} Finance pages that write`);
    for (const { file, source } of pages) {
      const stricter = STRICTER[file];
      if (stricter) {
        assert.match(source, stricter, `${file} must keep its owner-and-admin gate`);
        continue;
      }
      assert.match(
        source,
        ASKS,
        `${file} changes finances, so it must offer each change only when ` +
          "canWriteFinance(company) is true — a read-only Member's request is refused",
      );
    }
  });
});

describe("Customer pages and read-only access", () => {
  test("ask canWriteFinance wherever they can change a customer or open a form that does", () => {
    const pages = customerPages().filter(
      ({ source }) => CUSTOMER_WRITE.test(source) || FINANCE_FORM_LINK.test(source),
    );
    // Guard the guard: the list (New customer, the row menu), the overview
    // (Edit, the Billing tab's New links), and the New and Edit form itself.
    const found = pages.map(({ file }) => file);
    for (const file of ["CustomersIndex.tsx", "CustomerDetail.tsx", "CustomerNew.tsx"]) {
      assert.ok(found.includes(file), `${file} should be found changing customers`);
    }
    for (const { file, source } of pages) {
      assert.match(
        source,
        ASKS,
        `${file} changes customers, or links to a form that does, through the finance ` +
          "routes, so it must offer each change only when canWriteFinance(company) is " +
          "true — a read-only Member's request is refused",
      );
    }
  });

  test("leave contracts, which every Member may change, out of it", () => {
    const [panel] = customerPages().filter(({ file }) => file === "CustomerContractsPanel.tsx");
    assert.ok(panel, "a customer's contracts are changed in CustomerContractsPanel.tsx");
    // It writes, but only through the contracts router, which no finance gate
    // guards…
    assert.match(panel.source, WRITE);
    assert.doesNotMatch(panel.source, CUSTOMER_WRITE);
    assert.doesNotMatch(panel.source, FINANCE_FORM_LINK);
    // …so a read-only Member keeps Upload contract, Edit, and Delete.
    assert.doesNotMatch(panel.source, /\bcanWriteFinance\b|\beffectiveFinanceAccess\b/);
  });
});
