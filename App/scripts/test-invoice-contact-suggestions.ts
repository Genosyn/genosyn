/**
 * Real Chrome coverage for the send dialog's contact suggestions, on the real
 * App against a deterministic API: Resend on an invoice offers the customer's
 * people under To and Cc, best first and without anyone already on the email
 * (Always Cc included); one click copies a person, their To button puts them
 * on the To line, and whoever is added leaves the list and comes back when
 * removed. To and Cc are chips that take typed and pasted lists — commas,
 * semicolons, new lines, `Name <address>` — mark what is not an address and
 * refuse to send it, and work from the keyboard: matches while typing,
 * Backspace and the arrow keys through the chips, Escape closing the matches
 * before the dialog. The send carries exactly the chips shown. An address that
 * is none of the customer's people can be saved to its contacts. Estimates
 * resend from the same dialog, and it all holds on a phone and in the dark.
 * Run with `npm run test:invoice-contact-suggestions`.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import type {
  DocumentEmailDetails,
  Estimate,
  Invoice,
  RecipientSuggestion,
  RecipientSuggestionList,
} from "../client/lib/api";
import {
  API,
  hoursAgo,
  noSidewaysScroll,
  startApp,
  status,
  waitForFocus,
  type ApiRoute,
  type AppView,
  type Write,
} from "./appFixture";

const app = await startApp("Send dialog — the customer's contacts, one click away");

// ───────────────────────────── fixtures ─────────────────────────────

const CUSTOMER = {
  id: "acct-optionmetrics",
  name: "OptionMetrics",
  slug: "optionmetrics",
  email: "billing@optionmetrics.com",
};

const INVOICE_SLUG = "optionmetrics-inv-0001";
const INVOICE_NUMBER = "OPTIONMETRICS-INV-0001";
const ESTIMATE_SLUG = "optionmetrics-est-0001";
const ESTIMATE_NUMBER = "OPTIONMETRICS-EST-0001";

function invoice(): Invoice {
  return {
    id: "inv-1",
    companyId: "company",
    customerId: CUSTOMER.id,
    subsidiaryId: null,
    issuerSnapshot: null,
    slug: INVOICE_SLUG,
    numberSeq: 1,
    number: INVOICE_NUMBER,
    status: "sent",
    issueDate: hoursAgo(240),
    dueDate: hoursAgo(-240),
    currency: "USD",
    exchangeRate: null,
    subtotalCents: 310_000,
    discountPercent: 0,
    discountAmountCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: 310_000,
    paidCents: 0,
    creditedCents: 0,
    writtenOffCents: 0,
    balanceCents: 310_000,
    notes: "",
    footer: "",
    sentAt: hoursAgo(240),
    paidAt: null,
    voidedAt: null,
    archivedAt: null,
    recurringInvoiceId: null,
    createdById: "viewer",
    createdAt: hoursAgo(240),
    updatedAt: hoursAgo(240),
    customer: CUSTOMER,
    recurringInvoice: null,
    lines: [],
    payments: [],
  };
}

function estimate(): Estimate {
  return {
    id: "est-1",
    companyId: "company",
    customerId: CUSTOMER.id,
    subsidiaryId: null,
    issuerSnapshot: null,
    slug: ESTIMATE_SLUG,
    numberSeq: 1,
    number: ESTIMATE_NUMBER,
    status: "sent",
    issueDate: hoursAgo(48),
    validUntil: hoursAgo(-600),
    currency: "USD",
    subtotalCents: 90_000,
    discountPercent: 0,
    discountAmountCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: 90_000,
    notes: "",
    footer: "",
    sentAt: hoursAgo(48),
    acceptedAt: null,
    declinedAt: null,
    voidedAt: null,
    invoiceId: null,
    convertedAt: null,
    archivedAt: null,
    createdById: "viewer",
    createdAt: hoursAgo(48),
    updatedAt: hoursAgo(48),
    customer: { ...CUSTOMER, billingAddress: "1 Main St" },
    lines: [],
    invoice: null,
    revision: { revisedAt: null, emailedAt: hoursAgo(48) },
    emailDetails: {
      toAddress: CUSTOMER.email,
      alwaysCcAddress: "",
      fromAddress: "alerts@acme.test",
      replyTo: "",
      configured: true,
      source: "company_provider",
    },
  };
}

const INVOICE_EMAIL: DocumentEmailDetails = {
  toAddress: CUSTOMER.email,
  alwaysCcAddress: "books@acme.test",
  fromAddress: "alerts@acme.test",
  replyTo: "ar@acme.test",
  configured: true,
  source: "company_provider",
};

function person(email: string, extra: Partial<RecipientSuggestion> = {}): RecipientSuggestion {
  return {
    email,
    name: "",
    role: "",
    primary: false,
    billing: false,
    sources: ["domain"],
    dealTitle: null,
    lastEmailedAt: null,
    ...extra,
  };
}

/** As the server ranks them: billing first, then by recency, then the rest. */
const PEOPLE: RecipientSuggestion[] = [
  person(CUSTOMER.email, { billing: true, sources: ["billing_email"] }),
  person("priya@optionmetrics.com", {
    name: "Priya Shah",
    role: "Accounts payable",
    primary: true,
    billing: true,
    sources: ["customer_contact"],
  }),
  // The company's own Always Cc mailbox, were it ever one of the customer's people.
  person("books@acme.test", { name: "Books", sources: ["customer_contact"] }),
  person("chad@optionmetrics.com", {
    name: "Chad Champion",
    sources: ["deal", "domain"],
    dealTitle: "2027 renewal",
    lastEmailedAt: "2026-09-10T09:00:00.000Z",
  }),
  person("lin@lin-consulting.example", { name: "Lin Wu", sources: ["revenue_contact"] }),
  person("ana@optionmetrics.com", { name: "Ana Lyst", role: "Analyst" }),
  person("omar@optionmetrics.com", { name: "Omar Ops", role: "Operations" }),
];

