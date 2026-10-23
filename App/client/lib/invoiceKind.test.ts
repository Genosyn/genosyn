import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { requestedCustomerPick } from "./customerPick.js";
import { NO_DISCOUNT_DRAFT } from "./discountForm.js";
import {
  addDays,
  DEFAULT_PAYMENT_TERMS_DAYS,
  draftCustomerRequest,
  draftFromOneTimeInvoice,
  draftFromRecurringInvoice,
  INVOICE_KIND_PARAM,
  INVOICE_KINDS,
  invoiceDraftState,
  invoiceKindPath,
  isDateOnly,
  newInvoicePath,
  newInvoiceStep,
  newOneTimeInvoicePath,
  oneTimeDatesFromDraft,
  oneTimeInvoiceFromDraft,
  readInvoiceDraft,
  recurringInvoiceFromDraft,
  switchInvoiceKindPath,
  type InvoiceDraft,
  type InvoiceDraftLine,
  type OneTimeInvoiceFields,
  type RecurringInvoiceFields,
} from "./invoiceKind.js";
import {
  newRecurringInvoicePath,
  recurringInvoiceFromDocumentPath,
  requestedRecurringInvoiceSource,
} from "./recurringInvoiceForm.js";
import { defaultScheduleParts } from "./schedule.js";
import { PALETTE_SUBPAGES } from "./subpages.js";

const base = "/c/acme/finance";
const globex = { id: "c-globex", name: "Globex", domain: "globex.example", email: "" };
const acme = { id: "c-acme", name: "Acme Corp", domain: "acme.example", email: "" };

/** A line as a form holds it, row key and all. */
function row(description: string, changes: Partial<InvoiceDraftLine> = {}) {
  const line: InvoiceDraftLine & { key: string } = {
    key: `key-${description}`,
    productId: null,
    description,
    quantityText: "1",
    priceText: "0.00",
    taxRateId: "",
    ...changes,
  };
  return line;
}

/** What a line looks like once it has crossed over: the same, without the form's row key. */
function crossed(line: InvoiceDraftLine & { key?: string }): InvoiceDraftLine {
  const { key: _key, ...rest } = line;
  return rest;
}

const retainer = row("Monthly retainer\nOctober — strategy and delivery", {
  productId: "p-retainer",
  priceText: "8800.00",
  taxRateId: "t-vat",
});
const hosting = row("Hosting", { quantityText: "2", priceText: "50.00" });

/** The one-time form, filled in. */
const oneTime: OneTimeInvoiceFields = {
  customerId: "c-globex",
  subsidiaryId: "s-emea",
  currency: "EUR",
  notes: "Thanks for your business.",
  footer: "IBAN DE00 0000",
  lines: [retainer, hosting],
  discount: { mode: "percent", text: "10" },
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
};

/** The recurring form, filled in. */
const recurring: RecurringInvoiceFields = {
  customerId: "c-globex",
  subsidiaryId: "s-emea",
  currency: "EUR",
  notes: "Thanks for your business.",
  footer: "IBAN DE00 0000",
  lines: [retainer],
  discount: { mode: "amount", text: "250.00" },
  daysUntilDue: 30,
  name: { value: "Globex retainer", followsCustomer: false },
  schedule: { ...defaultScheduleParts(), frequency: "quarterly", dayOfMonth: 15, hour: 8 },
  autoSend: true,
  maxRunsText: "12",
  endsOn: "2027-12-31",
};

const TODAY = "2026-10-23";

