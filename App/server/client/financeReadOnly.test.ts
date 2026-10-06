import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Every Finance page that can change finances asks `canWriteFinance` first.
 *
 * `client/pages/FinanceReadOnly.test.ts` renders what a page draws before its
 * data arrives. What it draws afterwards — a row's menu, an invoice's Send and
 * Void, Record payment, a proposal's Apply — exists only once a request has
 * come back, which server rendering never waits for. So the rule is held here,
 * at the source: a Finance page that sends a write, or links to a form that
 * does, must consult `canWriteFinance(company)`, the client's copy of the
 * server's `requireFinanceWrite`. Lint fails a `canWrite` that is never read,
 * so consulting it means using it.
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
  "FinanceSubsidiaries.tsx": /canManage = company\.role === "owner" \|\| company\.role === "admin"/,
};

function financePages(): { file: string; source: string }[] {
  return fs
    .readdirSync(pagesDir)
    .filter((file) => /^Finance.*\.tsx$/.test(file) && file !== "FinanceLayout.tsx")
    .map((file) => ({ file, source: fs.readFileSync(path.join(pagesDir, file), "utf8") }));
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