type Scenario = {
  people?: RecipientSuggestion[];
  /** Answer the suggestions read with an error this many times first. */
  failSuggestions?: number;
  /** Delay the suggestions read until released. */
  holdSuggestions?: Promise<void>;
};

function routes(scenario: Scenario = {}): ApiRoute[] {
  let people = [...(scenario.people ?? PEOPLE)];
  let failures = scenario.failSuggestions ?? 0;
  const list = (): RecipientSuggestionList => ({
    suggestions: people,
    domain: "optionmetrics.com",
  });
  return [
    [
      "GET",
      `${API}/invoices/${INVOICE_SLUG}`,
      () => ({
        ...invoice(),
        emailDetails: INVOICE_EMAIL,
        writeOffs: [],
        creditApplications: [],
        revision: { revisedAt: null, emailedAt: hoursAgo(240) },
        homeCurrency: "USD",
      }),
    ],
    ["GET", `${API}/estimates/${ESTIMATE_SLUG}`, () => estimate()],
    ["GET", /\/history\/(invoice|estimate)\//, () => ({ items: [], nextCursor: null })],
    [
      "GET",
      `${API}/customers/${CUSTOMER.slug}/recipient-suggestions`,
      async () => {
        if (scenario.holdSuggestions) await scenario.holdSuggestions;
        if (failures > 0) {
          failures -= 1;
          return status(500, { error: "The suggestions are taking a break" });
        }
        return list();
      },
    ],
    [
      "POST",
      `${API}/customers/${CUSTOMER.slug}/contacts`,
      ({ body }) => {
        const saved = person(String(body.email), {
          name: String(body.name),
          sources: ["customer_contact"],
        });
        people = [...people, saved];
        return { id: `contact-${people.length}`, ...body };
      },
    ],
    [
      "POST",
      `${API}/invoices/${INVOICE_SLUG}/send`,
      ({ body }) => ({
        invoice: invoice(),
        send: {
          status: "sent",
          errorMessage: "",
          toAddress: (body.to as string[]).join(", "),
          ccAddress: ["books@acme.test", ...(body.cc as string[])].join(", "),
          pdfRequested: body.attachPdf,
          pdfAttached: body.attachPdf,
        },
      }),
    ],
    [
      "POST",
      `${API}/estimates/${ESTIMATE_SLUG}/send`,
      ({ body }) => ({
        estimate: estimate(),
        send: {
          status: "sent",
          errorMessage: "",
          toAddress: (body.to as string[]).join(", "),
          ccAddress: (body.cc as string[]).join(", "),
          pdfRequested: body.attachPdf,
          pdfAttached: body.attachPdf,
        },
      }),
    ],
  ];
}

// ───────────────────────────── helpers ─────────────────────────────

const INVOICE_TITLE = `Resend ${INVOICE_NUMBER}`;

function dialogOf(page: Page, title = INVOICE_TITLE): Locator {
  return page.getByRole("dialog", { name: title });
}

const field = (dialog: Locator, name: "To" | "Cc") =>
  dialog.getByRole("combobox", { name: `${name} recipients`, exact: true });

/** The chips on one line, as their addresses (or entries, when not an address). */
async function chips(dialog: Locator, name: "To" | "Cc"): Promise<string[]> {
  const row = field(dialog, name).locator("xpath=..");
  return row
    .locator("[data-recipient]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-recipient") ?? ""));
}