describe("links to New invoice", () => {
  test("open the question, plain or with one customer picked", () => {
    assert.equal(newInvoicePath(base), "/c/acme/finance/invoices/new");
    assert.equal(newInvoicePath(base, null), "/c/acme/finance/invoices/new");
    assert.equal(newInvoicePath(base, ""), "/c/acme/finance/invoices/new");
    assert.equal(
      newInvoicePath(base, "c-globex"),
      "/c/acme/finance/invoices/new?customerId=c-globex",
    );
  });

  test("open the one-time form past the question, keeping the customer", () => {
    assert.equal(newOneTimeInvoicePath(base), "/c/acme/finance/invoices/new?kind=one-time");
    assert.equal(newOneTimeInvoicePath(base, ""), "/c/acme/finance/invoices/new?kind=one-time");
    assert.equal(
      newOneTimeInvoicePath(base, "c-globex"),
      "/c/acme/finance/invoices/new?kind=one-time&customerId=c-globex",
    );
  });

  test("encode an odd customer id and read it back the way the forms do", () => {
    const id = "odd id&kind=recurring";
    for (const href of [newInvoicePath(base, id), newOneTimeInvoicePath(base, id)]) {
      assert.equal(href.includes("odd id"), false, href);
      const params = new URL(href, "https://genosyn.example").searchParams;
      assert.equal(requestedCustomerPick(params), id, href);
    }
    // The id can't smuggle in an answer: the question is still asked.
    const params = new URL(newInvoicePath(base, id), "https://genosyn.example").searchParams;
    assert.equal(newInvoiceStep(params), "choose");
  });

  test("lead each answer to its own form", () => {
    assert.deepEqual(INVOICE_KINDS, ["one-time", "recurring"]);
    assert.equal(invoiceKindPath("one-time", base), newOneTimeInvoicePath(base));
    assert.equal(invoiceKindPath("recurring", base), newRecurringInvoicePath(base));
    assert.equal(
      invoiceKindPath("recurring", base, "c-globex"),
      "/c/acme/finance/recurring-invoices/new?customerId=c-globex",
    );
  });
});

describe("newInvoiceStep", () => {
  const step = (query: string) => newInvoiceStep(new URLSearchParams(query));

  test("asks the question unless the link answered it with One-time", () => {
    assert.equal(INVOICE_KIND_PARAM, "kind");
    assert.equal(step(""), "choose");
    assert.equal(step("customerId=c-globex"), "choose");
    assert.equal(step("kind=one-time"), "one-time");
    assert.equal(step("customerId=c-globex&kind=one-time"), "one-time");
  });

  test("reads the answer loosely, but never takes anything else for one", () => {
    assert.equal(step("kind=%20One-Time%20"), "one-time");
    for (const query of ["kind=", "kind=recurring", "kind=once", "kind=onetime", "type=one-time"]) {
      assert.equal(step(query), "choose", query);
    }
  });
});

/**
 * Where a link lands, the way `App.tsx` routes it: `invoices/new` is
 * `FinanceInvoiceNew`, which asks first unless `kind=one-time` answered it,
 * and `recurring-invoices/new` is the New recurring invoice form.
 */
function landing(href: string) {
  const url = new URL(href, "https://genosyn.example");
  const params = url.searchParams;
  const customerId = requestedCustomerPick(params);
  if (url.pathname === "/c/acme/finance/invoices/new") {
    return newInvoiceStep(params) === "choose"
      ? { form: "question", customerId }
      : { form: "one-time", customerId };
  }
  if (url.pathname === "/c/acme/finance/recurring-invoices/new") {
    return { form: "recurring", customerId, source: requestedRecurringInvoiceSource(params) };
  }
  return { form: "elsewhere", path: url.pathname };
}

function paletteHref(label: string): string {
  const entry = PALETTE_SUBPAGES.find((page) => page.label === label);
  assert.ok(entry, `the palette offers "${label}"`);
  return `/c/acme${entry.path}`;
}

