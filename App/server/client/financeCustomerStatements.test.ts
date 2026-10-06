import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { activeSection } from "../../client/lib/sections.js";
import { railSubpages } from "../../client/lib/subpages.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readAppFile(relativePath: string): string {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

describe("Finance customer statements", () => {
  test("mounts chooser and customer routes inside Finance", () => {
    const app = readAppFile("client/App.tsx");

    assert.match(app, /path="customer-statements" element={<FinanceCustomerStatements \/>}/);
    assert.match(app, /path="customer-statements\/:customerSlug"/);
    assert.match(
      app,
      /path=":customerSlug\/statement" element={<CustomerStatement \/>}/,
      "the original Customers entry point must remain available",
    );
    assert.equal(activeSection("/c/acme/finance/customer-statements/acme-corp"), "finance");
  });

  test("puts a discoverable statement link beside receivables", () => {
    // The Finance rail draws its links from the subpage catalogue, in order.
    assert.match(
      readAppFile("client/pages/FinanceLayout.tsx"),
      /<SectionRailLinks section="finance"/,
    );
    const rail = railSubpages("finance");
    const labels = rail.map((page) => page.navLabel ?? page.label);
    const invoices = labels.indexOf("Invoices");
    const statements = labels.indexOf("Customer statements");
    const creditNotes = labels.indexOf("Credit notes");

    assert.ok(invoices >= 0, "Finance must retain its Invoices link");
    assert.ok(statements > invoices, "Customer statements must follow Invoices");
    assert.ok(creditNotes > statements, "Customer statements must precede Credit notes");
    assert.equal(rail[statements].path, "/finance/customer-statements");
  });

  test("uses one shared statement view with Finance-specific navigation", () => {
    const chooser = readAppFile("client/pages/FinanceCustomerStatements.tsx");
    const statement = readAppFile("client/pages/CustomerStatement.tsx");

    assert.match(chooser, /customers\?archived=true/);
    assert.match(chooser, /searchPlaceholder="Search customers…"/);
    assert.match(chooser, /key={customerSlug}/);
    assert.match(chooser, /surface="finance"/);
    assert.match(statement, /surface === "finance"/);
    assert.match(statement, /label: "Customer statements", to: statementsUrl/);
    assert.match(statement, /to={backUrl}/);
    assert.match(statement, /to={`\$\{financeUrl}\/invoices\/\$\{t\.invoiceSlug}`}/);
  });
});
