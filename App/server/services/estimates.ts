import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Estimate, EstimateStatus } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { formatEstimateNumber, formatMoney } from "../lib/money.js";
import { sendEmail } from "./email.js";
import { renderEstimateHtmlForCompany } from "./estimateHtml.js";
import { renderPdfAttachment } from "./htmlToPdf.js";
import {
  type DiscountInput,
  discountOf,
  issueInvoice,
  keptTaxSnapshots,
  type LineDraft,
  type LineTaxSnapshot,
  linesUnchanged,
  priceLineDrafts,
  requestedDiscount,
  sameDiscount,
  sameUtcDay,
} from "./finance.js";
import { type DocumentDiscount, documentTotals } from "../../shared/documentDiscount.js";
import { resolveDocumentIssuer } from "./subsidiaries.js";

/**
 * Estimate service — pure orchestration over the Estimate + line item
 * entities. Mirrors `services/finance.ts` for invoices, minus payments
 * and ledger posting (estimates do not affect the books — only the
 * invoices they convert into do).
 *
 * Conventions:
 *   - All cent columns are recomputed from the line items; callers never
 *     write them directly.
 *   - Status transitions are forward-only:
 *       draft → sent → accepted | declined | void
 *     The one step back: editing an accepted estimate returns it to
 *     `sent`, because the customer accepted the earlier version.
 *     A `sent` (or `accepted`) estimate past its `validUntil` is
 *     rendered as `expired` at read time, but the stored status does
 *     not change so changing the system clock can't corrupt records.
 *   - Numbering is gapless per company. Sequence is minted in the same
 *     logical unit-of-work as the issue transition so two concurrent
 *     issues don't race for the same seq.
 *   - Converting an accepted estimate to an invoice is one-shot: the
 *     estimate's `invoiceId` is set and the resulting invoice is
 *     immediately issued so it lands on the books with a real number.
 */

// ───────────────────────────── Numbering ──────────────────────────────

/**
 * Mint the next gapless estimate sequence for a (company, customer)
 * pair — each customer has their own counter starting at 1. Slug
 * uniqueness within the company is handled at issue time by prefixing
 * the customer slug. See `mintNextInvoiceSeq` for the Postgres
 * concurrency note.
 */
export async function mintNextEstimateSeq(
  companyId: string,
  customerId: string,
): Promise<number> {
  const last = await AppDataSource.getRepository(Estimate).findOne({
    where: { companyId, customerId },
    order: { numberSeq: "DESC" },
    select: ["numberSeq"],
  });
  return (last?.numberSeq ?? 0) + 1;
}

// ───────────────────────── Tax + Product snapshots ─────────────────────

/**
 * Replace all line items on an estimate with the supplied drafts. Used
 * by both the create flow and the edit flow. Lines are priced the same way
 * an invoice's are (`finance.ts > priceLineDrafts()`); `kept` carries an
 * issued estimate's tax snapshots.
 */
export async function replaceEstimateLines(
  estimate: Estimate,
  drafts: LineDraft[],
  kept?: ReadonlyMap<string, LineTaxSnapshot>,
): Promise<EstimateLineItem[]> {
  const lineRepo = AppDataSource.getRepository(EstimateLineItem);
  await lineRepo.delete({ estimateId: estimate.id });
  if (drafts.length === 0) return [];
  const priced = await priceLineDrafts(estimate.companyId, drafts, kept);
  return await lineRepo.save(
    priced.map((line) => lineRepo.create({ estimateId: estimate.id, ...line })),
  );
}

// ───────────────────────────── Recompute ──────────────────────────────

/**
 * Re-derive `subtotalCents` / `discountCents` / `taxCents` / `totalCents`
 * from the current lines and discount (`shared/documentDiscount.ts`). Saves
 * and returns the estimate. Idempotent — call after any line or discount
 * write. Status is not touched: estimates carry no payments so there's no
 * automatic status flip equivalent to the invoice `paid` transition.
 */