describe("every way into a new invoice", () => {
  test("New invoice on the Invoices list and Finance's overview asks first", () => {
    assert.deepEqual(landing(newInvoicePath(base)), { form: "question", customerId: null });
  });

  test("a customer's New invoice asks first, with the customer picked for either answer", () => {
    const question = landing(newInvoicePath(base, "c-globex"));
    assert.deepEqual(question, { form: "question", customerId: "c-globex" });
    assert.deepEqual(landing(invoiceKindPath("one-time", base, question.customerId)), {
      form: "one-time",
      customerId: "c-globex",
    });
    assert.deepEqual(landing(invoiceKindPath("recurring", base, question.customerId)), {
      form: "recurring",
      customerId: "c-globex",
      source: null,
    });
  });

  test("the question's answers carry no customer when the link named none", () => {
    assert.deepEqual(landing(invoiceKindPath("one-time", base, null)), {
      form: "one-time",
      customerId: null,
    });
    assert.deepEqual(landing(invoiceKindPath("recurring", base, null)), {
      form: "recurring",
      customerId: null,
      source: null,
    });
  });

  test("the palette's New invoice asks first; its New recurring invoice goes straight to a schedule", () => {
    assert.deepEqual(landing(paletteHref("New invoice")), { form: "question", customerId: null });
    assert.deepEqual(landing(paletteHref("New recurring invoice")), {
      form: "recurring",
      customerId: null,
      source: null,
    });
  });

  test("nothing in the palette opens the one-time form without asking", () => {
    const starts = PALETTE_SUBPAGES.filter((page) => /invoices\/new/.test(page.path));
    assert.deepEqual(
      starts.map((page) => page.label),
      ["New invoice", "New recurring invoice"],
    );
    for (const page of starts) {
      assert.notEqual(landing(`/c/acme${page.path}`).form, "one-time", page.label);
    }
  });

  test("links that can only mean a schedule go straight to the recurring form", () => {
    // New schedule on the Recurring list.
    assert.deepEqual(landing(newRecurringInvoicePath(base)), {
      form: "recurring",
      customerId: null,
      source: null,
    });
    // New recurring invoice on a customer's Billing tab.
    assert.deepEqual(landing(newRecurringInvoicePath(base, "c-globex")), {
      form: "recurring",
      customerId: "c-globex",
      source: null,
    });
    // Make recurring on an invoice or an estimate.
    assert.deepEqual(
      landing(recurringInvoiceFromDocumentPath(base, { kind: "invoice", slug: "inv-7" })),
      { form: "recurring", customerId: null, source: { kind: "invoice", slug: "inv-7" } },
    );
    assert.deepEqual(
      landing(recurringInvoiceFromDocumentPath(base, { kind: "estimate", slug: "est-3" })),
      { form: "recurring", customerId: null, source: { kind: "estimate", slug: "est-3" } },
    );
  });

  test("a switch goes to the other form with the customer picked", () => {
    assert.deepEqual(landing(switchInvoiceKindPath("recurring", base, "c-globex", null)), {
      form: "recurring",
      customerId: "c-globex",
      source: null,
    });
    assert.deepEqual(landing(switchInvoiceKindPath("one-time", base, "c-globex", "c-acme")), {
      form: "one-time",
      customerId: "c-globex",
    });
  });

  test("a switch from a form that couldn't offer its customer passes the request on", () => {
    // The other form then says the customer is gone too, rather than quietly
    // starting with whoever is first in the list.
    assert.deepEqual(landing(switchInvoiceKindPath("one-time", base, "", "c-archived")), {
      form: "one-time",
      customerId: "c-archived",
    });
    assert.deepEqual(landing(switchInvoiceKindPath("recurring", base, "", null)), {
      form: "recurring",
      customerId: null,
      source: null,
    });
  });

  test("no page builds a link to invoices/new by hand", () => {
    // Every link that starts an invoice goes through `newInvoicePath` (the
    // question) or `invoiceKindPath`, so none can skip the question by
    // accident. The palette's catalogue entry is checked above.
    const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const allowed = new Set(["lib/invoiceKind.ts", "lib/subpages.ts"]);
    const offenders: string[] = [];
    const visit = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) continue;
        const rel = path.relative(clientRoot, full).split(path.sep).join("/");
        if (allowed.has(rel)) continue;
        if (/\/invoices\/new\b/.test(fs.readFileSync(full, "utf8"))) offenders.push(rel);
      }
    };
    visit(clientRoot);
    assert.deepEqual(offenders, []);
  });
});

