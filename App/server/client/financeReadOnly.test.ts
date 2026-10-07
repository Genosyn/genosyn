import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every Finance page that can change finances asks `canWriteFinance` first,
 * and so does every Customers page that can change a customer, since the
 * finance routes write customers too.
 *
 * `client/pages/FinanceReadOnly.test.ts` and `CustomersReadOnly.test.ts`
 * render what a page draws before its data arrives. What it draws afterwards
 * — a row's menu, an invoice's Send and Void, Record payment, a proposal's
 * Apply, a customer's Edit — exists only once a request has come back, which
 * server rendering never waits for. So the rule is held here, at the source:
 * a page that sends a finance write, or links to a form that does, must
 * consult `canWriteFinance(company)`, the client's copy of the server's
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
 * A Customers page's write to the finance routes, which serve customers and
 * their contacts. Told apart by its path, because the same pages also upload
 * contracts, which `routes/contracts.ts` gates on no finance level.
 */
const CUSTOMER_WRITE = /\bapi\.(?:post|patch|put|del)\b(?:<[^>]*>)?\(\s*`[^`]*\/customers\b/;
/**
 * A Customers page's link into a form that needs Full access: a customer's,
 * or one of Finance's. A signature request is no finance write.
 */
const CUSTOMER_FORM_LINK = /(?<!\/signatures)\/(?:new|edit)`/;

function readPages(pattern: RegExp, layout: string): { file: string; source: string }[] {
  return fs
    .readdirSync(pagesDir)
    .filter((file) => pattern.test(file) && file !== layout)
    .map((file) => ({ file, source: fs.readFileSync(path.join(pagesDir, file), "utf8") }));
}

function financePages(): { file: string; source: string }[] {
  return readPages(/^Finance.*\.tsx$/, "FinanceLayout.tsx");
}

function customerPages(): { file: string; source: string }[] {
  return readPages(/^Customers?[A-Z].*\.tsx$/, "CustomersLayout.tsx");
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

describe("Customers pages and read-only access", () => {
  test("ask canWriteFinance wherever they can change a customer or open a form that does", () => {
    const writers = customerPages().filter(
      ({ source }) => CUSTOMER_WRITE.test(source) || CUSTOMER_FORM_LINK.test(source),
    );
    // Guard the guard: a pattern that stopped matching would pass vacuously.
    for (const file of ["CustomersIndex.tsx", "CustomerDetail.tsx", "CustomerNew.tsx"]) {
      assert.ok(
        writers.some((page) => page.file === file),
        `${file} is no longer recognized as changing customers`,
      );
    }
    for (const { file, source } of writers) {
      assert.match(
        source,
        ASKS,
        `${file} changes customers through the finance routes, so it must offer each ` +
          "change only when canWriteFinance(company) is true — a read-only Member's request is refused",
      );
    }
  });

  test("leave a customer's contracts open to read-only Members", () => {
    // The contracts panel writes, but only through `routes/contracts.ts`,
    // which gates on no finance level, so it isn't held to the rule above…
    const panel = customerPages().find(({ file }) => file === "CustomerContractsPanel.tsx");
    assert.ok(panel, "a customer's contracts are changed in CustomerContractsPanel.tsx");
    assert.match(panel.source, WRITE);
    assert.doesNotMatch(panel.source, CUSTOMER_WRITE);
    assert.doesNotMatch(panel.source, CUSTOMER_FORM_LINK);
    // …and must not hide behind it either: Upload contract, Edit, and Delete
    // stay for a Member whose finance access is read-only.
    assert.doesNotMatch(panel.source, /\bcanWriteFinance\b|\beffectiveFinanceAccess\b/);
  });
});