export async function recomputeEstimateTotals(estimate: Estimate): Promise<Estimate> {
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
  });
  Object.assign(estimate, documentTotals(lines, discountOf(estimate)));
  return AppDataSource.getRepository(Estimate).save(estimate);
}

// ───────────────────────────── Draft creation ─────────────────────────

export type CreateEstimateDraftInput = DiscountInput & {
  companyId: string;
  customerId: string;
  subsidiaryId?: string | null;
  issueDate?: Date;
  validUntil?: Date;
  currency?: string;
  notes?: string;
  footer?: string;
  lines?: LineDraft[];
  createdById?: string | null;
};

/**
 * Create an unnumbered estimate draft through one shared path for Members and
 * AI Employees. A draft has no ledger effect and is not emailed; numbering is
 * minted only when a Member or an authorized AI Employee later issues it.
 */
export async function createEstimateDraft(input: CreateEstimateDraftInput): Promise<Estimate> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: input.customerId,
    companyId: input.companyId,
  });
  if (!customer) throw new Error("Invalid customer");
  const discount = requestedDiscount(input);
  const issuer = await resolveDocumentIssuer(input.companyId, input.subsidiaryId);

  const issueDate = input.issueDate ?? new Date();
  const validUntil =
    input.validUntil ?? new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const repo = AppDataSource.getRepository(Estimate);
  const estimate = repo.create({
    companyId: input.companyId,
    customerId: customer.id,
    ...issuer,
    slug: await uniqueDraftEstimateSlug(input.companyId),
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    validUntil,
    currency: input.currency ?? customer.currency ?? "USD",
    ...discount,
    notes: input.notes ?? "",
    footer: input.footer ?? "",
    createdById: input.createdById ?? null,
  });
  await repo.save(estimate);
  if (input.lines?.length) await replaceEstimateLines(estimate, input.lines);
  return recomputeEstimateTotals(estimate);
}

// ───────────────────────── Status transitions ──────────────────────────

/**
 * Move a draft to `sent`. Mints the gapless number, sets the slug to
 * `est-NNNN`, stamps `sentAt`, and recomputes totals so the cent columns
 * reflect the latest line edits.
 */
export async function issueEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status !== "draft") {
    throw new Error("Only drafts can be issued");
  }
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: estimate.customerId,
    companyId: estimate.companyId,
  });
  if (!customer) {
    throw new Error("Customer for this estimate no longer exists");
  }
  const seq = await mintNextEstimateSeq(estimate.companyId, estimate.customerId);
  estimate.numberSeq = seq;
  // Display number carries the customer slug as a prefix, e.g.
  // ACME-CORP-EST-0001, so two customers' first estimates don't both
  // read EST-0001 in the list. The URL slug is just the lowercased
  // number — identical to the old `<customer-slug>-est-NNNN` shape, so
  // existing URLs stay valid and remain unique per (companyId, slug).
  estimate.number = formatEstimateNumber(seq, customer.slug);
  estimate.slug = estimate.number.toLowerCase();
  estimate.status = "sent";
  estimate.sentAt = new Date();
  await AppDataSource.getRepository(Estimate).save(estimate);
  return recomputeEstimateTotals(estimate);
}

export async function acceptEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status === "draft") {
    throw new Error("Issue the estimate before marking it accepted");
  }
  if (estimate.status === "void" || estimate.status === "declined") {
    throw new Error("This estimate cannot be accepted in its current state");
  }
  estimate.status = "accepted";
  estimate.acceptedAt = new Date();
  estimate.declinedAt = null;
  return AppDataSource.getRepository(Estimate).save(estimate);
}

export async function declineEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status === "draft") {
    throw new Error("Issue the estimate before marking it declined");
  }
  if (estimate.status === "void") {
    throw new Error("Voided estimates cannot be declined");
  }
  estimate.status = "declined";
  estimate.declinedAt = new Date();
  estimate.acceptedAt = null;
  return AppDataSource.getRepository(Estimate).save(estimate);
}