describe("switching from the one-time form to the recurring form", () => {
  test("carries the customer, issuer, currency, lines, discount, notes and footer as typed", () => {
    const draft = draftFromOneTimeInvoice(oneTime, null);
    assert.equal(draft.customerId, "c-globex");
    const start = recurringInvoiceFromDraft(draft, globex);
    assert.equal(start.subsidiaryId, "s-emea");
    assert.equal(start.currency, "EUR");
    assert.equal(start.notes, "Thanks for your business.");
    assert.equal(start.footer, "IBAN DE00 0000");
    assert.deepEqual(start.lines, [crossed(retainer), crossed(hosting)]);
    assert.equal(start.lines[0].description, "Monthly retainer\nOctober — strategy and delivery");
    assert.deepEqual(start.discount, { mode: "percent", text: "10" });
  });

  test("turns the issue and due dates into Days until due", () => {
    assert.equal(
      recurringInvoiceFromDraft(draftFromOneTimeInvoice(oneTime, null), globex).daysUntilDue,
      30,
    );
    const terms = (issueDate: string, dueDate: string) =>
      recurringInvoiceFromDraft(
        draftFromOneTimeInvoice({ ...oneTime, issueDate, dueDate }, null),
        globex,
      ).daysUntilDue;
    assert.equal(terms("2026-10-01", "2026-10-01"), 0, "due on issue");
    assert.equal(terms("2026-12-25", "2027-01-08"), 14, "across a year end");
    assert.equal(terms("2028-02-20", "2028-03-01"), 10, "across a leap day");
    assert.equal(terms("2026-10-31", "2026-10-01"), 0, "due before issue counts as due on issue");
    assert.equal(
      terms("2026-10-01", "2028-10-01"),
      365,
      "beyond a year is the most the form takes",
    );
  });

  test("unreadable dates leave the payment terms the recurring form starts with", () => {
    for (const [issueDate, dueDate] of [
      ["", "2026-10-31"],
      ["2026-10-01", ""],
      ["2026-02-30", "2026-03-30"],
    ]) {
      const draft = draftFromOneTimeInvoice({ ...oneTime, issueDate, dueDate }, null);
      assert.equal(draft.daysUntilDue, null, `${issueDate} → ${dueDate}`);
      assert.equal(
        recurringInvoiceFromDraft(draft, globex).daysUntilDue,
        DEFAULT_PAYMENT_TERMS_DAYS,
      );
    }
    assert.equal(DEFAULT_PAYMENT_TERMS_DAYS, 14);
  });

  test("a first visit starts on the schedule defaults, named after the customer", () => {
    const start = recurringInvoiceFromDraft(draftFromOneTimeInvoice(oneTime, null), globex);
    assert.deepEqual(start.name, { value: "Globex", followsCustomer: true });
    assert.deepEqual(start.schedule, defaultScheduleParts());
    assert.equal(start.autoSend, false);
    assert.equal(start.maxRunsText, "");
    assert.equal(start.endsOn, "");
  });

  test("without a customer, the name waits for one", () => {
    const draft = draftFromOneTimeInvoice({ ...oneTime, customerId: "" }, null);
    assert.deepEqual(recurringInvoiceFromDraft(draft, null).name, {
      value: "",
      followsCustomer: true,
    });
  });

  test("leaves the form's row keys behind and shares nothing with the form", () => {
    const lines = [row("Design"), row("Build")];
    const discount = { mode: "amount" as const, text: "100.00" };
    const draft = draftFromOneTimeInvoice({ ...oneTime, lines, discount }, null);
    for (const line of draft.lines) assert.equal("key" in line, false);
    lines[0].description = "Changed after the switch";
    discount.text = "1.00";
    assert.equal(draft.lines[0].description, "Design");
    assert.equal(draft.discount.text, "100.00");
  });

  test("keeps blank lines and an empty discount just as they were", () => {
    const draft = draftFromOneTimeInvoice(
      { ...oneTime, lines: [row("")], discount: NO_DISCOUNT_DRAFT },
      null,
    );
    const start = recurringInvoiceFromDraft(draft, globex);
    assert.deepEqual(start.lines, [crossed(row(""))]);
    assert.deepEqual(start.discount, NO_DISCOUNT_DRAFT);
  });
});

