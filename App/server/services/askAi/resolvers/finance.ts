import { In } from "typeorm";
import { AppDataSource } from "../../../db/datasource.js";
import { Account } from "../../../db/entities/Account.js";
import { BankFeed } from "../../../db/entities/BankFeed.js";
import { BankTransaction } from "../../../db/entities/BankTransaction.js";
import { Bill } from "../../../db/entities/Bill.js";
import { BillPayment } from "../../../db/entities/BillPayment.js";
import { CompanyFinanceSettings } from "../../../db/entities/CompanyFinanceSettings.js";
import { Customer } from "../../../db/entities/Customer.js";
import { CustomerContact } from "../../../db/entities/CustomerContact.js";
import { CustomerCredit } from "../../../db/entities/CustomerCredit.js";
import { CustomerCreditApplication } from "../../../db/entities/CustomerCreditApplication.js";
import { CustomerRefund } from "../../../db/entities/CustomerRefund.js";
import { Estimate } from "../../../db/entities/Estimate.js";
import { Invoice } from "../../../db/entities/Invoice.js";
import { InvoicePayment } from "../../../db/entities/InvoicePayment.js";
import { InvoiceWriteOff } from "../../../db/entities/InvoiceWriteOff.js";
import { LedgerEntry } from "../../../db/entities/LedgerEntry.js";
import { RecurringInvoice } from "../../../db/entities/RecurringInvoice.js";
import { Subsidiary } from "../../../db/entities/Subsidiary.js";
import { TaxRate } from "../../../db/entities/TaxRate.js";
import { Vendor } from "../../../db/entities/Vendor.js";
import { VendorCredit } from "../../../db/entities/VendorCredit.js";
import { VendorCreditApplication } from "../../../db/entities/VendorCreditApplication.js";
import { VendorRefund } from "../../../db/entities/VendorRefund.js";
import { formatMoney } from "../../../lib/money.js";
import { financeAccessFor } from "../../../middleware/financeAccess.js";
import { UUID_RE } from "../../bases.js";
import {
  billDisplayStatus,
  hydrateBills,
  loadBillBySlug,
  loadVendorBySlug,
} from "../../bills.js";
import {
  creditOpenCents,
  getCreditLines,
  listApplicationsForInvoice,
  listCreditApplications,
  listCreditRefunds,
  loadCreditBySlug,
} from "../../customerCredits.js";
import {
  displayEstimateStatus,
  hydrateEstimates,
  loadEstimateBySlug,
} from "../../estimates.js";
import { displayStatus, hydrateInvoices, loadInvoiceBySlug } from "../../finance.js";
import {
  hydrateRecurringInvoices,
  loadRecurringInvoiceBySlug,
} from "../../recurringInvoices.js";
import { getLedgerEntryForReview, type HydratedLedgerEntry } from "../../transactionReviews.js";
import {
  getVendorCreditLines,
  listVendorApplicationsForBill,
  listVendorCreditApplications,
  listVendorCreditRefunds,
  loadVendorCreditBySlug,
  vendorCreditOpenCents,
} from "../../vendorCredits.js";
import { listInvoiceWriteOffs } from "../../writeOffs.js";
import {
  clip,
  day,
  facts,
  fenced,
  stamp,
  type AskAiContextItem,
  type AskAiGate,
  type AskAiMember,
  type AskAiResolver,
} from "../context.js";
import { employeeNames } from "./routines.js";

/**
 * Finance: invoices, credit notes, recurring invoices, estimates, bills,
 * vendors, vendor credits, ledger transactions, and the Customers they are
 * billed to.
 *
 * **Member side.** Every one of these is served by `routes/finance.ts`, whose
 * verbs are wrapped so a GET needs at least `read` finance access
 * (`requireFinanceRead`). That includes `GET /customers/:slug`, which is what
 * the Customers section's detail page reads — there is no finance-free route
 * to a Customer's billing record. So a Member whose effective access is
 * `none` resolves nothing here, exactly like a 403.
 *
 * **Employee side.** The finance MCP tools (`get_invoice`, `get_customer`,
 * `get_finance_transaction`, …) all start with `requireFinance(req, res,
 * "read")` over the employee's `EmployeeFinanceGrant`, so every item here sits
 * behind `{ type: "finance" }`. An employee without that Grant learns that a
 * finance record is open and nothing else.
 *
 * Money is stored in integer minor units beside a currency and is formatted
 * with `formatMoney`. Free text people typed — notes, footers, memos, line
 * descriptions, payment references — and text a bank sent is fenced. Bank
 * feed raw payloads and refund bank accounts are never described.
 */

const FINANCE_GATE: AskAiGate = { type: "finance" };
const MAX_REF_LENGTH = 300;
const MAX_LINES = 20;
const LINE_DESCRIPTION_CAP = 160;
const NOTE_CAP = 1_500;
const FOOTER_CAP = 600;
const REFERENCE_CAP = 120;
const RECENT_DOCUMENTS = 10;
const MAX_CONTACTS = 10;
const MAX_LIST_ROWS = 10;
const DAY_MS = 86_400_000;

const WITHHELD_HINT =
  "If the teammate wants you working with Finance, an owner or admin can grant you access under Finance → AI access.";

/**
 * The finance read rule, over the Member's effective access. Mirrors
 * `requireFinanceRead`: owners and admins are always `full`, anyone else needs
 * `read` or `full`. Anything unrecognised fails closed.
 */
function canReadFinance(member: AskAiMember): boolean {
  const access = financeAccessFor(member.role, member.financeAccess);
  return access === "read" || access === "full";
}

/** Load by UUID first, then by slug — refs from URLs carry slugs. */
async function byIdOrSlug<T>(
  raw: string,
  byId: (id: string) => Promise<T | null>,
  bySlug: (slug: string) => Promise<T | null>,
): Promise<T | null> {
  const key = raw.trim();
  if (!key || key.length > MAX_REF_LENGTH) return null;
  if (UUID_RE.test(key)) {
    const hit = await byId(key);
    if (hit) return hit;
  }
  return bySlug(key);
}

function money(cents: number, currency: string): string {
  return formatMoney(cents, currency);
}