export async function voidEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status === "void") return estimate;
  if (estimate.status === "draft") {
    throw new Error("Drafts cannot be voided — delete them instead");
  }
  estimate.status = "void";
  estimate.voidedAt = new Date();
  return AppDataSource.getRepository(Estimate).save(estimate);
}

// ──────────────────────────── Editing ────────────────────────────────

/** An edit the estimate's state forbids, with the status the route answers. */
export class EstimateEditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = "EstimateEditError";
  }
}

export type EstimateEditInput = DiscountInput & {
  subsidiaryId?: string | null;
  customerId?: string;
  issueDate?: Date;
  validUntil?: Date;
  currency?: string;
  notes?: string;
  footer?: string;
  lines?: LineDraft[];
};

export type EstimateEditResult = {
  estimate: Estimate;
  /** The fields whose value actually changed — what the History row names. */
  changed: string[];
  /** The estimate was already issued, so the customer holds an older copy. */
  afterIssue: boolean;
  previousTotalCents: number;
  /** Where it stood before: an accepted estimate the edit sent back to `sent`. */
  previousStatus: EstimateStatus;
};

/**
 * Edit an estimate. A draft takes any change. A sent or accepted estimate —
 * one the customer already holds — stays editable so a quote can be revised
 * and resent under the same number:
 *
 *   - Its customer and issuer are fixed at issue: the number belongs to that
 *     customer, from that legal entity. Duplicate it to quote someone else.
 *   - Any change to an accepted estimate returns it to `sent`, since the
 *     customer accepted the earlier version; mark it accepted again once they
 *     accept this one.
 *   - Declined, void and converted estimates are closed. Duplicate one to
 *     quote again, or edit the invoice it became.
 *
 * Unchanged lines are left exactly as saved and changed ones keep the tax
 * rates the estimate was issued with. Estimates never touch the ledger, and
 * nothing here emails the customer.
 */