async function expectChips(dialog: Locator, name: "To" | "Cc", expected: string[], label = "") {
  const deadline = Date.now() + 10_000;
  let current = await chips(dialog, name);
  while (JSON.stringify(current) !== JSON.stringify(expected) && Date.now() < deadline) {
    await dialog.page().waitForTimeout(50);
    current = await chips(dialog, name);
  }
  assert.deepEqual(current, expected, `${name} chips ${label}`);
}

/** The suggestion rows, as their addresses, in the order shown. */
async function suggested(dialog: Locator): Promise<string[]> {
  return dialog
    .locator("[data-suggestion]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-suggestion") ?? ""));
}

async function expectSuggested(dialog: Locator, expected: string[], label = "") {
  const deadline = Date.now() + 10_000;
  let current = await suggested(dialog);
  while (JSON.stringify(current) !== JSON.stringify(expected) && Date.now() < deadline) {
    await dialog.page().waitForTimeout(50);
    current = await suggested(dialog);
  }
  assert.deepEqual(current, expected, `suggestions ${label}`);
}

async function openInvoiceResend(view: AppView): Promise<Locator> {
  const { page } = view;
  await page.getByRole("heading", { name: INVOICE_NUMBER, level: 1 }).waitFor();
  await view.click(page.getByRole("button", { name: "More actions" }));
  await view.click(page.getByRole("menuitem", { name: "Resend email" }));
  const dialog = dialogOf(page);
  await dialog.waitFor();
  return dialog;
}

function sends(view: AppView, kind: "invoices" | "estimates"): Write[] {
  const slug = kind === "invoices" ? INVOICE_SLUG : ESTIMATE_SLUG;
  return view.writes.filter((write) => write.path.endsWith(`/${kind}/${slug}/send`));
}

const INVOICE_PATH = `/c/acme/finance/invoices/${INVOICE_SLUG}`;
const ESTIMATE_PATH = `/c/acme/finance/estimates/${ESTIMATE_SLUG}`;

// ───────────────────────────── the flow the owner asked for ─────────────────────────────