describe("switching from the recurring form to the one-time form", () => {
  test("carries the customer, issuer, currency, lines, discount, notes and footer as typed", () => {
    const draft = draftFromRecurringInvoice(recurring, null);
    assert.equal(draftCustomerRequest(draft, null), "c-globex");
    const start = oneTimeInvoiceFromDraft(draft, TODAY);
    assert.equal(start.subsidiaryId, "s-emea");
    assert.equal(start.currency, "EUR");
    assert.equal(start.notes, "Thanks for your business.");
    assert.equal(start.footer, "IBAN DE00 0000");
    assert.deepEqual(start.lines, [crossed(retainer)]);
    assert.deepEqual(start.discount, { mode: "amount", text: "250.00" });
  });

  test("issues it today, due Days until due later", () => {
    assert.deepEqual(oneTimeDatesFromDraft(draftFromRecurringInvoice(recurring, null), TODAY), {
      issueDate: "2026-10-23",
      dueDate: "2026-11-22",
    });
    const due = (daysUntilDue: number, today = TODAY) =>
      oneTimeDatesFromDraft(draftFromRecurringInvoice({ ...recurring, daysUntilDue }, null), today)
        .dueDate;
    assert.equal(due(0), "2026-10-23", "due on receipt");
    assert.equal(due(14, "2026-12-20"), "2027-01-03", "across a year end");
    assert.equal(due(10, "2028-02-20"), "2028-03-01", "across a leap day");
  });

  test("keeps Days until due within what the forms accept", () => {
    const days = (daysUntilDue: number) =>
      draftFromRecurringInvoice({ ...recurring, daysUntilDue }, null).daysUntilDue;
    assert.equal(days(400), 365);
    assert.equal(days(-3), 0);
    assert.equal(days(2.6), 3);
  });

  test("hands over the schedule and its settings, for a switch back", () => {
    const draft = draftFromRecurringInvoice(recurring, null);
    assert.deepEqual(draft.recurring, {
      name: { value: "Globex retainer", followsCustomer: false },
      schedule: recurring.schedule,
      autoSend: true,
      maxRunsText: "12",
      endsOn: "2027-12-31",
    });
    assert.equal(draft.oneTime, null, "the one-time form has set no dates yet");
  });

  test("the customer the other form had wins over the link's", () => {
    const draft = draftFromRecurringInvoice(recurring, null);
    assert.equal(draftCustomerRequest(draft, "c-acme"), "c-globex");
    assert.equal(draftCustomerRequest({ ...draft, customerId: "" }, "c-acme"), "c-acme");
    assert.equal(draftCustomerRequest({ ...draft, customerId: "" }, null), null);
    assert.equal(draftCustomerRequest(null, "c-acme"), "c-acme");
    assert.equal(draftCustomerRequest(null, null), null);
  });
});

/** The recurring form filled from a draft, as its state then stands. */
function recurringForm(
  draft: InvoiceDraft,
  customer: typeof globex | null,
): RecurringInvoiceFields {
  return { ...recurringInvoiceFromDraft(draft, customer), customerId: customer?.id ?? "" };
}

/** The one-time form filled from a draft, as its state then stands. */
function oneTimeForm(draft: InvoiceDraft, customerId: string, today = TODAY): OneTimeInvoiceFields {
  return { ...oneTimeInvoiceFromDraft(draft, today), customerId };
}