export async function updateEstimate(
  estimate: Estimate,
  input: EstimateEditInput,
): Promise<EstimateEditResult> {
  if (estimate.status === "void") {
    throw new EstimateEditError("Voided estimates cannot be edited", 409);
  }
  if (estimate.invoiceId) {
    throw new EstimateEditError(
      "This estimate was converted to an invoice, so it can't be edited. Edit the invoice instead, or duplicate the estimate to quote again.",
      409,
    );
  }
  if (estimate.status === "declined") {
    throw new EstimateEditError(
      "A declined estimate can't be edited. Duplicate it to send the customer a revised quote.",
      409,
    );
  }
  const companyId = estimate.companyId;
  const issued = estimate.status !== "draft";
  const previousStatus = estimate.status;
  const existingLines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
    order: { sortOrder: "ASC" },
  });
  const previousDiscount = discountOf(estimate);
  const previousTotals = documentTotals(existingLines, previousDiscount);
  let nextDiscount: DocumentDiscount;
  try {
    nextDiscount = requestedDiscount(input, previousDiscount);
  } catch (err) {
    throw new EstimateEditError((err as Error).message, 400);
  }
  const discountChanged = !sameDiscount(nextDiscount, previousDiscount);

  const customerChanged =
    input.customerId !== undefined && input.customerId !== estimate.customerId;
  const subsidiaryChanged =
    input.subsidiaryId !== undefined && input.subsidiaryId !== estimate.subsidiaryId;
  const issueDateChanged =
    input.issueDate !== undefined && !sameUtcDay(input.issueDate, estimate.issueDate);
  const validUntilChanged =
    input.validUntil !== undefined && !sameUtcDay(input.validUntil, estimate.validUntil);
  const linesChanged = input.lines !== undefined && !linesUnchanged(existingLines, input.lines);

  if (issued) {
    const label = estimate.number || "This estimate";
    if (customerChanged) {
      throw new EstimateEditError(
        `The customer can't change after an estimate is issued — ${label} is numbered for them. Duplicate it to quote someone else.`,
        409,
      );
    }
    if (subsidiaryChanged) {
      throw new EstimateEditError(
        "The issuer can't change after an estimate is issued. Duplicate it to quote from another entity.",
        409,
      );
    }
  }

  let customer: Customer | null = null;
  if (customerChanged) {
    customer = await AppDataSource.getRepository(Customer).findOneBy({
      id: input.customerId,
      companyId,
    });
    if (!customer) throw new EstimateEditError("Invalid customer", 400);
  }
  if (subsidiaryChanged) {
    Object.assign(estimate, await resolveDocumentIssuer(companyId, input.subsidiaryId ?? null));
  }

  const changed: string[] = [];
  if (customerChanged) changed.push("customer");
  if (subsidiaryChanged) changed.push("issuer");
  if (issueDateChanged) changed.push("issueDate");
  if (validUntilChanged) changed.push("validUntil");
  if (input.currency !== undefined && input.currency !== estimate.currency) {
    changed.push("currency");
  }
  if (input.notes !== undefined && input.notes !== estimate.notes) changed.push("notes");
  if (input.footer !== undefined && input.footer !== estimate.footer) changed.push("footer");
  if (linesChanged) changed.push("lines");
  if (discountChanged) changed.push("discount");

  if (customer) estimate.customerId = customer.id;
  Object.assign(estimate, nextDiscount);
  if (input.notes !== undefined) estimate.notes = input.notes;
  if (input.footer !== undefined) estimate.footer = input.footer;
  if (input.currency !== undefined) estimate.currency = input.currency;
  // On an issued estimate the same day keeps the stored moment.
  if (input.issueDate !== undefined && (!issued || issueDateChanged)) {
    estimate.issueDate = input.issueDate;
  }
  if (input.validUntil !== undefined && (!issued || validUntilChanged)) {
    estimate.validUntil = input.validUntil;
  }
  if (estimate.status === "accepted" && changed.length > 0) {
    estimate.status = "sent";
    estimate.acceptedAt = null;
  }
  await AppDataSource.getRepository(Estimate).save(estimate);
  // A draft re-prices whatever lines it is sent, picking up current tax rates.
  // An issued estimate only re-prices lines that actually changed.
  if (input.lines !== undefined && (!issued || linesChanged)) {
    await replaceEstimateLines(
      estimate,
      input.lines,
      issued ? keptTaxSnapshots(existingLines) : undefined,
    );
  }
  return {
    estimate: await recomputeEstimateTotals(estimate),
    changed,
    afterIssue: issued,
    previousTotalCents: previousTotals.totalCents,
    previousStatus,
  };
}

/**
 * One-shot conversion of an `accepted` (or `sent`) estimate into a
 * fully issued `Invoice`. The new invoice copies the estimate's lines
 * (already tax-snapshotted) and discount, inherits the same currency, and goes
 * straight to `sent` so it lands on the books with a real `INV-####`
 * number and the auto-posted journal entry. The estimate keeps its
 * status but stamps `invoiceId` + `convertedAt` so the UI can show a
 * "Converted to INV-####" badge.
 */