/** A user-typed value squeezed onto one line, so it cannot start a heading. */
function oneLine(value: string | null | undefined, max = 200): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function quantity(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/** Free text the record carries, fenced under a heading — or nothing at all. */
function freeText(heading: string, text: string | null | undefined, max: number): string[] {
  const value = (text ?? "").trim();
  if (!value) return [];
  return ["", `### ${heading}`, fenced(clip(value, max))];
}

/** Rows that may hold user text, fenced as one block with an overflow note. */
function fencedList(rows: string[], empty: string, more?: string): string {
  if (rows.length === 0) return empty;
  const shown = rows.slice(0, MAX_LIST_ROWS);
  const out = [fenced(shown.join("\n"))];
  if (rows.length > shown.length) {
    out.push(`… ${rows.length - shown.length} more${more ? ` — ${more}` : ""}.`);
  }
  return out.join("\n");
}

type DocumentLine = {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxName?: string;
  taxPercent?: number;
  taxInclusive?: boolean;
  lineTotalCents?: number;
  account?: string | null;
};

/** Line items as `description — qty × price + tax = total`, fenced. */
function linesBlock(lines: DocumentLine[], currency: string, more: string): string {
  if (lines.length === 0) return "(no line items)";
  const shown = lines.slice(0, MAX_LINES).map((line, index) => {
    const tax =
      line.taxPercent && line.taxPercent > 0
        ? ` + ${oneLine(line.taxName, 40) || "tax"} ${line.taxPercent}%${line.taxInclusive ? " (inclusive)" : ""}`
        : "";
    const total = line.lineTotalCents !== undefined ? ` = ${money(line.lineTotalCents, currency)}` : "";
    const account = line.account ? ` [${line.account}]` : "";
    return `${index + 1}. ${oneLine(line.description, LINE_DESCRIPTION_CAP) || "(no description)"} — ${quantity(line.quantity)} × ${money(line.unitPriceCents, currency)}${tax}${total}${account}`;
  });
  const out = [fenced(shown.join("\n"))];
  if (lines.length > shown.length) {
    out.push(`… ${lines.length - shown.length} more line(s) — ${more}.`);
  }
  return out.join("\n");
}

function daysLate(due: Date, now: Date): number {
  return Math.floor((now.getTime() - due.getTime()) / DAY_MS);
}

/** `USD 1,200.00 · EUR 300.00` — balances in several currencies never add up. */
function totalsByCurrency(rows: Array<{ currency: string; cents: number }>): string {
  const sums = new Map<string, number>();
  for (const row of rows) sums.set(row.currency, (sums.get(row.currency) ?? 0) + row.cents);
  return [...sums.entries()]
    .filter(([, cents]) => cents !== 0)
    .map(([currency, cents]) => money(cents, currency))
    .join(" · ");
}

function financeBriefing(lines: (level: string) => string[]) {
  return (level: string): string => ["", ...lines(level)].join("\n");
}

const canRunReceivables = (level: string) => level === "invoice" || level === "full";

// ──────────────────────────── Customers ────────────────────────────────

const CUSTOMER_TOOLS = ["get_customer", "list_invoices", "list_estimates", "update_customer"];

async function customerItem(
  companyId: string,
  customer: Customer,
  primary: boolean,
): Promise<AskAiContextItem> {
  const now = new Date();
  const [contacts, recentInvoices, openInvoices, estimates, credits, owners] = await Promise.all([
    AppDataSource.getRepository(CustomerContact).find({
      where: { companyId, customerId: customer.id },
      order: { isPrimary: "DESC", sortOrder: "ASC", createdAt: "ASC" },
      take: MAX_CONTACTS + 1,
    }),
    AppDataSource.getRepository(Invoice).find({
      where: { companyId, customerId: customer.id },
      order: { createdAt: "DESC" },
      take: RECENT_DOCUMENTS + 1,
    }),
    AppDataSource.getRepository(Invoice).find({
      where: { companyId, customerId: customer.id, status: "sent" },
      select: ["id", "currency", "balanceCents", "dueDate"],
    }),
    AppDataSource.getRepository(Estimate).find({
      where: { companyId, customerId: customer.id },
      order: { createdAt: "DESC" },
      take: RECENT_DOCUMENTS + 1,
    }),
    AppDataSource.getRepository(CustomerCredit).find({
      where: { companyId, customerId: customer.id, status: "issued" },
    }),
    employeeNames(companyId, [customer.ownerEmployeeId]),
  ]);
  const owner = customer.ownerEmployeeId ? owners.get(customer.ownerEmployeeId) : undefined;
  const overdue = openInvoices.filter((inv) => inv.dueDate.getTime() < now.getTime());
  const outstanding = totalsByCurrency(
    openInvoices.map((inv) => ({ currency: inv.currency, cents: inv.balanceCents })),
  );
  const openCredits = totalsByCurrency(
    credits.map((credit) => ({ currency: credit.currency, cents: creditOpenCents(credit) })),
  );

  const parts: string[] = [
    facts([
      [
        "Customer",
        `${oneLine(customer.name)} (slug \`${customer.slug}\`, id ${customer.id}) — pass the slug as \`customerSlug\` to \`get_customer\`, \`list_invoices\` and \`list_estimates\``,
      ],
      ["Account status", customer.accountStatus],
      ["Archived", customer.archivedAt ? `yes, since ${day(customer.archivedAt)}` : null],
      ["Email", oneLine(customer.email)],
      ["Phone", oneLine(customer.phone)],
      ["Domain", oneLine(customer.domain)],
      ["Website", oneLine(customer.websiteUrl)],
      ["Industry", oneLine(customer.industry)],
      ["Billing currency", customer.currency],
      ["Tax number", oneLine(customer.taxNumber, 60)],
      [
        "Annual contract value",
        customer.annualContractValueCents > 0
          ? money(customer.annualContractValueCents, customer.currency)
          : null,
      ],
      ["Account owner (AI Employee)", owner ? `${owner.name} (@${owner.slug})` : null],
      [
        "Outstanding",
        openInvoices.length === 0
          ? "nothing — no sent invoice is awaiting payment"
          : `${outstanding || "0"} across ${openInvoices.length} sent invoice(s)${overdue.length ? `, ${overdue.length} overdue` : ""}`,
      ],
      ["Unapplied credit", openCredits || null],
      ["Customer since", day(customer.createdAt)],
    ]),
  ];

  const addresses = [
    customer.billingAddress.trim() ? `Billing:\n${clip(customer.billingAddress, 600)}` : "",
    customer.shippingAddress.trim() ? `Shipping:\n${clip(customer.shippingAddress, 600)}` : "",
  ].filter(Boolean);
  if (addresses.length) parts.push("", "### Addresses", fenced(addresses.join("\n\n")));

  parts.push("", `### Contacts`);
  parts.push(
    fencedList(
      contacts.slice(0, MAX_CONTACTS).map((ct) =>
        [
          `${oneLine(ct.name, 80)}${ct.isPrimary ? " (primary)" : ""}`,
          oneLine(ct.role, 60),
          oneLine(ct.email, 120),
          oneLine(ct.phone, 40),
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      "(no billing contacts — invoices go to the customer email)",
      contacts.length > MAX_CONTACTS ? "call `get_customer` for every contact" : undefined,
    ),
  );

  parts.push("", "### Recent invoices");
  if (recentInvoices.length === 0) parts.push("(none)");
  else {
    parts.push(
      ...recentInvoices.slice(0, RECENT_DOCUMENTS).map((inv) => {
        const status = displayStatus(inv, now);
        return `- ${inv.number || "draft"} (slug \`${inv.slug}\`) · ${status} · total ${money(inv.totalCents, inv.currency)} · balance ${money(inv.balanceCents, inv.currency)} · due ${day(inv.dueDate)}`;
      }),
    );
    if (recentInvoices.length > RECENT_DOCUMENTS) {
      parts.push("… older invoices omitted — use `list_invoices` with this customerSlug.");
    }
  }

  parts.push("", "### Recent estimates");
  if (estimates.length === 0) parts.push("(none)");
  else {
    parts.push(
      ...estimates.slice(0, RECENT_DOCUMENTS).map(
        (est) =>
          `- ${est.number || "draft"} (slug \`${est.slug}\`) · ${displayEstimateStatus(est, now)} · total ${money(est.totalCents, est.currency)} · valid until ${day(est.validUntil)}`,
      ),
    );
    if (estimates.length > RECENT_DOCUMENTS) {
      parts.push("… older estimates omitted — use `list_estimates` with this customerSlug.");
    }
  }
  parts.push(...freeText("Notes on the customer", customer.notes, NOTE_CAP));

  const item: AskAiContextItem = {
    kind: "customer",
    id: customer.id,
    label: `Customer ${oneLine(customer.name, 80)}`,
    sublabel: [
      customer.accountStatus,
      openInvoices.length ? `${openInvoices.length} open invoice(s)` : null,
      customer.archivedAt ? "archived" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    href: `/customers/${customer.slug}`,
    gate: FINANCE_GATE,
    body: parts.join("\n"),
    tools: CUSTOMER_TOOLS,
    withheldHint: WITHHELD_HINT,
  };
  if (primary && owner) item.defaultEmployeeIds = [owner.id];
  return item;
}

async function customerById(companyId: string, id: string): Promise<Customer | null> {
  return AppDataSource.getRepository(Customer).findOneBy({ id, companyId });
}

export const resolveCustomer: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const customer = await byIdOrSlug(
    ref.id,
    (id) => customerById(companyId, id),
    (slug) => AppDataSource.getRepository(Customer).findOneBy({ companyId, slug }),
  );
  if (!customer) return [];
  return [await customerItem(companyId, customer, true)];
};

// ──────────────────────────── Invoices ─────────────────────────────────

const INVOICE_TOOLS = [
  "get_invoice",
  "list_invoices",
  "get_customer",
  "send_invoice",
  "record_payment",
  "void_invoice",
];

function invoiceLabel(invoice: Pick<Invoice, "number">): string {
  return `Invoice ${invoice.number || "draft"}`;
}

async function invoiceItem(companyId: string, invoice: Invoice): Promise<AskAiContextItem> {
  const now = new Date();
  const [[hydrated], applications, writeOffs] = await Promise.all([
    hydrateInvoices(companyId, [invoice]),
    listApplicationsForInvoice(invoice.id),
    listInvoiceWriteOffs(companyId, invoice.id),
  ]);
  const creditIds = [...new Set(applications.map((a) => a.creditId))];
  const credits = creditIds.length
    ? await AppDataSource.getRepository(CustomerCredit).find({
        where: { id: In(creditIds), companyId },
        select: ["id", "number", "slug"],
      })
    : [];
  const creditById = new Map(credits.map((c) => [c.id, c]));
  const cur = invoice.currency;
  const status = displayStatus(invoice, now);
  const customer = hydrated?.customer ?? null;

  const parts: string[] = [
    facts([
      [
        "Invoice",
        `${invoice.number || "draft (not issued yet, so it has no number)"} (slug \`${invoice.slug}\`, id ${invoice.id}) — pass the slug as \`invoiceSlug\` to \`get_invoice\``,
      ],
      [
        "Status",
        status === invoice.status
          ? status
          : `${status} (stored status ${invoice.status})${status === "overdue" ? `, ${daysLate(invoice.dueDate, now)} day(s) past due` : ""}`,
      ],
      ["Customer", customer ? `${oneLine(customer.name)} (slug \`${customer.slug}\`)` : "missing"],
      ["Issued by", invoice.issuerSnapshot?.name ? oneLine(invoice.issuerSnapshot.name) : null],
      ["Issue date", day(invoice.issueDate)],
      ["Due date", day(invoice.dueDate)],
      ["Currency", cur],
      ["Subtotal", money(invoice.subtotalCents, cur)],
      ["Tax", money(invoice.taxCents, cur)],
      ["Total", money(invoice.totalCents, cur)],
      ["Paid", money(invoice.paidCents, cur)],
      ["Credited", invoice.creditedCents ? money(invoice.creditedCents, cur) : null],
      ["Written off", invoice.writtenOffCents ? money(invoice.writtenOffCents, cur) : null],
      ["Balance due", money(invoice.balanceCents, cur)],
      ["Sent", invoice.sentAt ? stamp(invoice.sentAt) : invoice.status === "draft" ? "not yet" : null],
      ["Paid in full", invoice.paidAt ? stamp(invoice.paidAt) : null],
      ["Voided", invoice.voidedAt ? stamp(invoice.voidedAt) : null],
    ]),
    "",
    `### Line items (${hydrated?.lines.length ?? 0})`,
    linesBlock(hydrated?.lines ?? [], cur, "call `get_invoice` for the rest"),
    "",
    `### Payments (${hydrated?.payments.length ?? 0})`,
    fencedList(
      (hydrated?.payments ?? []).map((p) =>
        [
          `${day(p.paidAt)} · ${money(p.amountCents, p.currency || cur)} · ${p.method}`,
          p.reference ? `ref ${oneLine(p.reference, REFERENCE_CAP)}` : "",
          p.notes ? oneLine(p.notes, REFERENCE_CAP) : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      "(no payments recorded)",
      "call `get_invoice` for every payment",
    ),
  ];
  if (applications.length) {
    parts.push(
      "",
      "### Credits applied",
      ...applications.slice(0, MAX_LIST_ROWS).map((a) => {
        const credit = creditById.get(a.creditId);
        return `- ${credit ? `${credit.number || "draft credit"} (slug \`${credit.slug}\`)` : "a credit note"} · ${money(a.amountCents, cur)} on ${day(a.appliedAt)}${a.reversedAt ? ` · reversed ${day(a.reversedAt)}` : ""}`;
      }),
    );
  }
  if (writeOffs.length) {
    parts.push(
      "",
      "### Write-offs",
      fencedList(
        writeOffs.map(
          (w) =>
            `${day(w.writeOffDate)} · ${w.kind.replace("_", " ")} · ${money(w.amountCents, w.currency)}${w.reversedAt ? ` · reversed ${day(w.reversedAt)}` : ""}${w.note ? ` · ${oneLine(w.note, REFERENCE_CAP)}` : ""}`,
        ),
        "",
      ),
    );
  }
  parts.push(...freeText("Notes printed on the invoice", invoice.notes, NOTE_CAP));
  parts.push(...freeText("Footer", invoice.footer, FOOTER_CAP));

  return {
    kind: "invoice",
    id: invoice.id,
    label: invoiceLabel(invoice),
    sublabel: [customer ? oneLine(customer.name, 60) : null, status].filter(Boolean).join(" · "),
    href: `/finance/invoices/${invoice.slug}`,
    gate: FINANCE_GATE,
    body: parts.join("\n"),
    tools: INVOICE_TOOLS,
    briefing: financeBriefing((level) => [
      `### ${invoiceLabel(invoice)}`,
      `The teammate has this invoice open. Your Finance access level is "${level}". Fetch the live record with \`get_invoice\` (invoiceSlug \`${invoice.slug}\`) before quoting a balance that may have moved.`,
      canRunReceivables(level)
        ? "A question about an invoice is not an instruction. Email it (`send_invoice`), record a payment (`record_payment`) or void it (`void_invoice`) only when the teammate explicitly asks — an email to a customer and a void cannot be taken back."
        : "Your level allows reading only: describe a send, payment or void for the teammate to do rather than attempting it.",
    ]),
    withheldHint: WITHHELD_HINT,
  };
}

export const resolveInvoice: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const invoice = await byIdOrSlug(
    ref.id,
    (id) => AppDataSource.getRepository(Invoice).findOneBy({ id, companyId }),
    (slug) => loadInvoiceBySlug(companyId, slug),
  );
  if (!invoice) return [];
  const customer = await customerById(companyId, invoice.customerId);
  return [
    await invoiceItem(companyId, invoice),
    ...(customer ? [await customerItem(companyId, customer, false)] : []),
  ];
};

// ──────────────────────────── Credit notes ─────────────────────────────

export const resolveCreditNote: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const credit = await byIdOrSlug(
    ref.id,
    (id) => AppDataSource.getRepository(CustomerCredit).findOneBy({ id, companyId }),
    (slug) => loadCreditBySlug(companyId, slug),
  );
  if (!credit) return [];
  const [lines, applications, refunds, customer, source] = await Promise.all([
    getCreditLines(credit.id),
    listCreditApplications(credit.id),
    listCreditRefunds(credit.id),
    customerById(companyId, credit.customerId),
    credit.sourceInvoiceId
      ? AppDataSource.getRepository(Invoice).findOneBy({ id: credit.sourceInvoiceId, companyId })
      : Promise.resolve(null),
  ]);
  const invoiceIds = [...new Set(applications.map((a) => a.invoiceId))];
  const invoices = invoiceIds.length
    ? await AppDataSource.getRepository(Invoice).find({
        where: { id: In(invoiceIds), companyId },
        select: ["id", "number", "slug"],
      })
    : [];
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const cur = credit.currency;
  const label = `Credit note ${credit.number || "draft"}`;

  const parts: string[] = [
    facts([
      ["Credit note", `${credit.number || "draft"} (slug \`${credit.slug}\`, id ${credit.id})`],
      [
        "Kind",
        credit.kind === "credit_memo"
          ? "credit memo"
          : credit.kind === "deposit"
            ? "customer deposit (prepayment)"
            : "overpayment credit",
      ],
      ["Status", credit.status],
      ["Customer", customer ? `${oneLine(customer.name)} (slug \`${customer.slug}\`)` : "missing"],
      [
        "Credits invoice",
        source ? `${source.number || "draft"} (slug \`${source.slug}\`) — described below` : null,
      ],
      ["Issue date", day(credit.issueDate)],
      ["Currency", cur],
      ["Subtotal", money(credit.subtotalCents, cur)],
      ["Tax", money(credit.taxCents, cur)],
      ["Total", money(credit.totalCents, cur)],
      ["Applied to invoices", money(credit.appliedCents, cur)],
      ["Refunded", credit.refundedCents ? money(credit.refundedCents, cur) : null],
      ["Open (unapplied)", money(creditOpenCents(credit), cur)],
      ["Voided", credit.voidedAt ? stamp(credit.voidedAt) : null],
    ]),
    "",
    `### Line items (${lines.length})`,
    linesBlock(lines, cur, "open the credit note for the rest"),
  ];
  if (applications.length) {
    parts.push(
      "",
      "### Applied to",
      ...applications.slice(0, MAX_LIST_ROWS).map((a) => {
        const inv = invoiceById.get(a.invoiceId);
        return `- ${inv ? `${inv.number || "draft"} (slug \`${inv.slug}\`)` : "an invoice"} · ${money(a.amountCents, cur)} on ${day(a.appliedAt)}${a.reversedAt ? ` · reversed ${day(a.reversedAt)}` : ""}`;
      }),
    );
  }
  if (refunds.length) {
    parts.push(
      "",
      "### Refunds",
      fencedList(
        refunds.map((r) =>
          [
            `${day(r.refundedAt)} · ${money(r.amountCents, r.currency || cur)} · ${oneLine(r.method, 40)}`,
            r.reference ? `ref ${oneLine(r.reference, REFERENCE_CAP)}` : "",
            r.reversedAt ? `reversed ${day(r.reversedAt)}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        "",
      ),
    );
  }
  parts.push(...freeText("Reason", credit.reason, NOTE_CAP));
  parts.push(...freeText("Notes", credit.notes, NOTE_CAP));

  const items: AskAiContextItem[] = [
    {
      kind: "credit_note",
      id: credit.id,
      label,
      sublabel: [customer ? oneLine(customer.name, 60) : null, credit.status].filter(Boolean).join(" · "),
      href: `/finance/credit-notes/${credit.slug}`,
      gate: FINANCE_GATE,
      body: parts.join("\n"),
      tools: ["get_invoice", "get_customer", "list_invoices"],
      withheldHint: WITHHELD_HINT,
    },
  ];
  if (customer) items.push(await customerItem(companyId, customer, false));
  if (source) items.push(await invoiceItem(companyId, source));
  return items;
};

// ──────────────────────── Recurring invoices ───────────────────────────

const FREQUENCY_UNIT: Record<RecurringInvoice["frequency"], string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  quarterly: "quarter",
  yearly: "year",
};

function cadence(ri: RecurringInvoice): string {
  const unit = FREQUENCY_UNIT[ri.frequency] ?? ri.frequency;
  const every = ri.intervalCount > 1 ? `every ${ri.intervalCount} ${unit}s` : `every ${unit}`;
  return `${every} (cron \`${ri.cronExpr}\`, server-local time)`;
}

export const resolveRecurringInvoice: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const ri = await byIdOrSlug(
    ref.id,
    (id) => AppDataSource.getRepository(RecurringInvoice).findOneBy({ id, companyId }),
    (slug) => loadRecurringInvoiceBySlug(companyId, slug),
  );
  if (!ri) return [];
  const [[hydrated], customer, subsidiary, lastInvoice] = await Promise.all([
    hydrateRecurringInvoices(companyId, [ri]),
    customerById(companyId, ri.customerId),
    ri.subsidiaryId
      ? AppDataSource.getRepository(Subsidiary).findOneBy({ id: ri.subsidiaryId, companyId })
      : Promise.resolve(null),
    ri.lastInvoiceSlug ? loadInvoiceBySlug(companyId, ri.lastInvoiceSlug) : Promise.resolve(null),
  ]);
  const lines = hydrated?.lines ?? [];
  const taxIds = [...new Set(lines.map((l) => l.taxRateId).filter((id): id is string => !!id))];
  const taxes = taxIds.length
    ? await AppDataSource.getRepository(TaxRate).find({ where: { id: In(taxIds), companyId } })
    : [];
  const taxById = new Map(taxes.map((t) => [t.id, t]));
  const cur = ri.currency;
  const perRun = lines.reduce((sum, l) => sum + Math.round(l.quantity * l.unitPriceCents), 0);
  const label = `Recurring invoice ${oneLine(ri.name, 80)}`;

  const body = [
    facts([
      [
        "Schedule",
        `${oneLine(ri.name)} (slug \`${ri.slug}\`, id ${ri.id}) — pass the slug as \`recurringInvoiceSlug\` to \`get_recurring_invoice\``,
      ],
      ["Status", ri.status],
      ["Customer", customer ? `${oneLine(customer.name)} (slug \`${customer.slug}\`)` : "missing"],
      ["Issued by", subsidiary ? oneLine(subsidiary.name) : null],
      ["Cadence", cadence(ri)],
      ["Anchor", ri.anchorAt ? day(ri.anchorAt) : null],
      [
        "Next run",
        ri.status === "active" ? (ri.nextRunAt ? stamp(ri.nextRunAt) : "none scheduled") : `not scheduled while ${ri.status}`,
      ],
      ["Last run", ri.lastRunAt ? stamp(ri.lastRunAt) : "never"],
      [
        "Last invoice",
        lastInvoice
          ? `${lastInvoice.number || "draft"} (slug \`${lastInvoice.slug}\`) · ${displayStatus(lastInvoice)}`
          : ri.lastInvoiceSlug
            ? `slug \`${ri.lastInvoiceSlug}\` (no longer found)`
            : null,
      ],
      ["Runs so far", `${ri.runsCreated}${ri.maxRuns ? ` of at most ${ri.maxRuns}` : ""}`],
      ["Ends on", ri.endsOn ? day(ri.endsOn) : null],
      [
        "Delivery",
        ri.autoSend
          ? "auto-send — each run issues the invoice, posts it to the ledger and emails the customer"
          : "draft — each run creates a draft invoice for a human to review and send",
      ],
      ["Payment terms", `due ${ri.daysUntilDue} day(s) after each run`],
      ["Currency", cur],
      ["Per run, before tax", money(perRun, cur)],
    ]),
    "",
    `### Template lines (${lines.length})`,
    linesBlock(
      lines.map((l) => {
        const tax = l.taxRateId ? taxById.get(l.taxRateId) : undefined;
        return {
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          taxName: tax?.name,
          taxPercent: tax?.ratePercent,
          taxInclusive: tax?.inclusive,
        };
      }),
      cur,
      "call `get_recurring_invoice` for the rest",
    ),
    ...freeText("Notes printed on each invoice", ri.notes, NOTE_CAP),
    ...freeText("Footer", ri.footer, FOOTER_CAP),
  ].join("\n");

  const items: AskAiContextItem[] = [
    {
      kind: "recurring_invoice",
      id: ri.id,
      label,
      sublabel: [customer ? oneLine(customer.name, 60) : null, ri.status].filter(Boolean).join(" · "),
      href: `/finance/recurring-invoices/${ri.slug}`,
      gate: FINANCE_GATE,
      body,
      tools: ["get_recurring_invoice", "list_recurring_invoices", "update_recurring_invoice", "get_customer"],
      briefing: financeBriefing((level) => [
        `### ${label}`,
        `The teammate has this recurring invoice schedule open. Your Finance access level is "${level}".`,
        canRunReceivables(level)
          ? "Change it with `update_recurring_invoice` only when the teammate explicitly asks. Turning on auto-send means every future run emails the customer without a human looking first — confirm that is what they want."
          : "Your level allows reading only: describe a change for the teammate to make rather than attempting it.",
      ]),
      withheldHint: WITHHELD_HINT,
    },
  ];
  if (customer) items.push(await customerItem(companyId, customer, false));
  return items;
};

// ──────────────────────────── Estimates ────────────────────────────────

export const resolveEstimate: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const estimate = await byIdOrSlug(
    ref.id,
    (id) => AppDataSource.getRepository(Estimate).findOneBy({ id, companyId }),
    (slug) => loadEstimateBySlug(companyId, slug),
  );
  if (!estimate) return [];
  const now = new Date();
  const [[hydrated], customer] = await Promise.all([
    hydrateEstimates(companyId, [estimate]),
    customerById(companyId, estimate.customerId),
  ]);
  const cur = estimate.currency;
  const status = displayEstimateStatus(estimate, now);
  const label = `Estimate ${estimate.number || "draft"}`;
  const outcome =
    estimate.acceptedAt
      ? `accepted ${stamp(estimate.acceptedAt)}`
      : estimate.declinedAt
        ? `declined ${stamp(estimate.declinedAt)}`
        : estimate.status === "sent"
          ? "awaiting the customer's answer"
          : null;

  const body = [
    facts([
      [
        "Estimate",
        `${estimate.number || "draft (not issued yet, so it has no number)"} (slug \`${estimate.slug}\`, id ${estimate.id}) — pass the slug as \`estimateSlug\` to \`get_estimate\``,
      ],
      ["Status", status === estimate.status ? status : `${status} (stored status ${estimate.status})`],
      ["Customer", customer ? `${oneLine(customer.name)} (slug \`${customer.slug}\`)` : "missing"],
      ["Issued by", estimate.issuerSnapshot?.name ? oneLine(estimate.issuerSnapshot.name) : null],
      ["Issue date", day(estimate.issueDate)],
      [
        "Valid until",
        `${day(estimate.validUntil)}${estimate.validUntil.getTime() < now.getTime() ? " (lapsed)" : ""}`,
      ],
      ["Customer response", outcome],
      [
        "Converted to invoice",
        hydrated?.invoice
          ? `${hydrated.invoice.number || "draft"} (slug \`${hydrated.invoice.slug}\`, ${hydrated.invoice.status}) on ${day(estimate.convertedAt)}`
          : null,
      ],
      ["Currency", cur],
      ["Subtotal", money(estimate.subtotalCents, cur)],
      ["Tax", money(estimate.taxCents, cur)],
      ["Total", money(estimate.totalCents, cur)],
      ["Sent", estimate.sentAt ? stamp(estimate.sentAt) : estimate.status === "draft" ? "not yet" : null],
      ["Voided", estimate.voidedAt ? stamp(estimate.voidedAt) : null],
    ]),
    "",
    `### Line items (${hydrated?.lines.length ?? 0})`,
    linesBlock(hydrated?.lines ?? [], cur, "call `get_estimate` for the rest"),
    ...freeText("Notes printed on the estimate", estimate.notes, NOTE_CAP),
    ...freeText("Footer", estimate.footer, FOOTER_CAP),
  ].join("\n");

  const items: AskAiContextItem[] = [
    {
      kind: "estimate",
      id: estimate.id,
      label,
      sublabel: [customer ? oneLine(customer.name, 60) : null, status].filter(Boolean).join(" · "),
      href: `/finance/estimates/${estimate.slug}`,
      gate: FINANCE_GATE,
      body,
      tools: ["get_estimate", "list_estimates", "issue_estimate", "send_estimate", "get_customer"],
      briefing: financeBriefing((level) => [
        `### ${label}`,
        `The teammate has this estimate open. Your Finance access level is "${level}". Issuing an estimate changes its slug — re-read it with \`get_estimate\` afterwards.`,
        canRunReceivables(level)
          ? "Issue (`issue_estimate`) or email it (`send_estimate`) only when the teammate explicitly asks; an email to a customer cannot be taken back."
          : "Your level allows reading only: describe an issue or send for the teammate to do rather than attempting it.",
      ]),
      withheldHint: WITHHELD_HINT,
    },
  ];
  if (customer) items.push(await customerItem(companyId, customer, false));
  return items;
};

// ──────────────────────────── Vendors ──────────────────────────────────

async function vendorItem(companyId: string, vendor: Vendor): Promise<AskAiContextItem> {
  const now = new Date();
  const [recentBills, openBills, credits] = await Promise.all([
    AppDataSource.getRepository(Bill).find({
      where: { companyId, vendorId: vendor.id },
      order: { createdAt: "DESC" },
      take: RECENT_DOCUMENTS + 1,
    }),
    AppDataSource.getRepository(Bill).find({
      where: { companyId, vendorId: vendor.id, status: "sent" },
      select: ["id", "currency", "balanceCents", "dueDate"],
    }),
    AppDataSource.getRepository(VendorCredit).find({
      where: { companyId, vendorId: vendor.id, status: "issued" },
    }),
  ]);
  const overdue = openBills.filter((b) => b.dueDate.getTime() < now.getTime());
  const owed = totalsByCurrency(openBills.map((b) => ({ currency: b.currency, cents: b.balanceCents })));
  const openCredits = totalsByCurrency(
    credits.map((c) => ({ currency: c.currency, cents: vendorCreditOpenCents(c) })),
  );

  const parts: string[] = [
    facts([
      ["Vendor", `${oneLine(vendor.name)} (slug \`${vendor.slug}\`, id ${vendor.id})`],
      ["Archived", vendor.archivedAt ? `yes, since ${day(vendor.archivedAt)}` : null],
      ["Email", oneLine(vendor.email)],
      ["Phone", oneLine(vendor.phone)],
      ["Currency", vendor.currency],
      ["Tax number", oneLine(vendor.taxNumber, 60)],
      [
        "We owe",
        openBills.length === 0
          ? "nothing — no unpaid bill"
          : `${owed || "0"} across ${openBills.length} unpaid bill(s)${overdue.length ? `, ${overdue.length} overdue` : ""}`,
      ],
      ["Unapplied vendor credit", openCredits || null],
    ]),
  ];
  if (vendor.address.trim()) parts.push("", "### Address", fenced(clip(vendor.address, 600)));
  parts.push("", "### Recent bills");
  if (recentBills.length === 0) parts.push("(none)");
  else {
    parts.push(
      ...recentBills.slice(0, RECENT_DOCUMENTS).map(
        (b) =>
          `- ${b.number || "draft"} (slug \`${b.slug}\`) · ${billDisplayStatus(b, now)} · total ${money(b.totalCents, b.currency)} · balance ${money(b.balanceCents, b.currency)} · due ${day(b.dueDate)}`,
      ),
    );
    if (recentBills.length > RECENT_DOCUMENTS) parts.push("… older bills omitted.");
  }
  parts.push(...freeText("Notes on the vendor", vendor.notes, NOTE_CAP));

  return {
    kind: "vendor",
    id: vendor.id,
    label: `Vendor ${oneLine(vendor.name, 80)}`,
    sublabel: [
      openBills.length ? `${openBills.length} unpaid bill(s)` : "no unpaid bills",
      vendor.archivedAt ? "archived" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    href: "/finance/vendors",
    gate: FINANCE_GATE,
    body: parts.join("\n"),
    withheldHint: WITHHELD_HINT,
  };
}

async function vendorById(companyId: string, id: string): Promise<Vendor | null> {
  return AppDataSource.getRepository(Vendor).findOneBy({ id, companyId });
}

export const resolveVendor: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const vendor = await byIdOrSlug(
    ref.id,
    (id) => vendorById(companyId, id),
    (slug) => loadVendorBySlug(companyId, slug),
  );
  if (!vendor) return [];
  return [await vendorItem(companyId, vendor)];
};

// ──────────────────────────── Bills ────────────────────────────────────

async function accountNames(companyId: string, ids: Array<string | null>): Promise<Map<string, Account>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await AppDataSource.getRepository(Account).find({
    where: { id: In(wanted), companyId },
  });
  return new Map(rows.map((a) => [a.id, a]));
}

function accountName(account: Account | undefined): string | null {
  return account ? `${account.code} ${oneLine(account.name, 60)}` : null;
}

export const resolveBill: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const bill = await byIdOrSlug(
    ref.id,
    (id) => AppDataSource.getRepository(Bill).findOneBy({ id, companyId }),
    (slug) => loadBillBySlug(companyId, slug),
  );
  if (!bill) return [];
  const now = new Date();
  const [[hydrated], applications, vendor] = await Promise.all([
    hydrateBills(companyId, [bill]),
    listVendorApplicationsForBill(bill.id),
    vendorById(companyId, bill.vendorId),
  ]);
  const lines = hydrated?.lines ?? [];
  const creditIds = [...new Set(applications.map((a) => a.creditId))];
  const [accounts, credits] = await Promise.all([
    accountNames(companyId, lines.map((l) => l.expenseAccountId)),
    creditIds.length
      ? AppDataSource.getRepository(VendorCredit).find({
          where: { id: In(creditIds), companyId },
          select: ["id", "number", "slug"],
        })
      : Promise.resolve([] as VendorCredit[]),
  ]);
  const creditById = new Map(credits.map((c) => [c.id, c]));
  const cur = bill.currency;
  const status = billDisplayStatus(bill, now);
  const label = `Bill ${bill.number || "draft"}`;

  const parts: string[] = [
    facts([
      ["Bill", `${bill.number || "draft (not entered yet, so it has no number)"} (slug \`${bill.slug}\`, id ${bill.id})`],
      ["Vendor's reference", bill.vendorRef ? oneLine(bill.vendorRef, REFERENCE_CAP) : null],
      [
        "Status",
        status === bill.status
          ? status
          : `${status} (stored status ${bill.status}), ${daysLate(bill.dueDate, now)} day(s) past due`,
      ],
      ["Vendor", vendor ? `${oneLine(vendor.name)} (slug \`${vendor.slug}\`)` : "missing"],
      ["Issue date", day(bill.issueDate)],
      ["Due date", day(bill.dueDate)],
      ["Received", bill.receivedAt ? day(bill.receivedAt) : null],
      ["Currency", cur],
      ["Subtotal", money(bill.subtotalCents, cur)],
      ["Tax", money(bill.taxCents, cur)],
      ["Total", money(bill.totalCents, cur)],
      ["Paid", money(bill.paidCents, cur)],
      ["Vendor credits applied", bill.creditedCents ? money(bill.creditedCents, cur) : null],
      ["Balance owed", money(bill.balanceCents, cur)],
      ["Paid in full", bill.paidAt ? stamp(bill.paidAt) : null],
      ["Voided", bill.voidedAt ? stamp(bill.voidedAt) : null],
    ]),
    "",
    `### Line items (${lines.length})`,
    linesBlock(
      lines.map((l) => ({ ...l, account: accountName(accounts.get(l.expenseAccountId ?? "")) })),
      cur,
      "open the bill for the rest",
    ),
    "",
    `### Payments (${hydrated?.payments.length ?? 0})`,
    fencedList(
      (hydrated?.payments ?? []).map((p) =>
        [
          `${day(p.paidAt)} · ${money(p.amountCents, p.currency || cur)} · ${p.method}`,
          p.reference ? `ref ${oneLine(p.reference, REFERENCE_CAP)}` : "",
          p.notes ? oneLine(p.notes, REFERENCE_CAP) : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      "(no payments recorded)",
    ),
  ];
  if (applications.length) {
    parts.push(
      "",
      "### Vendor credits applied",
      ...applications.slice(0, MAX_LIST_ROWS).map((a) => {
        const credit = creditById.get(a.creditId);
        return `- ${credit ? `${credit.number || "draft credit"} (slug \`${credit.slug}\`)` : "a vendor credit"} · ${money(a.amountCents, cur)} on ${day(a.appliedAt)}${a.reversedAt ? ` · reversed ${day(a.reversedAt)}` : ""}`;
      }),
    );
  }
  parts.push(...freeText("Notes", bill.notes, NOTE_CAP));

  const items: AskAiContextItem[] = [
    {
      kind: "bill",
      id: bill.id,
      label,
      sublabel: [vendor ? oneLine(vendor.name, 60) : null, status].filter(Boolean).join(" · "),
      href: `/finance/bills/${bill.slug}`,
      gate: FINANCE_GATE,
      body: parts.join("\n"),
      withheldHint: WITHHELD_HINT,
    },
  ];
  if (vendor) items.push(await vendorItem(companyId, vendor));
  return items;
};

// ──────────────────────────── Vendor credits ───────────────────────────

export const resolveVendorCredit: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const credit = await byIdOrSlug(
    ref.id,
    (id) => AppDataSource.getRepository(VendorCredit).findOneBy({ id, companyId }),
    (slug) => loadVendorCreditBySlug(companyId, slug),
  );
  if (!credit) return [];
  const [lines, applications, refunds, vendor, source] = await Promise.all([
    getVendorCreditLines(credit.id),
    listVendorCreditApplications(credit.id),
    listVendorCreditRefunds(credit.id),
    vendorById(companyId, credit.vendorId),
    credit.sourceBillId
      ? AppDataSource.getRepository(Bill).findOneBy({ id: credit.sourceBillId, companyId })
      : Promise.resolve(null),
  ]);
  const billIds = [...new Set(applications.map((a) => a.billId))];
  const [bills, accounts] = await Promise.all([
    billIds.length
      ? AppDataSource.getRepository(Bill).find({
          where: { id: In(billIds), companyId },
          select: ["id", "number", "slug"],
        })
      : Promise.resolve([] as Bill[]),
    accountNames(companyId, lines.map((l) => l.expenseAccountId)),
  ]);
  const billById = new Map(bills.map((b) => [b.id, b]));
  const cur = credit.currency;
  const label = `Vendor credit ${credit.number || "draft"}`;

  const parts: string[] = [
    facts([
      ["Vendor credit", `${credit.number || "draft"} (slug \`${credit.slug}\`, id ${credit.id})`],
      ["Status", credit.status],
      ["Vendor", vendor ? `${oneLine(vendor.name)} (slug \`${vendor.slug}\`)` : "missing"],
      ["Raised against bill", source ? `${source.number || "draft"} (slug \`${source.slug}\`)` : null],
      ["Issue date", day(credit.issueDate)],
      ["Currency", cur],
      ["Subtotal", money(credit.subtotalCents, cur)],
      ["Tax", money(credit.taxCents, cur)],
      ["Total", money(credit.totalCents, cur)],
      ["Applied to bills", money(credit.appliedCents, cur)],
      ["Refunded by the vendor", credit.refundedCents ? money(credit.refundedCents, cur) : null],
      ["Open (unapplied)", money(vendorCreditOpenCents(credit), cur)],
      ["Voided", credit.voidedAt ? stamp(credit.voidedAt) : null],
    ]),
    "",
    `### Line items (${lines.length})`,
    linesBlock(
      lines.map((l) => ({ ...l, account: accountName(accounts.get(l.expenseAccountId ?? "")) })),
      cur,
      "open the vendor credit for the rest",
    ),
  ];
  if (applications.length) {
    parts.push(
      "",
      "### Applied to",
      ...applications.slice(0, MAX_LIST_ROWS).map((a) => {
        const bill = billById.get(a.billId);
        return `- ${bill ? `${bill.number || "draft"} (slug \`${bill.slug}\`)` : "a bill"} · ${money(a.amountCents, cur)} on ${day(a.appliedAt)}${a.reversedAt ? ` · reversed ${day(a.reversedAt)}` : ""}`;
      }),
    );
  }
  if (refunds.length) {
    parts.push(
      "",
      "### Refunds received",
      fencedList(
        refunds.map((r) =>
          [
            `${day(r.refundedAt)} · ${money(r.amountCents, r.currency || cur)} · ${oneLine(r.method, 40)}`,
            r.reference ? `ref ${oneLine(r.reference, REFERENCE_CAP)}` : "",
            r.reversedAt ? `reversed ${day(r.reversedAt)}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
        "",
      ),
    );
  }
  parts.push(...freeText("Reason", credit.reason, NOTE_CAP));
  parts.push(...freeText("Notes", credit.notes, NOTE_CAP));

  const items: AskAiContextItem[] = [
    {
      kind: "vendor_credit",
      id: credit.id,
      label,
      sublabel: [vendor ? oneLine(vendor.name, 60) : null, credit.status].filter(Boolean).join(" · "),
      href: `/finance/vendor-credits/${credit.slug}`,
      gate: FINANCE_GATE,
      body: parts.join("\n"),
      withheldHint: WITHHELD_HINT,
    },
  ];
  if (vendor) items.push(await vendorItem(companyId, vendor));
  return items;
};

// ──────────────────── Ledger transactions / journal ────────────────────

const LEDGER_SOURCE_LABELS: Partial<Record<LedgerEntry["source"], string>> = {
  manual: "manual entry",
  invoice_issue: "invoice issued",
  invoice_payment: "invoice payment",
  invoice_void: "invoice void / payment reversal",
  credit_note_issue: "credit note issued",
  credit_note_apply: "credit note applied",
  credit_note_unapply: "credit note unapplied",
  credit_note_void: "credit note voided",
  customer_refund: "customer refund",
  customer_refund_void: "customer refund reversed",
  invoice_writeoff: "invoice write-off",
  invoice_writeoff_reversal: "write-off reversed",
  vendor_credit_issue: "vendor credit issued",
  vendor_credit_apply: "vendor credit applied",
  vendor_credit_unapply: "vendor credit unapplied",
  vendor_credit_void: "vendor credit voided",
  vendor_refund: "vendor refund",
  vendor_refund_void: "vendor refund reversed",
  bank_categorization: "bank transaction categorized",
  bank_categorization_void: "bank categorization reversed",
  brex_card_expense: "card expense",
  brex_card_refund: "card refund",
  brex_card_payment: "card payment",
  brex_card_reclass: "card expense recategorized",
  ledger_reclass: "category change",
};

const REVIEW_LABELS: Record<LedgerEntry["reviewStatus"], string> = {
  unreviewed: "needs review",
  ai_reviewed: "AI reviewed — waiting for a human's final approval",
  approved: "approved",
};

function sourceLabel(source: string): string {
  return LEDGER_SOURCE_LABELS[source as LedgerEntry["source"]] ?? source.replaceAll("_", " ");
}

function invoiceRef(inv: Invoice): string {
  return `invoice ${inv.number || "draft"} (slug \`${inv.slug}\`)`;
}

/**
 * What produced this entry, by following `sourceRefId` to the record it
 * names. Each hop re-checks `companyId` so a stale ref can never surface
 * another company's document; anything unrecognised just says so.
 */
async function describeLedgerSource(companyId: string, entry: LedgerEntry): Promise<string | null> {
  const raw = entry.sourceRefId ?? "";
  if (!raw) return null;
  const colon = raw.indexOf(":");
  const prefix = colon > 0 ? raw.slice(0, colon) : "";
  const refId = colon > 0 ? raw.slice(colon + 1) : raw;
  if (!UUID_RE.test(refId)) return `source reference \`${oneLine(raw, 80)}\``;
  const repo = AppDataSource.getRepository.bind(AppDataSource);
  const invoiceBy = (id: string) => repo(Invoice).findOneBy({ id, companyId });
  const billBy = (id: string) => repo(Bill).findOneBy({ id, companyId });
  const billRef = (b: Bill) => `bill ${b.number || "draft"} (slug \`${b.slug}\`)`;
  const creditRef = (c: CustomerCredit) => `credit note ${c.number || "draft"} (slug \`${c.slug}\`)`;
  const vendorCreditRef = (c: VendorCredit) =>
    `vendor credit ${c.number || "draft"} (slug \`${c.slug}\`)`;

  if (prefix === "bill_issue") {
    const bill = await billBy(refId);
    return bill ? billRef(bill) : null;
  }
  if (prefix === "bill_payment") {
    const payment = await repo(BillPayment).findOneBy({ id: refId });
    const bill = payment ? await billBy(payment.billId) : null;
    return bill ? `a payment on ${billRef(bill)}` : null;
  }
  if (prefix === "finance_proposal") return `an approved finance proposal (id ${refId})`;
  if (prefix) return null;

  switch (entry.source) {
    case "invoice_issue":
    case "invoice_void": {
      const inv = await invoiceBy(refId);
      return inv ? invoiceRef(inv) : null;
    }
    case "invoice_payment": {
      const payment = await repo(InvoicePayment).findOneBy({ id: refId });
      const inv = payment ? await invoiceBy(payment.invoiceId) : null;
      return inv ? `a payment on ${invoiceRef(inv)}` : null;
    }
    case "invoice_writeoff":
    case "invoice_writeoff_reversal": {
      const writeOff = await repo(InvoiceWriteOff).findOneBy({ id: refId, companyId });
      const inv = writeOff ? await invoiceBy(writeOff.invoiceId) : null;
      return inv ? `a write-off on ${invoiceRef(inv)}` : null;
    }
    case "credit_note_issue":
    case "credit_note_void": {
      const credit = await repo(CustomerCredit).findOneBy({ id: refId, companyId });
      return credit ? creditRef(credit) : null;
    }
    case "credit_note_apply":
    case "credit_note_unapply": {
      const app = await repo(CustomerCreditApplication).findOneBy({ id: refId, companyId });
      if (!app) return null;
      const [credit, inv] = await Promise.all([
        repo(CustomerCredit).findOneBy({ id: app.creditId, companyId }),
        invoiceBy(app.invoiceId),
      ]);
      return `${credit ? creditRef(credit) : "a credit note"} applied to ${inv ? invoiceRef(inv) : "an invoice"}`;
    }
    case "customer_refund":
    case "customer_refund_void": {
      const refund = await repo(CustomerRefund).findOneBy({ id: refId, companyId });
      const credit = refund
        ? await repo(CustomerCredit).findOneBy({ id: refund.creditId, companyId })
        : null;
      return credit ? `a refund of ${creditRef(credit)}` : null;
    }
    case "vendor_credit_issue":
    case "vendor_credit_void": {
      const credit = await repo(VendorCredit).findOneBy({ id: refId, companyId });
      return credit ? vendorCreditRef(credit) : null;
    }
    case "vendor_credit_apply":
    case "vendor_credit_unapply": {
      const app = await repo(VendorCreditApplication).findOneBy({ id: refId, companyId });
      if (!app) return null;
      const [credit, bill] = await Promise.all([
        repo(VendorCredit).findOneBy({ id: app.creditId, companyId }),
        billBy(app.billId),
      ]);
      return `${credit ? vendorCreditRef(credit) : "a vendor credit"} applied to ${bill ? billRef(bill) : "a bill"}`;
    }
    case "vendor_refund":
    case "vendor_refund_void": {
      const refund = await repo(VendorRefund).findOneBy({ id: refId, companyId });
      const credit = refund
        ? await repo(VendorCredit).findOneBy({ id: refund.creditId, companyId })
        : null;
      return credit ? `a refund of ${vendorCreditRef(credit)}` : null;
    }
    default:
      return null;
  }
}

async function ledgerBody(
  companyId: string,
  entry: HydratedLedgerEntry,
): Promise<{ body: string; homeCurrency: string }> {
  const [settings, source, bankRows] = await Promise.all([
    AppDataSource.getRepository(CompanyFinanceSettings).findOneBy({ companyId }),
    describeLedgerSource(companyId, entry),
    AppDataSource.getRepository(BankTransaction).find({
      where: [
        { companyId, matchedLedgerEntryId: entry.id },
        ...(entry.source === "bank_categorization" && entry.sourceRefId && UUID_RE.test(entry.sourceRefId)
          ? [{ companyId, id: entry.sourceRefId }]
          : []),
      ],
      take: 5,
    }),
  ]);
  const home = settings?.homeCurrency || "USD";
  const accounts = await accountNames(companyId, [
    ...entry.lines.map((l) => l.accountId),
    ...entry.reviewChanges.flatMap((c) => [c.fromAccountId, c.toAccountId]),
  ]);
  const feedIds = [...new Set(bankRows.map((t) => t.feedId))];
  const feeds = feedIds.length
    ? await AppDataSource.getRepository(BankFeed).find({ where: { id: In(feedIds), companyId } })
    : [];
  const feedById = new Map(feeds.map((f) => [f.id, f]));
  const lineById = new Map(entry.lines.map((l) => [l.id, l]));

  const lineRows = entry.lines.map((l) => {
    const side = l.debitCents > 0 ? `DR ${money(l.debitCents, home)}` : `CR ${money(l.creditCents, home)}`;
    const orig =
      l.origCurrency && l.origCurrency !== home && l.origAmountCents
        ? ` (originally ${money(Math.abs(l.origAmountCents), l.origCurrency)} at ${l.rate})`
        : "";
    const desc = l.description ? ` — ${oneLine(l.description, LINE_DESCRIPTION_CAP)}` : "";
    return `${accountName(accounts.get(l.accountId)) ?? "(missing account)"} · ${side}${orig}${desc} [line id ${l.id}]`;
  });

  const parts: string[] = [
    facts([
      [
        "Transaction id",
        `${entry.id} — pass as \`transactionId\` to \`get_finance_transaction\``,
      ],
      ["Date", day(entry.date)],
      ["Source", sourceLabel(entry.source)],
      ["Produced by", source],
      ["Amount", `${money(entry.totalCents, home)} (home currency; debits equal credits)`],
      ["Review", REVIEW_LABELS[entry.reviewStatus] ?? entry.reviewStatus],
      [
        "AI review",
        entry.reviewedByEmployee
          ? `${entry.reviewedByEmployee.name} (@${entry.reviewedByEmployee.slug}) on ${stamp(entry.reviewedAt)}`
          : null,
      ],
      ["Approved", entry.approvedAt ? stamp(entry.approvedAt) : null],
      ["Posted", stamp(entry.createdAt)],
    ]),
    ...freeText("Memo", entry.memo, NOTE_CAP),
    "",
    `### Lines (${entry.lines.length})`,
    entry.lines.length
      ? fenced(lineRows.slice(0, MAX_LINES).join("\n")) +
        (lineRows.length > MAX_LINES
          ? `\n… ${lineRows.length - MAX_LINES} more line(s) — call \`get_finance_transaction\`.`
          : "")
      : "(no lines)",
  ];
  if (entry.reviewChanges.length) {
    parts.push(
      "",
      "### Staged category changes (not posted until a human approves)",
      ...entry.reviewChanges.slice(0, MAX_LIST_ROWS).map((c) => {
        const line = lineById.get(c.lineId);
        const amount = line
          ? ` (${line.debitCents > 0 ? money(line.debitCents, home) : money(line.creditCents, home)})`
          : "";
        return `- line ${c.lineId}${amount}: ${accountName(accounts.get(c.fromAccountId)) ?? "?"} → ${accountName(accounts.get(c.toAccountId)) ?? "?"}`;
      }),
    );
  }
  parts.push(...freeText("Review note", entry.reviewNote, NOTE_CAP));
  if (bankRows.length) {
    parts.push(
      "",
      "### Matched bank transactions",
      fenced(
        bankRows
          .map(
            (t) =>
              `${day(t.date)} · ${money(t.amountCents, home)} · ${oneLine(feedById.get(t.feedId)?.name, 60) || "bank feed"}${t.reconciledAt ? " · reconciled" : ""} · ${oneLine(t.description, LINE_DESCRIPTION_CAP)}`,
          )
          .join("\n"),
      ),
    );
  }
  return { body: parts.join("\n"), homeCurrency: home };
}

async function loadLedgerEntry(companyId: string, raw: string): Promise<HydratedLedgerEntry | null> {
  const id = raw.trim();
  if (!UUID_RE.test(id)) return null;
  return getLedgerEntryForReview(companyId, id);
}

export const resolveTransaction: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const entry = await loadLedgerEntry(companyId, ref.id);
  if (!entry) return [];
  const { body } = await ledgerBody(companyId, entry);
  return [
    {
      kind: "transaction",
      id: entry.id,
      label: `Transaction ${day(entry.date)}`,
      sublabel: `${sourceLabel(entry.source)} · ${REVIEW_LABELS[entry.reviewStatus]?.split(" — ")[0] ?? entry.reviewStatus}`,
      href: `/finance/transactions?status=${entry.reviewStatus}`,
      gate: FINANCE_GATE,
      body,
      tools: ["get_finance_transaction", "list_finance_accounts", "review_finance_transaction"],
      briefing: financeBriefing((level) => [
        `### Transaction ${entry.id}`,
        `The teammate has this accounting transaction open on the review queue. Your Finance access level is "${level}".`,
        level === "full"
          ? "`review_finance_transaction` only stages your category proposal (or confirms the current categories) for an owner or admin to approve — it never posts or approves anything. Use account ids from `list_finance_accounts`, and only when the teammate asks for a review. Never describe a staged proposal as approved."
          : "Reviewing transactions needs the full Finance level, which you do not have: explain what you would recategorize and why instead.",
      ]),
      withheldHint: WITHHELD_HINT,
    },
  ];
};

export const resolveJournalEntry: AskAiResolver = async ({ companyId, member, ref }) => {
  if (!canReadFinance(member)) return [];
  const entry = await loadLedgerEntry(companyId, ref.id);
  if (!entry) return [];
  const { body } = await ledgerBody(companyId, entry);
  return [
    {
      kind: "journal_entry",
      id: entry.id,
      label: `Journal entry ${day(entry.date)}`,
      sublabel: sourceLabel(entry.source),
      href: "/finance/journal",
      gate: FINANCE_GATE,
      body,
      tools: ["get_finance_transaction", "list_finance_accounts"],
      withheldHint: WITHHELD_HINT,
    },
  ];
};