describe("switching back and forth", () => {
  test("one-time → recurring → one-time brings everything back, dates exactly", () => {
    const toRecurring = draftFromOneTimeInvoice(oneTime, null);
    const back = draftFromRecurringInvoice(recurringForm(toRecurring, globex), toRecurring);
    const form = oneTimeForm(back, "c-globex");
    assert.deepEqual(form, { ...oneTime, lines: oneTime.lines.map(crossed) });
  });

  test("a Days until due changed on the way moves the due date from the earlier issue date", () => {
    const toRecurring = draftFromOneTimeInvoice(oneTime, null);
    const changed = { ...recurringForm(toRecurring, globex), daysUntilDue: 45 };
    const back = draftFromRecurringInvoice(changed, toRecurring);
    assert.deepEqual(oneTimeDatesFromDraft(back, TODAY), {
      issueDate: "2026-10-01",
      dueDate: "2026-11-15",
    });
  });

  test("dates the recurring form can't express survive the trip untouched", () => {
    for (const dates of [
      { issueDate: "2026-10-31", dueDate: "2026-10-01" },
      { issueDate: "2026-01-01", dueDate: "2028-01-01" },
    ]) {
      const toRecurring = draftFromOneTimeInvoice({ ...oneTime, ...dates }, null);
      const back = draftFromRecurringInvoice(recurringForm(toRecurring, globex), toRecurring);
      assert.deepEqual(oneTimeDatesFromDraft(back, TODAY), dates);
    }
  });

  test("dates cleared on the one-time form come back as today plus the terms", () => {
    const toRecurring = draftFromOneTimeInvoice({ ...oneTime, issueDate: "", dueDate: "" }, null);
    const back = draftFromRecurringInvoice(recurringForm(toRecurring, globex), toRecurring);
    assert.deepEqual(oneTimeDatesFromDraft(back, TODAY), {
      issueDate: TODAY,
      dueDate: addDays(TODAY, DEFAULT_PAYMENT_TERMS_DAYS),
    });
  });

  test("recurring → one-time → recurring brings the schedule and its settings back", () => {
    const toOneTime = draftFromRecurringInvoice(recurring, null);
    // Edits on the one-time form come along too.
    const edited = {
      ...oneTimeForm(toOneTime, "c-globex"),
      notes: "Edited on the one-time form.",
      lines: [retainer, hosting],
    };
    const back = recurringForm(draftFromOneTimeInvoice(edited, toOneTime), globex);
    assert.deepEqual(back, {
      ...recurring,
      notes: "Edited on the one-time form.",
      lines: [crossed(retainer), crossed(hosting)],
    });
  });

  test("a name that follows the customer follows one changed on the one-time form", () => {
    const following = { ...recurring, name: { value: "Globex", followsCustomer: true } };
    const toOneTime = draftFromRecurringInvoice(following, null);
    const moved = { ...oneTimeForm(toOneTime, "c-globex"), customerId: "c-acme" };
    const back = recurringForm(draftFromOneTimeInvoice(moved, toOneTime), acme);
    assert.deepEqual(back.name, { value: "Acme Corp", followsCustomer: true });
    assert.equal(back.customerId, "c-acme");
  });

  test("a typed name stays, whoever the customer becomes", () => {
    const toOneTime = draftFromRecurringInvoice(recurring, null);
    const moved = { ...oneTimeForm(toOneTime, "c-globex"), customerId: "c-acme" };
    const back = recurringForm(draftFromOneTimeInvoice(moved, toOneTime), acme);
    assert.deepEqual(back.name, { value: "Globex retainer", followsCustomer: false });
  });

  test("many switches lose nothing", () => {
    let draft = draftFromOneTimeInvoice(oneTime, null);
    for (let i = 0; i < 5; i += 1) {
      const recurringState = recurringForm(draft, globex);
      draft = draftFromRecurringInvoice(recurringState, draft);
      draft = draftFromOneTimeInvoice(oneTimeForm(draft, "c-globex"), draft);
    }
    assert.deepEqual(oneTimeForm(draft, "c-globex"), {
      ...oneTime,
      lines: oneTime.lines.map(crossed),
    });
  });
});