export async function convertEstimateToInvoice(
  estimate: Estimate,
  actorUserId: string | null,
  opts: { dueInDays?: number } = {},
): Promise<{ estimate: Estimate; invoice: Invoice }> {
  if (estimate.invoiceId) {
    throw new Error("This estimate has already been converted to an invoice");
  }
  if (estimate.status === "draft") {
    throw new Error("Issue the estimate before converting it");
  }
  if (estimate.status === "declined" || estimate.status === "void") {
    throw new Error("This estimate cannot be converted in its current state");
  }
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
    order: { sortOrder: "ASC" },
  });
  if (lines.length === 0) {
    throw new Error("Cannot convert an empty estimate — add line items first");
  }

  const dueInDays = opts.dueInDays ?? 14;
  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + dueInDays * 24 * 60 * 60 * 1000);

  // Build the invoice in draft, copy the lines, then issue it so we
  // exercise the existing invoice issue path (number mint + ledger
  // post). Numbering for invoices is independent of estimates.
  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const inv = invoiceRepo.create({
    companyId: estimate.companyId,
    customerId: estimate.customerId,
    subsidiaryId: estimate.subsidiaryId,
    issuerSnapshot: estimate.issuerSnapshot,
    slug: `draft-${Math.random().toString(36).slice(2, 8)}`,
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate,
    currency: estimate.currency,
    ...discountOf(estimate),
    notes: estimate.notes,
    footer: estimate.footer,
    createdById: actorUserId,
  });
  await invoiceRepo.save(inv);

  const invoiceLineRepo = AppDataSource.getRepository(InvoiceLineItem);
  await invoiceLineRepo.save(
    lines.map((l) =>
      invoiceLineRepo.create({
        invoiceId: inv.id,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        taxRateId: l.taxRateId,
        taxName: l.taxName,
        taxPercent: l.taxPercent,
        taxInclusive: l.taxInclusive,
        lineSubtotalCents: l.lineSubtotalCents,
        lineTaxCents: l.lineTaxCents,
        lineTotalCents: l.lineTotalCents,
        sortOrder: l.sortOrder,
      }),
    ),
  );

  const issued = await issueInvoice(inv, actorUserId);

  estimate.invoiceId = issued.id;
  estimate.convertedAt = new Date();
  // If the estimate hadn't been marked accepted yet, mark it now —
  // converting is implicit acceptance.
  if (estimate.status === "sent") {
    estimate.status = "accepted";
    estimate.acceptedAt = estimate.acceptedAt ?? new Date();
  }
  const savedEstimate = await AppDataSource.getRepository(Estimate).save(estimate);
  return { estimate: savedEstimate, invoice: issued };
}

// ─────────────────────────── Duplicate ───────────────────────────────

/**
 * Create a fresh `draft` estimate that copies the customer, currency,
 * discount, notes, footer, and (tax-snapshotted) line items from `source`. Used
 * by the "Duplicate" action on any estimate regardless of status — you
 * can fork a void or declined estimate back into a new draft without
 * touching the original.
 *
 * The new estimate gets a brand-new `edraft-…` slug, `numberSeq = 0`,
 * `number = ""`, and `issueDate` / `validUntil` reset to "today + 30
 * days" so the dates are sensible defaults instead of stale copies.
 * Status timestamps (`sentAt`, `acceptedAt`, etc.) and `invoiceId` are
 * intentionally not carried over.
 */
export async function duplicateEstimate(
  source: Estimate,
  actorUserId: string | null,
): Promise<Estimate> {
  const repo = AppDataSource.getRepository(Estimate);
  const slug = await uniqueDraftEstimateSlug(source.companyId);
  const issueDate = new Date();
  const validUntil = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const draft = repo.create({
    companyId: source.companyId,
    customerId: source.customerId,
    subsidiaryId: source.subsidiaryId,
    issuerSnapshot: source.issuerSnapshot,
    slug,
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    validUntil,
    currency: source.currency,
    ...discountOf(source),
    notes: source.notes,
    footer: source.footer,
    createdById: actorUserId,
  });
  await repo.save(draft);

  const sourceLines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: source.id },
    order: { sortOrder: "ASC" },
  });
  if (sourceLines.length > 0) {
    const lineRepo = AppDataSource.getRepository(EstimateLineItem);
    await lineRepo.save(
      sourceLines.map((l) =>
        lineRepo.create({
          estimateId: draft.id,
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          taxRateId: l.taxRateId,
          taxName: l.taxName,
          taxPercent: l.taxPercent,
          taxInclusive: l.taxInclusive,
          lineSubtotalCents: l.lineSubtotalCents,
          lineTaxCents: l.lineTaxCents,
          lineTotalCents: l.lineTotalCents,
          sortOrder: l.sortOrder,
        }),
      ),
    );
  }
  return recomputeEstimateTotals(draft);
}

// ──────────────────────────── Archive ─────────────────────────────────

export type EstimateArchiveAction = "archive" | "restore";