await app.check(
  "Resend offers the customer's people; one click adds to Cc, To moves one up, removing a chip brings them back, and the send carries exactly the chips",
  async () => {
    const view = await app.open({ path: INVOICE_PATH, routes: routes() });
    const { page } = view;
    const dialog = await openInvoiceResend(view);

    await expectChips(dialog, "To", [CUSTOMER.email], "start with the billing email");
    await expectChips(dialog, "Cc", [], "start empty");
    await dialog.getByText("Suggested from OptionMetrics", { exact: true }).waitFor();
    // The billing email is already on To and books@ is Always Cc: neither is offered.
    await expectSuggested(
      dialog,
      [
        "priya@optionmetrics.com",
        "chad@optionmetrics.com",
        "lin@lin-consulting.example",
        "ana@optionmetrics.com",
      ],
      "four best, without anyone already on the email",
    );
    const priya = dialog.locator('[data-suggestion="priya@optionmetrics.com"]');
    await priya.getByText("Priya Shah", { exact: true }).waitFor();
    await priya.getByText("Primary", { exact: true }).waitFor();
    await priya.getByText("priya@optionmetrics.com · Accounts payable", { exact: true }).waitFor();
    await dialog
      .locator('[data-suggestion="chad@optionmetrics.com"]')
      .getByText("chad@optionmetrics.com · On 2027 renewal · Emailed Sep 10", { exact: true })
      .waitFor();
    await dialog.getByRole("button", { name: "Show 1 more", exact: true }).waitFor();
    await app.shot(page, "contact-suggestions-open");

    // One click: Priya is copied, and leaves the list.
    const clicksBefore = view.clicks();
    await view.click(dialog.getByRole("button", { name: "Add Priya Shah to Cc", exact: true }));
    assert.equal(view.clicks() - clicksBefore, 1, "one click to add a contact");
    await expectChips(dialog, "Cc", ["priya@optionmetrics.com"], "after one click");
    await expectSuggested(
      dialog,
      [
        "chad@optionmetrics.com",
        "lin@lin-consulting.example",
        "ana@optionmetrics.com",
        "omar@optionmetrics.com",
      ],
      "Priya left, and the next person moved up",
    );
    assert.equal(
      await dialog.getByRole("button", { name: "Show 1 more" }).count(),
      0,
      "nobody is hidden any more",
    );

    // Chad goes on the To line instead, just as easily.
    await view.click(dialog.getByRole("button", { name: "Add Chad Champion to To", exact: true }));
    await expectChips(dialog, "To", [CUSTOMER.email, "chad@optionmetrics.com"], "after To");
    await expectSuggested(dialog, [
      "lin@lin-consulting.example",
      "ana@optionmetrics.com",
      "omar@optionmetrics.com",
    ]);

    // Taking the billing email off brings it back to the top of the list.
    await view.click(dialog.getByRole("button", { name: `Remove ${CUSTOMER.email}`, exact: true }));
    await expectChips(dialog, "To", ["chad@optionmetrics.com"], "after removing a chip");
    await expectSuggested(dialog, [
      CUSTOMER.email,
      "lin@lin-consulting.example",
      "ana@optionmetrics.com",
      "omar@optionmetrics.com",
    ]);
    await dialog
      .locator(`[data-suggestion="${CUSTOMER.email}"]`)
      .getByText("Billing email", { exact: true })
      .waitFor();
    await app.shot(page, "contact-suggestions-chips");

    await view.click(dialog.getByRole("button", { name: "Resend email", exact: true }));
    const [send] = await Promise.all([
      view.waitForWrite((write) => write.path.endsWith(`/invoices/${INVOICE_SLUG}/send`)),
      dialog.waitFor({ state: "detached" }),
    ]);
    assert.deepEqual(send.body, {
      to: ["chad@optionmetrics.com"],
      cc: ["priya@optionmetrics.com"],
      message: "",
      attachPdf: true,
    });
    assert.equal(sends(view, "invoices").length, 1, "one email");
    assert.equal(
      view.writes.filter((write) => write.path.includes("/contacts")).length,
      0,
      "suggesting saves nothing",
    );
    await page.close();
  },
);

// ───────────────────────────── typing and pasting ─────────────────────────────