describe("readInvoiceDraft", () => {
  test("reads back what invoiceDraftState wrote, after the history has stored it", () => {
    for (const draft of [
      draftFromOneTimeInvoice(oneTime, null),
      draftFromRecurringInvoice(recurring, draftFromOneTimeInvoice(oneTime, null)),
    ]) {
      assert.deepEqual(readInvoiceDraft(structuredClone(invoiceDraftState(draft))), draft);
    }
  });

  test("is null for anything that is not a draft", () => {
    for (const state of [
      null,
      undefined,
      "invoiceDraft",
      7,
      [],
      {},
      { invoiceDraft: null },
      { invoiceDraft: [] },
      { invoiceDraft: "x" },
      { resendRevised: true },
      { draft: draftFromOneTimeInvoice(oneTime, null) },
    ]) {
      assert.equal(readInvoiceDraft(state), null, JSON.stringify(state));
    }
  });

  test("fills what is missing or malformed with the form's defaults", () => {
    assert.deepEqual(
      readInvoiceDraft({
        invoiceDraft: {
          customerId: 7,
          currency: null,
          lines: "Retainer",
          discount: { mode: "bogus", text: "5" },
          daysUntilDue: "30",
          oneTime: { issueDate: "2026-10-01" },
          recurring: { autoSend: true },
        },
      }),
      {
        customerId: "",
        subsidiaryId: "",
        currency: "",
        notes: "",
        footer: "",
        lines: [],
        discount: NO_DISCOUNT_DRAFT,
        daysUntilDue: null,
        oneTime: null,
        recurring: null,
      },
    );
  });

  test("drops lines that aren't lines, and fills a line's missing fields", () => {
    const draft = readInvoiceDraft({
      invoiceDraft: {
        lines: [null, 3, "x", { description: "Hosting" }, { productId: "", taxRateId: 5 }],
      },
    });
    assert.deepEqual(draft?.lines, [
      {
        productId: null,
        description: "Hosting",
        quantityText: "1",
        priceText: "0.00",
        taxRateId: "",
      },
      { productId: null, description: "", quantityText: "1", priceText: "0.00", taxRateId: "" },
    ]);
  });

  test("keeps Days until due within 0–365, and drops one that isn't a number", () => {
    const days = (daysUntilDue: unknown) =>
      readInvoiceDraft({ invoiceDraft: { daysUntilDue } })?.daysUntilDue;
    assert.equal(days(30), 30);
    assert.equal(days(999), 365);
    assert.equal(days(-4), 0);
    assert.equal(days(12.4), 12);
    assert.equal(days(Number.NaN), null);
    assert.equal(days(Number.POSITIVE_INFINITY), null);
    assert.equal(days(null), null);
  });

  test("repairs a schedule part by part", () => {
    const draft = readInvoiceDraft({
      invoiceDraft: {
        recurring: {
          name: { value: "Retainer" },
          schedule: {
            frequency: "hourly",
            intervalCount: 0,
            dayOfMonth: 15,
            weekday: 9,
            month: 6,
            hour: 25,
            minute: 30,
          },
          autoSend: "yes",
          maxRunsText: 12,
          endsOn: "2027-01-01",
        },
      },
    });
    const defaults = defaultScheduleParts();
    assert.deepEqual(draft?.recurring, {
      name: { value: "Retainer", followsCustomer: true },
      schedule: {
        frequency: defaults.frequency,
        intervalCount: defaults.intervalCount,
        dayOfMonth: 15,
        weekday: defaults.weekday,
        month: 6,
        hour: defaults.hour,
        minute: 30,
      },
      autoSend: false,
      maxRunsText: "",
      endsOn: "2027-01-01",
    });
  });

  test("takes the schedule settings only with a name and a schedule", () => {
    const schedule = defaultScheduleParts();
    const name = { value: "Retainer", followsCustomer: false };
    assert.equal(readInvoiceDraft({ invoiceDraft: { recurring: { schedule } } })?.recurring, null);
    assert.equal(readInvoiceDraft({ invoiceDraft: { recurring: { name } } })?.recurring, null);
    assert.equal(
      readInvoiceDraft({ invoiceDraft: { recurring: { name, schedule, autoSend: true } } })
        ?.recurring?.autoSend,
      true,
    );
  });
});

describe("dates", () => {
  test("isDateOnly takes real calendar dates written YYYY-MM-DD, and nothing else", () => {
    for (const date of ["2026-10-01", "2028-02-29", "1999-12-31"])
      assert.equal(isDateOnly(date), true, date);
    for (const date of [
      "",
      "2026-02-30",
      "2027-02-29",
      "2026-13-01",
      "2026-2-3",
      "2026-10-01T00:00:00Z",
      "October 1, 2026",
    ]) {
      assert.equal(isDateOnly(date), false, date);
    }
  });

  test("addDays moves whole days across months, years and leap days", () => {
    assert.equal(addDays("2026-10-23", 0), "2026-10-23");
    assert.equal(addDays("2026-10-23", 30), "2026-11-22");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});