export type EstimateArchiveOutcome = {
  /** Estimates whose archived state changed, in request order. */
  changed: Estimate[];
  /** Ids left as they were, each with the reason. */
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Archive or restore a set of estimates in one call — the list page's bulk
 * action, and the single-row and detail-page actions too.
 *
 * Archiving files an estimate out of the default lists and nothing else:
 * status, number, PDF, and any converted invoice stay exactly as they were,
 * so any status can be archived and restoring puts it back unchanged. An id
 * that is not this company's estimate, or is already in the requested state,
 * is skipped with a reason rather than failing the rest of the batch.
 */
export async function setEstimatesArchived(
  companyId: string,
  ids: string[],
  action: EstimateArchiveAction,
): Promise<EstimateArchiveOutcome> {
  const requested = [...new Set(ids)];
  if (requested.length === 0) return { changed: [], skipped: [] };
  const repo = AppDataSource.getRepository(Estimate);
  const found = await repo.findBy({ companyId, id: In(requested) });
  const byId = new Map(found.map((estimate) => [estimate.id, estimate]));
  const archivedAt = action === "archive" ? new Date() : null;
  const changed: Estimate[] = [];
  const skipped: EstimateArchiveOutcome["skipped"] = [];
  for (const id of requested) {
    const estimate = byId.get(id);
    if (!estimate) {
      skipped.push({ id, reason: "Estimate not found" });
    } else if (action === "archive" && estimate.archivedAt) {
      skipped.push({ id, reason: "Already archived" });
    } else if (action === "restore" && !estimate.archivedAt) {
      skipped.push({ id, reason: "Not archived" });
    } else {
      estimate.archivedAt = archivedAt;
      changed.push(estimate);
    }
  }
  // `save` rather than a bulk UPDATE: the live-sync subscriber needs each
  // row's companyId to tell open pages to refetch.
  if (changed.length > 0) await repo.save(changed);
  return { changed, skipped };
}

async function uniqueDraftEstimateSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Estimate);
  for (let i = 0; i < 16; i += 1) {
    const slug = `edraft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `edraft-${Date.now().toString(36)}`;
}

// ─────────────────────────── Hydration ────────────────────────────────

export type EstimateCustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
  billingAddress: string;
};

export type EstimateInvoiceStub = {
  id: string;
  slug: string;
  number: string;
  status: string;
};

export type HydratedEstimate = Estimate & {
  customer: EstimateCustomerStub | null;
  lines: EstimateLineItem[];
  invoice: EstimateInvoiceStub | null;
};

/**
 * Bulk-hydrate a list of estimates with their customer stub, line items,
 * and the converted-to invoice (if any).
 */
export async function hydrateEstimates(
  companyId: string,
  estimates: Estimate[],
): Promise<HydratedEstimate[]> {
  if (estimates.length === 0) return [];
  const ids = estimates.map((e) => e.id);
  const customerIds = [...new Set(estimates.map((e) => e.customerId))];
  const invoiceIds = [
    ...new Set(
      estimates.map((e) => e.invoiceId).filter((x): x is string => !!x),
    ),
  ];
  const [customers, lines, invoices] = await Promise.all([
    AppDataSource.getRepository(Customer).find({
      where: { id: In(customerIds), companyId },
      select: ["id", "name", "slug", "email", "billingAddress"],
    }),
    AppDataSource.getRepository(EstimateLineItem).find({
      where: { estimateId: In(ids) },
      order: { sortOrder: "ASC" },
    }),
    invoiceIds.length
      ? AppDataSource.getRepository(Invoice).find({
          where: { id: In(invoiceIds), companyId },
          select: ["id", "slug", "number", "status"],
        })
      : Promise.resolve([] as Invoice[]),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const linesByEstimate = new Map<string, EstimateLineItem[]>();
  for (const l of lines) {
    const arr = linesByEstimate.get(l.estimateId) ?? [];
    arr.push(l);
    linesByEstimate.set(l.estimateId, arr);
  }
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  return estimates.map((est) => ({
    ...est,
    customer: customerById.get(est.customerId) ?? null,
    lines: linesByEstimate.get(est.id) ?? [],
    invoice: est.invoiceId
      ? invoiceById.get(est.invoiceId) ?? null
      : null,
  }));
}

// ─────────────────────────── Display helpers ──────────────────────────

/**
 * Compute the *displayed* status for a UI badge — adds the synthetic
 * "expired" bucket for sent estimates past `validUntil`, and "invoiced"
 * for estimates that have been converted. Stored status is untouched
 * so changing the system clock doesn't corrupt anything.
 */
export type DisplayEstimateStatus =
  | EstimateStatus
  | "expired"
  | "invoiced";

export function displayEstimateStatus(
  estimate: Pick<Estimate, "status" | "validUntil" | "invoiceId">,
  now: Date = new Date(),
): DisplayEstimateStatus {
  if (estimate.invoiceId) return "invoiced";
  if (
    (estimate.status === "sent" || estimate.status === "accepted") &&
    new Date(estimate.validUntil).getTime() < now.getTime()
  ) {
    return "expired";
  }
  return estimate.status;
}

// ─────────────────────────── Email send ────────────────────────────────

export type EstimateSendResult = {
  status: "sent" | "skipped" | "failed";
  logId: string;
  errorMessage: string;
};

/**
 * Resolve the customer an estimate email would be addressed to, throwing the
 * same errors {@link sendEstimateEmail} would.
 *
 * Split out so `/estimates/:slug/send` can refuse *before* auto-issuing a
 * draft. Issuing mints the gapless number and re-slugs the row from
 * `edraft-…` to `est-nnnn`, so a failure discovered afterwards left the
 * caller holding a URL that no longer resolved — the open detail page then
 * reported a perfectly live estimate as deleted.
 */
export async function resolveEstimateRecipient(
  companyId: string,
  estimate: Estimate,
): Promise<Customer> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: estimate.customerId,
    companyId,
  });
  if (!customer) throw new Error("Customer not found");
  if (!customer.email) {
    throw new Error("Customer has no email address — add one before sending");
  }
  return customer;
}

/**
 * Email the rendered HTML estimate to the customer's `email`. Uses the
 * company's default `EmailProvider` if one exists, falling back to the
 * global SMTP block (or console). Returns the email log id so the UI
 * can deep-link to the delivery record.
 */
export async function sendEstimateEmail(
  companyId: string,
  estimate: Estimate,
  triggeredByUserId: string | null,
): Promise<EstimateSendResult> {
  const customer = await resolveEstimateRecipient(companyId, estimate);
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
    order: { sortOrder: "ASC" },
  });
  const html = await renderEstimateHtmlForCompany(
    companyId,
    estimate,
    customer,
    lines,
  );
  // Attach a PDF copy so the customer gets a portable, printable document
  // rather than only the inline HTML body. Falls back to no attachment if
  // Chromium isn't available — the HTML body still carries the full estimate.
  const attachments = await renderPdfAttachment(
    html,
    `${estimate.number || "estimate"}.pdf`,
    "estimate",
  );
  const text =
    `Estimate ${estimate.number || "(draft)"} — total ` +
    `${formatMoney(estimate.totalCents, estimate.currency)} valid until ` +
    `${estimate.validUntil.toISOString().slice(0, 10)}.\n\n` +
    (attachments
      ? `The estimate is attached as a PDF.`
      : `Open the estimate HTML in your browser to print or save as PDF.`);
  const subject = `Estimate ${estimate.number || "(draft)"} — ${formatMoney(
    estimate.totalCents,
    estimate.currency,
  )}`;
  const result = await sendEmail({
    to: customer.email,
    subject,
    text,
    html,
    attachments,
    companyId,
    purpose: "other",
    triggeredByUserId,
  });
  return {
    status: result.status,
    logId: result.logId,
    errorMessage: result.errorMessage,
  };
}

// ──────────────────────── Lookup helpers ──────────────────────────────

export async function loadEstimateBySlug(
  companyId: string,
  slug: string,
): Promise<Estimate | null> {
  return AppDataSource.getRepository(Estimate).findOneBy({ companyId, slug });
}