await app.check(
  "Typed and pasted lists become chips — commas, semicolons, new lines, Name <address> — and duplicates collapse",
  async () => {
    const view = await app.open({ path: INVOICE_PATH, routes: routes() });
    const { page } = view;
    const dialog = await openInvoiceResend(view);
    const cc = field(dialog, "Cc");

    await cc.click();
    await cc.pressSequentially("jane@optionmetrics.com,");
    await expectChips(dialog, "Cc", ["jane@optionmetrics.com"], "a comma finishes an address");
    assert.equal(await cc.inputValue(), "", "the box is empty again");
    await cc.pressSequentially("bob@optionmetrics.com ");
    await expectChips(
      dialog,
      "Cc",
      ["jane@optionmetrics.com", "bob@optionmetrics.com"],
      "a space after a finished address",
    );

    // A list pasted from a mail client, a spreadsheet and prose at once.
    await page.evaluate((text) => {
      const input = document.activeElement as HTMLInputElement;
      const data = new DataTransfer();
      data.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, '"Doe, Jane" <JANE@optionmetrics.com>; Ana Lyst <ana@optionmetrics.com>\nnot-an-address\ncarl@optionmetrics.com, bob@optionmetrics.com');
    await expectChips(
      dialog,
      "Cc",
      [
        "jane@optionmetrics.com",
        "bob@optionmetrics.com",
        "ana@optionmetrics.com",
        "not-an-address",
        "carl@optionmetrics.com",
      ],
      "after the paste: each person once, the bad entry kept to fix",
    );
    const invalid = dialog.locator('[data-recipient="not-an-address"]');
    assert.equal(await invalid.getAttribute("data-valid"), "false");
    await dialog
      .getByText(
        "“not-an-address” isn’t a valid email address — click it to fix it, or remove it.",
        { exact: true },
      )
      .waitFor();
    // Ana came from a suggestion's own address: she is no longer offered.
    assert.equal(
      await dialog.locator('[data-suggestion="ana@optionmetrics.com"]').count(),
      0,
      "a pasted suggestion leaves the list too",
    );
    await app.shot(page, "contact-suggestions-pasted");

    // Sending with a bad entry sends nothing and says what to fix.
    await view.click(dialog.getByRole("button", { name: "Resend email", exact: true }));
    await dialog
      .getByRole("alert")
      .getByText("“not-an-address” isn’t a valid email address. Fix or remove it.", {
        exact: true,
      })
      .waitFor();
    assert.equal(sends(view, "invoices").length, 0, "nothing sent with an invalid entry");

    // Clicking the bad chip puts it back in the box to fix.
    await view.click(invalid.getByRole("button", { name: /^not-an-address/ }));
    await waitForFocus(cc, "the box takes the entry");
    assert.equal(await cc.inputValue(), "not-an-address");
    await cc.fill("dana@optionmetrics.com");
    await cc.press("Enter");
    await expectChips(dialog, "Cc", [
      "jane@optionmetrics.com",
      "bob@optionmetrics.com",
      "ana@optionmetrics.com",
      "carl@optionmetrics.com",
      "dana@optionmetrics.com",
    ]);
    assert.equal(await dialog.getByText(/isn’t a valid email address/).count(), 0);

    // Still being typed when Resend is pressed: it goes too.
    await cc.pressSequentially("Erin Ops <erin@optionmetrics.com>");
    await view.click(dialog.getByRole("button", { name: "Resend email", exact: true }));
    const send = await view.waitForWrite((write) =>
      write.path.endsWith(`/invoices/${INVOICE_SLUG}/send`),
    );
    assert.deepEqual(send.body.to, [CUSTOMER.email]);
    assert.deepEqual(send.body.cc, [
      "jane@optionmetrics.com",
      "bob@optionmetrics.com",
      "ana@optionmetrics.com",
      "carl@optionmetrics.com",
      "dana@optionmetrics.com",
      "erin@optionmetrics.com",
    ]);
    await page.close();
  },
);

// ───────────────────────────── the keyboard ─────────────────────────────

await app.check(
  "From the keyboard: matches while typing, Enter adds, Escape closes the matches before the dialog, Backspace and the arrows walk the chips",
  async () => {
    const view = await app.open({ path: INVOICE_PATH, routes: routes() });
    const { page } = view;
    const dialog = await openInvoiceResend(view);
    const to = field(dialog, "To");
    const cc = field(dialog, "Cc");
    await waitForFocus(to, "the dialog opens in the To box");
    await expectSuggested(dialog, [
      "priya@optionmetrics.com",
      "chad@optionmetrics.com",
      "lin@lin-consulting.example",
      "ana@optionmetrics.com",
    ]);

    await page.keyboard.press("Tab");
    await waitForFocus(cc, "Tab goes from To to Cc, past the chips");
    // "opt" is everyone at optionmetrics.com: a word of their address starts with it.
    await page.keyboard.type("opt");
    const matches = dialog.getByRole("listbox", { name: "People to add to Cc" });
    await matches.waitFor();
    assert.equal(await cc.getAttribute("aria-expanded"), "true");
    const options = matches.getByRole("option");
    assert.equal(await options.count(), 4, "Priya, Chad, Ana and Omar; never Lin");
    assert.equal(await options.nth(0).getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.equal(await options.nth(3).getAttribute("aria-selected"), "true", "↓ moves down");
    assert.equal(
      await cc.getAttribute("aria-activedescendant"),
      await options.nth(3).getAttribute("id"),
    );
    await page.keyboard.press("ArrowDown");
    assert.equal(await options.nth(0).getAttribute("aria-selected"), "true", "and wraps round");
    await page.keyboard.press("ArrowUp");
    assert.equal(await options.nth(3).getAttribute("aria-selected"), "true", "↑ wraps back");
    await page.keyboard.press("Enter");
    await expectChips(dialog, "Cc", ["omar@optionmetrics.com"], "Enter takes the highlighted one");
    assert.equal(await cc.inputValue(), "");

    await page.keyboard.type("pri");
    await matches.waitFor();
    // Escape closes the matches, and only the matches.
    await page.keyboard.press("Escape");
    await matches.waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), true, "the dialog stayed open");
    await page.keyboard.press("ArrowDown");
    await matches.waitFor();
    await page.keyboard.press("Tab");
    await expectChips(
      dialog,
      "Cc",
      ["omar@optionmetrics.com", "priya@optionmetrics.com"],
      "Tab takes the highlighted match and moves on",
    );

    // Back in Cc: Backspace in the empty box removes the last chip.
    await cc.focus();
    await page.keyboard.press("Backspace");
    await expectChips(dialog, "Cc", ["omar@optionmetrics.com"], "Backspace removed Priya");
    // ArrowLeft walks into the chips; Delete removes the one with focus.
    await page.keyboard.press("ArrowLeft");
    await waitForFocus(
      dialog.getByRole("button", { name: "Remove Omar Ops <omar@optionmetrics.com>", exact: true }),
      "ArrowLeft reaches the last chip",
    );
    await page.keyboard.press("Delete");
    await expectChips(dialog, "Cc", [], "Delete removed Omar");
    await waitForFocus(cc, "focus comes back to the box");

    // A suggestion row from the keyboard: Enter adds, and focus moves to the next row.
    await dialog.getByRole("button", { name: "Add Priya Shah to Cc", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expectChips(dialog, "Cc", ["priya@optionmetrics.com"]);
    await waitForFocus(
      dialog.getByRole("button", { name: "Add Chad Champion to Cc", exact: true }),
      "focus moves to the person who took the row",
    );
    await page.keyboard.press("Enter");
    await expectChips(dialog, "Cc", ["priya@optionmetrics.com", "chad@optionmetrics.com"]);

    // With the matches closed, Escape is the dialog's again.
    await cc.focus();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(sends(view, "invoices").length, 0, "closing sends nothing");
    assert.equal(view.clicks(), 2, "the menu and Resend email; the rest was the keyboard");
    await page.close();
  },
);

// ───────────────────────────── saving a new address ─────────────────────────────

await app.check(
  "An address that is none of the customer's people can be saved as its contact, and is suggested after",
  async () => {
    const view = await app.open({ path: INVOICE_PATH, routes: routes() });
    const { page } = view;
    const dialog = await openInvoiceResend(view);
    const cc = field(dialog, "Cc");
    await expectSuggested(dialog, [
      "priya@optionmetrics.com",
      "chad@optionmetrics.com",
      "lin@lin-consulting.example",
      "ana@optionmetrics.com",
    ]);
    assert.equal(await dialog.getByRole("button", { name: /^Save as contact/ }).count(), 0);

    await cc.click();
    await cc.pressSequentially("new.person@optionmetrics.com,");
    await dialog
      .getByText("new.person@optionmetrics.com isn’t one of OptionMetrics’s contacts yet.", {
        exact: true,
      })
      .waitFor();
    // Always Cc is the company's own; it is never offered to save.
    await cc.pressSequentially("books@acme.test,");
    await dialog
      .getByText("new.person@optionmetrics.com isn’t one of OptionMetrics’s contacts yet.", {
        exact: true,
      })
      .waitFor();
    await view.click(dialog.getByRole("button", { name: "Save as contact", exact: true }));
    const saved = await view.waitForWrite((write) =>
      write.path.endsWith(`/customers/${CUSTOMER.slug}/contacts`),
    );
    assert.deepEqual(saved.body, { name: "New Person", email: "new.person@optionmetrics.com" });
    await dialog.getByRole("button", { name: /^Save as contact/ }).waitFor({ state: "detached" });
    assert.equal(
      view.writes.filter((write) => write.path.endsWith("/contacts")).length,
      1,
      "saved once",
    );

    // Taken off the email, they are one of the customer's people now.
    await view.click(
      dialog.getByRole("button", { name: "Remove new.person@optionmetrics.com", exact: true }),
    );
    await dialog.getByRole("button", { name: "Show 2 more", exact: true }).click();
    await dialog.locator('[data-suggestion="new.person@optionmetrics.com"]').waitFor();
    await page.close();
  },
);

// ───────────────────────────── loading and failing ─────────────────────────────

await app.check(
  "While suggestions load the dialog says so, a failed read can be retried, and neither stops the send",
  async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = await app.open({
      path: INVOICE_PATH,
      routes: routes({ holdSuggestions: held, failSuggestions: 1 }),
    });
    const { page } = view;
    const dialog = await openInvoiceResend(view);
    await dialog.getByText("Finding OptionMetrics's people…", { exact: true }).waitFor();
    release();
    await dialog
      .getByText("Couldn't load suggestions: The suggestions are taking a break", { exact: false })
      .waitFor();
    await view.click(dialog.getByRole("button", { name: "Try again", exact: true }));
    await expectSuggested(dialog, [
      "priya@optionmetrics.com",
      "chad@optionmetrics.com",
      "lin@lin-consulting.example",
      "ana@optionmetrics.com",
    ]);
    await view.click(dialog.getByRole("button", { name: "Resend email", exact: true }));
    const send = await view.waitForWrite((write) =>
      write.path.endsWith(`/invoices/${INVOICE_SLUG}/send`),
    );
    assert.deepEqual(send.body.to, [CUSTOMER.email]);
    assert.deepEqual(send.body.cc, []);
    await page.close();
  },
);

await app.check("A customer with nobody else to suggest says so", async () => {
  const view = await app.open({
    path: INVOICE_PATH,
    routes: routes({
      people: [person(CUSTOMER.email, { billing: true, sources: ["billing_email"] })],
    }),
  });
  const dialog = await openInvoiceResend(view);
  await dialog.getByText("Everyone suggested is on this email.", { exact: true }).waitFor();
  await view.click(dialog.getByRole("button", { name: `Remove ${CUSTOMER.email}`, exact: true }));
  await expectSuggested(dialog, [CUSTOMER.email]);
  const resend = dialog.getByRole("button", { name: "Resend email", exact: true });
  assert.equal(await resend.isDisabled(), true, "nobody on To: nothing to send");
  await view.page.close();

  const empty = await app.open({ path: INVOICE_PATH, routes: routes({ people: [] }) });
  const emptyDialog = await openInvoiceResend(empty);
  await emptyDialog
    .getByText("OptionMetrics has no contacts to suggest yet.", { exact: true })
    .waitFor();
  await empty.page.close();
});

// ───────────────────────────── estimates ─────────────────────────────

await app.check(
  "An estimate resends from the same dialog, with the same suggestions and no Always Cc",
  async () => {
    const view = await app.open({ path: ESTIMATE_PATH, routes: routes() });
    const { page } = view;
    await page.getByRole("heading", { name: ESTIMATE_NUMBER, level: 1 }).waitFor();
    await view.click(page.getByRole("button", { name: "More actions" }));
    await view.click(page.getByRole("menuitem", { name: "Resend email" }));
    const dialog = dialogOf(page, `Resend ${ESTIMATE_NUMBER}`);
    await dialog.waitFor();
    assert.equal(await dialog.getByText("Always Cc", { exact: true }).count(), 0);
    await dialog.getByText("Attach estimate as PDF", { exact: true }).waitFor();
    await dialog.getByText(`${ESTIMATE_NUMBER}.pdf`, { exact: true }).waitFor();
    // No Always Cc here, so the company's books@ is offered like anyone else.
    await expectSuggested(dialog, [
      "priya@optionmetrics.com",
      "books@acme.test",
      "chad@optionmetrics.com",
      "lin@lin-consulting.example",
    ]);
    await view.click(dialog.getByRole("button", { name: "Add Priya Shah to Cc", exact: true }));
    await dialog.getByLabel("Message (optional)").fill("The revised quote.");
    await dialog.getByText("Attach estimate as PDF", { exact: true }).click();
    assert.equal(sends(view, "estimates").length, 0, "the menu item no longer sends at once");
    await view.click(dialog.getByRole("button", { name: "Resend email", exact: true }));
    const send = await view.waitForWrite((write) =>
      write.path.endsWith(`/estimates/${ESTIMATE_SLUG}/send`),
    );
    assert.deepEqual(send.body, {
      to: [CUSTOMER.email],
      cc: ["priya@optionmetrics.com"],
      message: "The revised quote.",
      attachPdf: false,
    });
    await dialog.waitFor({ state: "detached" });
    await page.close();
  },
);

// ───────────────────────────── phone and dark ─────────────────────────────

await app.check("On a phone the dialog fits, and one tap still adds a contact", async () => {
  const view = await app.open({ path: INVOICE_PATH, routes: routes(), touch: true });
  const { page } = view;
  await page.getByRole("heading", { name: INVOICE_NUMBER, level: 1 }).waitFor();
  await page.getByRole("button", { name: "More actions" }).tap();
  await page.getByRole("menuitem", { name: "Resend email" }).tap();
  const dialog = dialogOf(page);
  await dialog.waitFor();
  await expectSuggested(dialog, [
    "priya@optionmetrics.com",
    "chad@optionmetrics.com",
    "lin@lin-consulting.example",
    "ana@optionmetrics.com",
  ]);
  await noSidewaysScroll(page, "the send dialog on a phone");
  const row = await dialog.locator('[data-suggestion="priya@optionmetrics.com"]').boundingBox();
  assert.ok(row && row.x >= 0 && row.x + row.width <= 390, "a suggestion fits the phone");
  await dialog.getByRole("button", { name: "Add Priya Shah to Cc", exact: true }).tap();
  await expectChips(dialog, "Cc", ["priya@optionmetrics.com"]);
  await app.shot(page, "contact-suggestions-phone");
  await page.close();
});

await app.check("In the dark the dialog keeps its contrast", async () => {
  const view = await app.open({ path: INVOICE_PATH, routes: routes(), scheme: "dark" });
  const { page } = view;
  const dialog = await openInvoiceResend(view);
  await view.click(dialog.getByRole("button", { name: "Add Priya Shah to Cc", exact: true }));
  await field(dialog, "Cc").pressSequentially("oops@nowhere,");
  await expectChips(dialog, "Cc", ["priya@optionmetrics.com", "oops@nowhere"]);
  const colors = await dialog.evaluate((node) => {
    const chip = node.querySelector('[data-recipient="priya@optionmetrics.com"]') as HTMLElement;
    const panel = node as HTMLElement;
    return {
      chip: getComputedStyle(chip).backgroundColor,
      panel: getComputedStyle(panel).backgroundColor,
      text: getComputedStyle(chip).color,
    };
  });
  assert.notEqual(colors.chip, colors.panel, "a chip stands out from the panel");
  assert.notEqual(colors.text, "rgb(15, 23, 42)", "chip text is not dark-on-dark");
  await app.shot(page, "contact-suggestions-dark");
  await page.close();
});

await app.finish();
