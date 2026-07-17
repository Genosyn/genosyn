import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import multer from "multer";
import cron from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { Account, AccountType } from "../db/entities/Account.js";
import { BankFeed, BankFeedKind } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { RecurringInvoice } from "../db/entities/RecurringInvoice.js";
import { RecurringInvoiceLineItem } from "../db/entities/RecurringInvoiceLineItem.js";
import { Estimate } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Product } from "../db/entities/Product.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import {
  duplicateInvoice,
  getInvoiceEmailDetails,
  hydrateInvoices,
  issueInvoice,
  listInvoiceResendActivities,
  loadCustomerBySlug,
  loadInvoiceBySlug,
  loadProductBySlug,
  postInvoicePayment,
  recomputeInvoiceTotals,
  replaceInvoiceLines,
  reverseInvoicePayment,
  sendInvoiceEmail,
  voidInvoice,
} from "../services/finance.js";
import { recordAudit } from "../services/audit.js";
import {
  applyRecurringInvoiceStatus,
  duplicateRecurringInvoice,
  generateInvoiceFromRecurring,
  hydrateRecurringInvoices,
  loadRecurringInvoiceBySlug,
  registerRecurringInvoice,
  replaceRecurringInvoiceLines,
} from "../services/recurringInvoices.js";
import { renderInvoiceHtmlForCompany } from "../services/invoiceHtml.js";
import { renderEstimateHtmlForCompany } from "../services/estimateHtml.js";
import { renderCustomerStatementHtmlForCompany } from "../services/customerStatementHtml.js";
import { buildCustomerStatement } from "../services/customerStatement.js";
import { htmlToPdf } from "../services/htmlToPdf.js";
import {
  acceptEstimate,
  convertEstimateToInvoice,
  declineEstimate,
  duplicateEstimate,
  hydrateEstimates,
  issueEstimate,
  loadEstimateBySlug,
  recomputeEstimateTotals,
  replaceEstimateLines,
  sendEstimateEmail,
  voidEstimate,
} from "../services/estimates.js";
import {
  postLedgerEntry,
  seedChartOfAccounts,
  trialBalance,
} from "../services/ledger.js";
import {
  accountActivity,
  balanceSheet,
  cashFlow,
  incomeStatement,
} from "../services/reports.js";
import {
  assertBrexCashAccountConnection,
  autoMatchFeed,
  findMatchCandidates,
  importBankCsv,
  listBrexCashAccountsForConnection,
  manualMatch,
  syncBankFeed,
  unmatch,
} from "../services/reconcile.js";
import {
  getFinanceSettings,
  seedCurrencies,
  setFinanceTemplates,
  setHomeCurrency,
  setRate,
} from "../services/fx.js";
import { Currency } from "../db/entities/Currency.js";
import { ExchangeRate } from "../db/entities/ExchangeRate.js";
import { AccountingPeriod } from "../db/entities/AccountingPeriod.js";
import { closePeriod, reopenPeriod } from "../services/periods.js";
import {
  exportCustomersCsv,
  exportInvoicesCsv,
  exportJournalCsv,
  exportTrialBalanceCsv,
} from "../services/exports.js";
import { Vendor } from "../db/entities/Vendor.js";
import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { BillPayment, BillPaymentMethod } from "../db/entities/BillPayment.js";
import {
  billDisplayStatus,
  hydrateBills,
  issueBill,
  loadBillBySlug,
  loadVendorBySlug,
  postBillPayment,
  recomputeBillTotals,
  replaceBillLines,
  reverseBillPayment,
  voidBill,
} from "../services/bills.js";

/**
 * Phase A of the Finance milestone (M19) — see ROADMAP.md.
 *
 * One router for all four resource families (customers, products, tax
 * rates, invoices) so the mount point in `index.ts` stays compact and
 * cross-resource validation (e.g. "this product references a missing
 * tax rate") can stay local.
 */
export const financeRouter = Router({ mergeParams: true });
financeRouter.use(requireAuth);
financeRouter.use(requireCompanyMember);

// Reused throughout — ISO 4217 codes are 3 ASCII letters. We don't enforce
// the full ISO list because Phase E (multi-currency) will introduce a
// `Currency` table that does the validation properly.
const currencySchema = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((s) => s.toUpperCase());

// ──────────────────────────── Customers ────────────────────────────────

async function uniqueCustomerSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Customer);
  let slug = base || "customer";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

// ─────────────────────── Customer contacts ────────────────────────────

type CustomerWithContacts = Customer & { contacts: CustomerContact[] };

/**
 * Attach the `contacts` array to one or many customer rows in a single
 * query. Returns hydrated copies — `Customer` itself is untouched so
 * archived-filter math doesn't see a derived field.
 */
async function hydrateCustomers(
  companyId: string,
  customers: Customer[],
): Promise<CustomerWithContacts[]> {
  if (customers.length === 0) return [];
  const contacts = await AppDataSource.getRepository(CustomerContact).find({
    where: { companyId, customerId: In(customers.map((c) => c.id)) },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  const byCustomer = new Map<string, CustomerContact[]>();
  for (const ct of contacts) {
    const arr = byCustomer.get(ct.customerId) ?? [];
    arr.push(ct);
    byCustomer.set(ct.customerId, arr);
  }
  return customers.map((c) => ({
    ...c,
    contacts: byCustomer.get(c.id) ?? [],
  }));
}

const contactWriteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200).or(z.literal("")).optional(),
  phone: z.string().max(60).optional(),
  role: z.string().max(120).optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * Ensure at most one contact per customer carries the `isPrimary` flag.
 * If the caller toggled a contact on, clear the flag on any other rows
 * for the same customer in the same operation so the database stays
 * single-source-of-truth instead of relying on UI to enforce it.
 */
async function clearOtherPrimaries(customerId: string, exceptId: string | null): Promise<void> {
  const repo = AppDataSource.getRepository(CustomerContact);
  const others = await repo.find({
    where: { customerId, isPrimary: true },
  });
  for (const ct of others) {
    if (ct.id === exceptId) continue;
    ct.isPrimary = false;
    await repo.save(ct);
  }
}

financeRouter.get("/customers", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const includeArchived = String(req.query.archived ?? "") === "true";
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { companyId: cid },
    order: { createdAt: "DESC" },
  });
  const filtered = includeArchived ? customers : customers.filter((c) => !c.archivedAt);
  const hydrated = await hydrateCustomers(cid, filtered);
  res.json(hydrated);
});

const customerWriteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200).or(z.literal("")).optional(),
  phone: z.string().max(60).optional(),
  billingAddress: z.string().max(2000).optional(),
  shippingAddress: z.string().max(2000).optional(),
  taxNumber: z.string().max(60).optional(),
  currency: currencySchema.optional(),
  /** Annual Contract Value in minor units of `currency`. Capped at
   *  2_000_000_000 ($20M) to stay within a 32-bit int on Postgres, matching
   *  the line-item money columns. */
  annualContractValueCents: z.number().int().min(0).max(2_000_000_000).optional(),
  notes: z.string().max(2000).optional(),
  /** Optional inline contacts so the create flow can land a customer
   *  plus several people in one round-trip. */
  contacts: z.array(contactWriteSchema).max(50).optional(),
});

financeRouter.post("/customers", validateBody(customerWriteSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof customerWriteSchema>;
    const repo = AppDataSource.getRepository(Customer);
    const slug = await uniqueCustomerSlug(cid, toSlug(body.name));
    const c = repo.create({
      companyId: cid,
      name: body.name,
      slug,
      email: body.email ?? "",
      phone: body.phone ?? "",
      billingAddress: body.billingAddress ?? "",
      shippingAddress: body.shippingAddress ?? "",
      taxNumber: body.taxNumber ?? "",
      currency: body.currency ?? "USD",
      annualContractValueCents: body.annualContractValueCents ?? 0,
      notes: body.notes ?? "",
      createdById: req.userId ?? null,
    });
    await repo.save(c);

    if (body.contacts && body.contacts.length > 0) {
      const contactRepo = AppDataSource.getRepository(CustomerContact);
      let primaryAlreadyAssigned = false;
      for (let i = 0; i < body.contacts.length; i += 1) {
        const draft = body.contacts[i];
        const isPrimary = !!draft.isPrimary && !primaryAlreadyAssigned;
        if (isPrimary) primaryAlreadyAssigned = true;
        await contactRepo.save(
          contactRepo.create({
            companyId: cid,
            customerId: c.id,
            name: draft.name,
            email: draft.email ?? "",
            phone: draft.phone ?? "",
            role: draft.role ?? "",
            isPrimary,
            sortOrder: draft.sortOrder ?? i,
          }),
        );
      }
    }

    const [hydrated] = await hydrateCustomers(cid, [c]);
    res.json(hydrated);
});

financeRouter.get("/customers/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).json({ error: "Customer not found" });
  const [hydrated] = await hydrateCustomers(cid, [c]);
  res.json(hydrated);
});

// ─────────────────────── Customer statement ───────────────────────────
//
// A statement of account is derived on the fly from the customer's issued
// invoices + payments (no entity) — see services/customerStatement.ts. The
// JSON shape feeds the in-app view; /html and /pdf mirror the invoice
// print/download path so a customer can be handed a portable document.

const statementQuerySchema = z.object({
  // `yyyy-mm-dd` (or any Date-parseable string). `from` omitted = all time.
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
});

function parseStatementQuery(query: unknown): {
  from: Date | null;
  to: Date | undefined;
  currency: string | undefined;
} {
  const parsed = statementQuerySchema.parse(query);
  const toDate = (s: string | undefined): Date | undefined => {
    if (!s) return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
    return d;
  };
  return {
    from: toDate(parsed.from) ?? null,
    to: toDate(parsed.to),
    currency: parsed.currency ? parsed.currency.toUpperCase() : undefined,
  };
}

financeRouter.get("/customers/:slug/statement", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).json({ error: "Customer not found" });
  let opts;
  try {
    opts = parseStatementQuery(req.query);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const statement = await buildCustomerStatement(cid, c, opts);
  res.json({ customer: { id: c.id, name: c.name, slug: c.slug }, statement });
});

financeRouter.get("/customers/:slug/statement/html", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).type("text/plain").send("Not found");
  let opts;
  try {
    opts = parseStatementQuery(req.query);
  } catch (err) {
    return res
      .status(400)
      .type("text/plain")
      .send((err as Error).message);
  }
  const statement = await buildCustomerStatement(cid, c, opts);
  const html = await renderCustomerStatementHtmlForCompany(cid, c, statement);
  res.type("text/html").send(html);
});

financeRouter.get("/customers/:slug/statement/pdf", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).type("text/plain").send("Not found");
  let opts;
  try {
    opts = parseStatementQuery(req.query);
  } catch (err) {
    return res
      .status(400)
      .type("text/plain")
      .send((err as Error).message);
  }
  const statement = await buildCustomerStatement(cid, c, opts);
  const html = await renderCustomerStatementHtmlForCompany(cid, c, statement);
  try {
    const pdf = await htmlToPdf(html);
    const filename = `statement-${c.slug}-${statement.toDate}.pdf`;
    res
      .type("application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      .send(pdf);
  } catch (err) {
    res
      .status(503)
      .type("text/plain")
      .send(`PDF rendering unavailable: ${(err as Error).message}`);
  }
});

financeRouter.patch(
  "/customers/:slug",
  validateBody(
    customerWriteSchema
      .extend({
      archived: z.boolean().optional(),
      })
      .partial(),
  ),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const c = await loadCustomerBySlug(cid, req.params.slug);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    const body = req.body as Partial<z.infer<typeof customerWriteSchema>> & {
      archived?: boolean;
    };
    if (body.name !== undefined) c.name = body.name;
    if (body.email !== undefined) c.email = body.email;
    if (body.phone !== undefined) c.phone = body.phone;
    if (body.billingAddress !== undefined) c.billingAddress = body.billingAddress;
    if (body.shippingAddress !== undefined) c.shippingAddress = body.shippingAddress;
    if (body.taxNumber !== undefined) c.taxNumber = body.taxNumber;
    if (body.currency !== undefined) c.currency = body.currency;
    if (body.annualContractValueCents !== undefined) {
      c.annualContractValueCents = body.annualContractValueCents;
    }
    if (body.notes !== undefined) c.notes = body.notes;
    if (body.archived !== undefined) {
      c.archivedAt = body.archived ? new Date() : null;
    }
    await AppDataSource.getRepository(Customer).save(c);
    const [hydrated] = await hydrateCustomers(cid, [c]);
    res.json(hydrated);
  },
);

financeRouter.delete("/customers/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).json({ error: "Customer not found" });
  // Hard-delete is only allowed if the customer has no invoices. Anything
  // else would orphan billing records — archive instead.
  const invoiceCount = await AppDataSource.getRepository(Invoice).count({
    where: { companyId: cid, customerId: c.id },
  });
  if (invoiceCount > 0) {
    return res.status(409).json({
      error: "Customer has invoices. Archive them or delete the invoices first.",
    });
  }
  await AppDataSource.getRepository(CustomerContact).delete({ customerId: c.id });
  await AppDataSource.getRepository(Customer).delete({ id: c.id });
  res.json({ ok: true });
});

financeRouter.get("/customers/:slug/contacts", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).json({ error: "Customer not found" });
  const contacts = await AppDataSource.getRepository(CustomerContact).find({
    where: { customerId: c.id },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  res.json(contacts);
});

financeRouter.post(
  "/customers/:slug/contacts",
  validateBody(contactWriteSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const c = await loadCustomerBySlug(cid, req.params.slug);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    const body = req.body as z.infer<typeof contactWriteSchema>;
    const repo = AppDataSource.getRepository(CustomerContact);
    const ct = repo.create({
      companyId: cid,
      customerId: c.id,
      name: body.name,
      email: body.email ?? "",
      phone: body.phone ?? "",
      role: body.role ?? "",
      isPrimary: !!body.isPrimary,
      sortOrder: body.sortOrder ?? 0,
    });
    await repo.save(ct);
    if (ct.isPrimary) await clearOtherPrimaries(c.id, ct.id);
    res.json(ct);
  },
);

financeRouter.patch(
  "/customers/:slug/contacts/:contactId",
  validateBody(contactWriteSchema.partial()),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const c = await loadCustomerBySlug(cid, req.params.slug);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    const repo = AppDataSource.getRepository(CustomerContact);
    const ct = await repo.findOneBy({
      id: req.params.contactId,
      customerId: c.id,
    });
    if (!ct) return res.status(404).json({ error: "Contact not found" });
    const body = req.body as Partial<z.infer<typeof contactWriteSchema>>;
    if (body.name !== undefined) ct.name = body.name;
    if (body.email !== undefined) ct.email = body.email;
    if (body.phone !== undefined) ct.phone = body.phone;
    if (body.role !== undefined) ct.role = body.role;
    if (body.isPrimary !== undefined) ct.isPrimary = body.isPrimary;
    if (body.sortOrder !== undefined) ct.sortOrder = body.sortOrder;
    await repo.save(ct);
    if (ct.isPrimary) await clearOtherPrimaries(c.id, ct.id);
    res.json(ct);
  },
);

financeRouter.delete("/customers/:slug/contacts/:contactId", async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const c = await loadCustomerBySlug(cid, req.params.slug);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    const repo = AppDataSource.getRepository(CustomerContact);
    const ct = await repo.findOneBy({
      id: req.params.contactId,
      customerId: c.id,
    });
    if (!ct) return res.status(404).json({ error: "Contact not found" });
    await repo.delete({ id: ct.id });
    res.json({ ok: true });
});

// ──────────────────────────── Products ─────────────────────────────────

async function uniqueProductSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Product);
  let slug = base || "product";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

financeRouter.get("/products", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const includeArchived = String(req.query.archived ?? "") === "true";
  const products = await AppDataSource.getRepository(Product).find({
    where: { companyId: cid },
    order: { createdAt: "DESC" },
  });
  res.json(includeArchived ? products : products.filter((p) => !p.archivedAt));
});

const productWriteSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  unitPriceCents: z.number().int().min(0).max(2_000_000_000),
  currency: currencySchema.optional(),
  defaultTaxRateId: z.string().uuid().nullable().optional(),
});

financeRouter.post("/products", validateBody(productWriteSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof productWriteSchema>;
    if (body.defaultTaxRateId) {
      const tax = await AppDataSource.getRepository(TaxRate).findOneBy({
        id: body.defaultTaxRateId,
        companyId: cid,
      });
      if (!tax) return res.status(400).json({ error: "Invalid tax rate" });
    }
    const slug = await uniqueProductSlug(cid, toSlug(body.name));
    const repo = AppDataSource.getRepository(Product);
    const p = repo.create({
      companyId: cid,
      name: body.name,
      slug,
      description: body.description ?? "",
      unitPriceCents: body.unitPriceCents,
      currency: body.currency ?? "USD",
      defaultTaxRateId: body.defaultTaxRateId ?? null,
      createdById: req.userId ?? null,
    });
    await repo.save(p);
    res.json(p);
});

financeRouter.patch(
  "/products/:slug",
  validateBody(
    productWriteSchema
      .extend({
      archived: z.boolean().optional(),
      })
      .partial(),
  ),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadProductBySlug(cid, req.params.slug);
    if (!p) return res.status(404).json({ error: "Product not found" });
    const body = req.body as Partial<z.infer<typeof productWriteSchema>> & {
      archived?: boolean;
    };
    if (body.defaultTaxRateId) {
      const tax = await AppDataSource.getRepository(TaxRate).findOneBy({
        id: body.defaultTaxRateId,
        companyId: cid,
      });
      if (!tax) return res.status(400).json({ error: "Invalid tax rate" });
    }
    if (body.name !== undefined) p.name = body.name;
    if (body.description !== undefined) p.description = body.description;
    if (body.unitPriceCents !== undefined) p.unitPriceCents = body.unitPriceCents;
    if (body.currency !== undefined) p.currency = body.currency;
    if (body.defaultTaxRateId !== undefined) {
      p.defaultTaxRateId = body.defaultTaxRateId;
    }
    if (body.archived !== undefined) {
      p.archivedAt = body.archived ? new Date() : null;
    }
    await AppDataSource.getRepository(Product).save(p);
    res.json(p);
  },
);

financeRouter.delete("/products/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadProductBySlug(cid, req.params.slug);
  if (!p) return res.status(404).json({ error: "Product not found" });
  // Line items snapshot description / unitPrice / tax — deletion is safe
  // and won't break historical invoices. The product reference on those
  // lines just becomes a dangling pointer (we tolerate that).
  await AppDataSource.getRepository(Product).delete({ id: p.id });
  res.json({ ok: true });
});

// ──────────────────────────── Tax rates ────────────────────────────────

financeRouter.get("/tax-rates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const includeArchived = String(req.query.archived ?? "") === "true";
  const rates = await AppDataSource.getRepository(TaxRate).find({
    where: { companyId: cid },
    order: { createdAt: "ASC" },
  });
  res.json(includeArchived ? rates : rates.filter((r) => !r.archivedAt));
});

const taxRateWriteSchema = z.object({
  name: z.string().min(1).max(60),
  ratePercent: z.number().min(0).max(1000),
  inclusive: z.boolean().optional(),
});

financeRouter.post("/tax-rates", validateBody(taxRateWriteSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof taxRateWriteSchema>;
    const repo = AppDataSource.getRepository(TaxRate);
    const t = repo.create({
      companyId: cid,
      name: body.name,
      ratePercent: body.ratePercent,
      inclusive: body.inclusive ?? false,
    });
    await repo.save(t);
    res.json(t);
});

financeRouter.patch(
  "/tax-rates/:id",
  validateBody(taxRateWriteSchema.extend({ archived: z.boolean().optional() }).partial()),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const repo = AppDataSource.getRepository(TaxRate);
    const t = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!t) return res.status(404).json({ error: "Tax rate not found" });
    const body = req.body as Partial<z.infer<typeof taxRateWriteSchema>> & {
      archived?: boolean;
    };
    if (body.name !== undefined) t.name = body.name;
    if (body.ratePercent !== undefined) t.ratePercent = body.ratePercent;
    if (body.inclusive !== undefined) t.inclusive = body.inclusive;
    if (body.archived !== undefined) {
      t.archivedAt = body.archived ? new Date() : null;
    }
    await repo.save(t);
    res.json(t);
  },
);

financeRouter.delete("/tax-rates/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(TaxRate);
  const t = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!t) return res.status(404).json({ error: "Tax rate not found" });
  await repo.delete({ id: t.id });
  res.json({ ok: true });
});

// ───────────────────────────── Invoices ────────────────────────────────

async function draftInvoiceSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Invoice);
  for (let i = 0; i < 16; i += 1) {
    const slug = `draft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  // Fall back to a timestamp-based slug if we hit 16 collisions in a row.
  return `draft-${Date.now().toString(36)}`;
}

const lineDraftSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  description: z.string().min(1).max(500),
  quantity: z.number().min(0).max(1_000_000),
  unitPriceCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  taxRateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const invoiceCreateSchema = z.object({
  customerId: z.string().uuid(),
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(4000).optional(),
  footer: z.string().max(1000).optional(),
  lines: z.array(lineDraftSchema).max(200).optional(),
});

financeRouter.get("/invoices", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  const status = req.query.status;
  if (typeof status === "string" && status) where.status = status;
  const customerId = req.query.customerId;
  if (typeof customerId === "string" && customerId) where.customerId = customerId;
  const invoices = await AppDataSource.getRepository(Invoice).find({
    where,
    order: { createdAt: "DESC" },
  });
  const hydrated = await hydrateInvoices(cid, invoices);
  // Strip lines + payments from the list view to keep payloads small —
  // detail page calls /invoices/:slug for the full thing.
  res.json(
    hydrated.map(({ lines: _lines, payments: _payments, ...rest }) => ({
      ...rest,
      linesCount: _lines.length,
      paymentsCount: _payments.length,
    })),
  );
});

financeRouter.post("/invoices", validateBody(invoiceCreateSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof invoiceCreateSchema>;
    const customer = await AppDataSource.getRepository(Customer).findOneBy({
      id: body.customerId,
      companyId: cid,
    });
    if (!customer) return res.status(400).json({ error: "Invalid customer" });

    const repo = AppDataSource.getRepository(Invoice);
    const slug = await draftInvoiceSlug(cid);
    const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
    const dueDate = body.dueDate
      ? new Date(body.dueDate)
      : new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
    const inv = repo.create({
      companyId: cid,
      customerId: customer.id,
      slug,
      numberSeq: 0,
      number: "",
      status: "draft",
      issueDate,
      dueDate,
      currency: body.currency ?? customer.currency ?? "USD",
      notes: body.notes ?? "",
      footer: body.footer ?? "",
      createdById: req.userId ?? null,
    });
    await repo.save(inv);
    if (body.lines && body.lines.length > 0) {
      await replaceInvoiceLines(inv, body.lines);
    }
    const recomputed = await recomputeInvoiceTotals(inv);
    const [hydrated] = await hydrateInvoices(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.get("/invoices/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const [hydratedRows, emailDetails, resendActivities] = await Promise.all([
    hydrateInvoices(cid, [inv]),
    getInvoiceEmailDetails(cid, inv),
    listInvoiceResendActivities(cid, inv.id),
  ]);
  res.json({ ...hydratedRows[0], emailDetails, resendActivities });
});

const invoicePatchSchema = z.object({
  // Header fields editable on draft AND issued invoices:
  notes: z.string().max(4000).optional(),
  footer: z.string().max(1000).optional(),
  dueDate: z.string().datetime().optional(),
  // Header fields editable only while still draft:
  customerId: z.string().uuid().optional(),
  issueDate: z.string().datetime().optional(),
  currency: currencySchema.optional(),
  // Line replacement is draft-only.
  lines: z.array(lineDraftSchema).max(200).optional(),
});

financeRouter.patch("/invoices/:slug", validateBody(invoicePatchSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const inv = await loadInvoiceBySlug(cid, req.params.slug);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "void") {
      return res.status(409).json({ error: "Voided invoices cannot be edited" });
    }
    const body = req.body as z.infer<typeof invoicePatchSchema>;
    const draftOnly =
      body.customerId !== undefined ||
      body.issueDate !== undefined ||
      body.currency !== undefined ||
      body.lines !== undefined;
    if (draftOnly && inv.status !== "draft") {
      return res
        .status(409)
        .json({ error: "Lines and header (customer/date/currency) are draft-only" });
    }

    if (body.notes !== undefined) inv.notes = body.notes;
    if (body.footer !== undefined) inv.footer = body.footer;
    if (body.dueDate !== undefined) inv.dueDate = new Date(body.dueDate);
    if (body.customerId !== undefined) {
      const c = await AppDataSource.getRepository(Customer).findOneBy({
        id: body.customerId,
        companyId: cid,
      });
      if (!c) return res.status(400).json({ error: "Invalid customer" });
      inv.customerId = c.id;
    }
    if (body.issueDate !== undefined) inv.issueDate = new Date(body.issueDate);
    if (body.currency !== undefined) inv.currency = body.currency;
    await AppDataSource.getRepository(Invoice).save(inv);

    if (body.lines !== undefined) {
      await replaceInvoiceLines(inv, body.lines);
    }
    const recomputed = await recomputeInvoiceTotals(inv);
    const [hydrated] = await hydrateInvoices(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.delete("/invoices/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (inv.status !== "draft") {
    return res
      .status(409)
      .json({ error: "Only drafts can be deleted — void issued invoices instead" });
  }
  await AppDataSource.getRepository(InvoiceLineItem).delete({
    invoiceId: inv.id,
  });
  await AppDataSource.getRepository(InvoicePayment).delete({
    invoiceId: inv.id,
  });
  await AppDataSource.getRepository(Invoice).delete({ id: inv.id });
  res.json({ ok: true });
});

// Issue (mint number, lock lines, auto-post DR AR / CR Revenue + Tax)
financeRouter.post("/invoices/:slug/issue", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (inv.status !== "draft") {
    return res.status(409).json({ error: "Already issued" });
  }
  try {
    const issued = await issueInvoice(inv, req.userId ?? null);
    const [hydrated] = await hydrateInvoices(cid, [issued]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const invoiceSendSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      message: z.string().max(4000).default(""),
      attachPdf: z.boolean().default(true),
    })
    .strict(),
);

// Email send (auto-issues drafts, then sends). Issued invoices reach this
// endpoint through the resend confirmation modal.
financeRouter.post("/invoices/:slug/send", validateBody(invoiceSendSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  let inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (inv.status === "void") {
    return res.status(409).json({ error: "Voided invoices cannot be sent" });
  }
  const isResend = inv.status !== "draft";
  if (inv.status === "draft") {
    inv = await issueInvoice(inv, req.userId ?? null);
  }
  const body = req.body as z.infer<typeof invoiceSendSchema>;
  try {
    const result = await sendInvoiceEmail(cid, inv, req.userId ?? null, body);
    if (isResend) {
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "invoice.email.resend",
        targetType: "invoice",
        targetId: inv.id,
        targetLabel: inv.number || "Invoice",
        metadata: {
          status: result.status,
          toAddress: result.toAddress,
          fromAddress: result.fromAddress,
          replyTo: result.replyTo,
          pdfRequested: result.pdfRequested,
          pdfAttached: result.pdfAttached,
          hasMessage: result.hasMessage,
          errorMessage: result.errorMessage,
          emailLogId: result.logId,
        },
      });
    }
    const [hydrated] = await hydrateInvoices(cid, [inv]);
    res.json({ invoice: hydrated, send: result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/invoices/:slug/void", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  try {
    const voided = await voidInvoice(inv, req.userId ?? null);
    const [hydrated] = await hydrateInvoices(cid, [voided]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Duplicate (clone into a fresh draft — works on any status, including
// paid and void; payments and status timestamps are intentionally not
// copied).
financeRouter.post("/invoices/:slug/duplicate", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  try {
    const draft = await duplicateInvoice(inv, req.userId ?? null);
    const [hydrated] = await hydrateInvoices(cid, [draft]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Load the full set of rows the printable / PDF view needs in one go:
 * invoice header, customer, lines, payments. Returns null when any of
 * the required pieces is missing so route handlers can 404 uniformly.
 */
async function loadInvoicePrintBundle(
  companyId: string,
  slug: string,
): Promise<null | {
      invoice: Invoice;
      customer: Customer;
      lines: InvoiceLineItem[];
      payments: InvoicePayment[];
}> {
  const invoice = await loadInvoiceBySlug(companyId, slug);
  if (!invoice) return null;
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: invoice.customerId,
    companyId,
  });
  if (!customer) return null;
  const [lines, payments] = await Promise.all([
    AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: invoice.id },
      order: { sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: invoice.id },
      order: { paidAt: "ASC" },
    }),
  ]);
  return { invoice, customer, lines, payments };
}

// Printable HTML — kept for previews and the email-send path. Browsers
// can still File → Print this page if a user wants the print dialog.
financeRouter.get("/invoices/:slug/html", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const bundle = await loadInvoicePrintBundle(cid, req.params.slug);
  if (!bundle) return res.status(404).type("text/plain").send("Not found");
  const html = await renderInvoiceHtmlForCompany(
    cid,
    bundle.invoice,
    bundle.customer,
    bundle.lines,
    bundle.payments,
  );
  res.type("text/html").send(html);
});

// Server-rendered PDF for the "Download PDF" button. Falls back to a 503
// if Chromium isn't available so the UI can surface a meaningful error
// instead of a generic 500.
financeRouter.get("/invoices/:slug/pdf", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const bundle = await loadInvoicePrintBundle(cid, req.params.slug);
  if (!bundle) return res.status(404).type("text/plain").send("Not found");
  const html = await renderInvoiceHtmlForCompany(
    cid,
    bundle.invoice,
    bundle.customer,
    bundle.lines,
    bundle.payments,
  );
  try {
    const pdf = await htmlToPdf(html);
    const filename = `${bundle.invoice.number || "draft"}.pdf`;
    res
      .type("application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      .send(pdf);
  } catch (err) {
    res
      .status(503)
      .type("text/plain")
      .send(`PDF rendering unavailable: ${(err as Error).message}`);
  }
});

// ───────────────────────────── Payments ────────────────────────────────

const paymentCreateSchema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  currency: currencySchema.optional(),
  paidAt: z.string().datetime().optional(),
  method: z.enum(["cash", "bank_transfer", "stripe", "lightning", "other"]).optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

financeRouter.post(
  "/invoices/:slug/payments",
  validateBody(paymentCreateSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const inv = await loadInvoiceBySlug(cid, req.params.slug);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "draft") {
      return res.status(409).json({ error: "Issue the invoice before recording payments" });
    }
    if (inv.status === "void") {
      return res.status(409).json({ error: "Voided invoices cannot be paid" });
    }
    const body = req.body as z.infer<typeof paymentCreateSchema>;
    const repo = AppDataSource.getRepository(InvoicePayment);
    const p = await repo.save(
      repo.create({
        invoiceId: inv.id,
        amountCents: body.amountCents,
        currency: body.currency ?? inv.currency,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        method: body.method ?? "other",
        reference: body.reference ?? "",
        notes: body.notes ?? "",
        createdById: req.userId ?? null,
      }),
    );
    // Auto-post DR Bank / CR AR. Phase B (M19) — see services/ledger.ts.
    await postInvoicePayment(inv, p, req.userId ?? null);
    const recomputed = await recomputeInvoiceTotals(inv);
    const [hydrated] = await hydrateInvoices(cid, [recomputed]);
    res.json(hydrated);
  },
);

financeRouter.delete("/invoices/:slug/payments/:pid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const payRepo = AppDataSource.getRepository(InvoicePayment);
  const p = await payRepo.findOneBy({ id: req.params.pid, invoiceId: inv.id });
  if (!p) return res.status(404).json({ error: "Payment not found" });
  // Reverse the ledger entry first so the audit trail captures the
  // original posting + the reversal — then hard-delete the payment row.
  await reverseInvoicePayment(inv, p, req.userId ?? null);
  await payRepo.delete({ id: p.id });
  const recomputed = await recomputeInvoiceTotals(inv);
  const [hydrated] = await hydrateInvoices(cid, [recomputed]);
  res.json(hydrated);
});

// ───────────────────────────── Estimates ──────────────────────────────

async function draftEstimateSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Estimate);
  for (let i = 0; i < 16; i += 1) {
    const slug = `edraft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `edraft-${Date.now().toString(36)}`;
}

const estimateCreateSchema = z.object({
  customerId: z.string().uuid(),
  issueDate: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(4000).optional(),
  footer: z.string().max(1000).optional(),
  lines: z.array(lineDraftSchema).max(200).optional(),
});

financeRouter.get("/estimates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  const status = req.query.status;
  if (typeof status === "string" && status) where.status = status;
  const customerId = req.query.customerId;
  if (typeof customerId === "string" && customerId) where.customerId = customerId;
  const estimates = await AppDataSource.getRepository(Estimate).find({
    where,
    order: { createdAt: "DESC" },
  });
  const hydrated = await hydrateEstimates(cid, estimates);
  // Strip lines from the list view so payloads stay small — detail
  // page calls /estimates/:slug for the full thing.
  res.json(
    hydrated.map(({ lines: _lines, ...rest }) => ({
      ...rest,
      linesCount: _lines.length,
    })),
  );
});

financeRouter.post("/estimates", validateBody(estimateCreateSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof estimateCreateSchema>;
    const customer = await AppDataSource.getRepository(Customer).findOneBy({
      id: body.customerId,
      companyId: cid,
    });
    if (!customer) return res.status(400).json({ error: "Invalid customer" });

    const repo = AppDataSource.getRepository(Estimate);
    const slug = await draftEstimateSlug(cid);
    const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
    const validUntil = body.validUntil
      ? new Date(body.validUntil)
      : new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const est = repo.create({
      companyId: cid,
      customerId: customer.id,
      slug,
      numberSeq: 0,
      number: "",
      status: "draft",
      issueDate,
      validUntil,
      currency: body.currency ?? customer.currency ?? "USD",
      notes: body.notes ?? "",
      footer: body.footer ?? "",
      createdById: req.userId ?? null,
    });
    await repo.save(est);
    if (body.lines && body.lines.length > 0) {
      await replaceEstimateLines(est, body.lines);
    }
    const recomputed = await recomputeEstimateTotals(est);
    const [hydrated] = await hydrateEstimates(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.get("/estimates/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  const [hydrated] = await hydrateEstimates(cid, [est]);
  res.json(hydrated);
});

const estimatePatchSchema = z.object({
  notes: z.string().max(4000).optional(),
  footer: z.string().max(1000).optional(),
  validUntil: z.string().datetime().optional(),
  customerId: z.string().uuid().optional(),
  issueDate: z.string().datetime().optional(),
  currency: currencySchema.optional(),
  lines: z.array(lineDraftSchema).max(200).optional(),
});

financeRouter.patch("/estimates/:slug", validateBody(estimatePatchSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const est = await loadEstimateBySlug(cid, req.params.slug);
    if (!est) return res.status(404).json({ error: "Estimate not found" });
    if (est.status === "void") {
      return res.status(409).json({ error: "Voided estimates cannot be edited" });
    }
    const body = req.body as z.infer<typeof estimatePatchSchema>;
    const draftOnly =
      body.customerId !== undefined ||
      body.issueDate !== undefined ||
      body.currency !== undefined ||
      body.lines !== undefined;
    if (draftOnly && est.status !== "draft") {
      return res
        .status(409)
        .json({ error: "Lines and header (customer/date/currency) are draft-only" });
    }

    if (body.notes !== undefined) est.notes = body.notes;
    if (body.footer !== undefined) est.footer = body.footer;
    if (body.validUntil !== undefined) est.validUntil = new Date(body.validUntil);
    if (body.customerId !== undefined) {
      const c = await AppDataSource.getRepository(Customer).findOneBy({
        id: body.customerId,
        companyId: cid,
      });
      if (!c) return res.status(400).json({ error: "Invalid customer" });
      est.customerId = c.id;
    }
    if (body.issueDate !== undefined) est.issueDate = new Date(body.issueDate);
    if (body.currency !== undefined) est.currency = body.currency;
    await AppDataSource.getRepository(Estimate).save(est);

    if (body.lines !== undefined) {
      await replaceEstimateLines(est, body.lines);
    }
    const recomputed = await recomputeEstimateTotals(est);
    const [hydrated] = await hydrateEstimates(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.delete("/estimates/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  if (est.status !== "draft") {
    return res
      .status(409)
      .json({ error: "Only drafts can be deleted — void issued estimates instead" });
  }
  await AppDataSource.getRepository(EstimateLineItem).delete({
    estimateId: est.id,
  });
  await AppDataSource.getRepository(Estimate).delete({ id: est.id });
  res.json({ ok: true });
});

financeRouter.post("/estimates/:slug/issue", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  if (est.status !== "draft") {
    return res.status(409).json({ error: "Already issued" });
  }
  try {
    const issued = await issueEstimate(est, req.userId ?? null);
    const [hydrated] = await hydrateEstimates(cid, [issued]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/estimates/:slug/send", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  let est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  if (est.status === "void") {
    return res.status(409).json({ error: "Voided estimates cannot be sent" });
  }
  if (est.status === "draft") {
    est = await issueEstimate(est, req.userId ?? null);
  }
  try {
    const result = await sendEstimateEmail(cid, est, req.userId ?? null);
    const [hydrated] = await hydrateEstimates(cid, [est]);
    res.json({ estimate: hydrated, send: result });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/estimates/:slug/accept", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  try {
    const updated = await acceptEstimate(est, req.userId ?? null);
    const [hydrated] = await hydrateEstimates(cid, [updated]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/estimates/:slug/decline", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  try {
    const updated = await declineEstimate(est, req.userId ?? null);
    const [hydrated] = await hydrateEstimates(cid, [updated]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/estimates/:slug/void", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  try {
    const voided = await voidEstimate(est, req.userId ?? null);
    const [hydrated] = await hydrateEstimates(cid, [voided]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Duplicate (clone into a fresh draft — works on any status, including
// void/declined/invoiced; the resulting invoice link is intentionally
// not copied).
financeRouter.post("/estimates/:slug/duplicate", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const est = await loadEstimateBySlug(cid, req.params.slug);
  if (!est) return res.status(404).json({ error: "Estimate not found" });
  try {
    const draft = await duplicateEstimate(est, req.userId ?? null);
    const [hydrated] = await hydrateEstimates(cid, [draft]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const estimateConvertSchema = z.object({
  dueInDays: z.number().int().min(0).max(365).optional(),
});

financeRouter.post(
  "/estimates/:slug/convert",
  validateBody(estimateConvertSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const est = await loadEstimateBySlug(cid, req.params.slug);
    if (!est) return res.status(404).json({ error: "Estimate not found" });
    const body = req.body as z.infer<typeof estimateConvertSchema>;
    try {
      const { estimate: updated, invoice } = await convertEstimateToInvoice(
        est,
        req.userId ?? null,
        { dueInDays: body.dueInDays },
      );
      const [hydrated] = await hydrateEstimates(cid, [updated]);
      res.json({ estimate: hydrated, invoice });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

async function loadEstimatePrintBundle(
  companyId: string,
  slug: string,
): Promise<null | {
      estimate: Estimate;
      customer: Customer;
      lines: EstimateLineItem[];
}> {
  const estimate = await loadEstimateBySlug(companyId, slug);
  if (!estimate) return null;
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: estimate.customerId,
    companyId,
  });
  if (!customer) return null;
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
    order: { sortOrder: "ASC" },
  });
  return { estimate, customer, lines };
}

// Printable HTML — kept for previews and the email-send path.
financeRouter.get("/estimates/:slug/html", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const bundle = await loadEstimatePrintBundle(cid, req.params.slug);
  if (!bundle) return res.status(404).type("text/plain").send("Not found");
  const html = await renderEstimateHtmlForCompany(
    cid,
    bundle.estimate,
    bundle.customer,
    bundle.lines,
  );
  res.type("text/html").send(html);
});

// Server-rendered PDF for the "Download PDF" button. 503 on Chromium
// failure so the UI can surface a meaningful error.
financeRouter.get("/estimates/:slug/pdf", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const bundle = await loadEstimatePrintBundle(cid, req.params.slug);
  if (!bundle) return res.status(404).type("text/plain").send("Not found");
  const html = await renderEstimateHtmlForCompany(
    cid,
    bundle.estimate,
    bundle.customer,
    bundle.lines,
  );
  try {
    const pdf = await htmlToPdf(html);
    const filename = `${bundle.estimate.number || "draft"}.pdf`;
    res
      .type("application/pdf")
      .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      .send(pdf);
  } catch (err) {
    res
      .status(503)
      .type("text/plain")
      .send(`PDF rendering unavailable: ${(err as Error).message}`);
  }
});

// ─────────────────────────── Accounts (Phase B) ────────────────────────

const ACCOUNT_TYPES: [AccountType, ...AccountType[]] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

financeRouter.get("/accounts", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  // Auto-seed the default chart of accounts on first visit so the
  // accounts page is never empty for a brand-new company.
  const accounts = await seedChartOfAccounts(cid);
  res.json(accounts);
});

const accountWriteSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().uuid().nullable().optional(),
});

financeRouter.post("/accounts", validateBody(accountWriteSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof accountWriteSchema>;
    const repo = AppDataSource.getRepository(Account);
    const dup = await repo.findOneBy({ companyId: cid, code: body.code });
    if (dup) {
      return res.status(409).json({ error: "An account with that code already exists" });
    }
    if (body.parentId) {
      const parent = await repo.findOneBy({ id: body.parentId, companyId: cid });
      if (!parent) return res.status(400).json({ error: "Invalid parent account" });
    }
    const a = repo.create({
      companyId: cid,
      code: body.code,
      name: body.name,
      type: body.type,
      parentId: body.parentId ?? null,
      isSystem: false,
    });
    await repo.save(a);
    res.json(a);
});

financeRouter.patch(
  "/accounts/:id",
  validateBody(accountWriteSchema.partial().extend({ archived: z.boolean().optional() })),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const repo = AppDataSource.getRepository(Account);
    const a = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!a) return res.status(404).json({ error: "Account not found" });
    const body = req.body as Partial<z.infer<typeof accountWriteSchema>> & {
      archived?: boolean;
    };
    if (body.code !== undefined && body.code !== a.code) {
      if (a.isSystem) {
        return res
          .status(409)
          .json({ error: "System account codes cannot be renumbered — auto-post depends on them" });
      }
      const dup = await repo.findOneBy({ companyId: cid, code: body.code });
      if (dup) {
        return res.status(409).json({ error: "An account with that code already exists" });
      }
      a.code = body.code;
    }
    if (body.name !== undefined) a.name = body.name;
    if (body.type !== undefined) {
      if (a.isSystem) {
        return res.status(409).json({ error: "System account types cannot change" });
      }
      a.type = body.type;
    }
    if (body.parentId !== undefined) a.parentId = body.parentId;
    if (body.archived !== undefined) {
      if (a.isSystem && body.archived) {
        return res.status(409).json({ error: "System accounts cannot be archived" });
      }
      a.archivedAt = body.archived ? new Date() : null;
    }
    await repo.save(a);
    res.json(a);
  },
);

financeRouter.delete("/accounts/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(Account);
  const a = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!a) return res.status(404).json({ error: "Account not found" });
  if (a.isSystem) {
    return res
      .status(409)
      .json({ error: "System accounts cannot be deleted — archive them instead" });
  }
  const used = await AppDataSource.getRepository(LedgerLine).count({
    where: { accountId: a.id },
  });
  if (used > 0) {
    return res.status(409).json({ error: "Account has ledger lines — archive it instead" });
  }
  await repo.delete({ id: a.id });
  res.json({ ok: true });
});

// ─────────────────────────── Ledger entries ────────────────────────────

type HydratedLedgerEntry = LedgerEntry & {
  lines: LedgerLine[];
  totalCents: number;
};

async function hydrateLedgerEntries(entries: LedgerEntry[]): Promise<HydratedLedgerEntry[]> {
  if (entries.length === 0) return [];
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: In(entries.map((e) => e.id)) },
    order: { sortOrder: "ASC" },
  });
  const byEntry = new Map<string, LedgerLine[]>();
  for (const l of lines) {
    const arr = byEntry.get(l.ledgerEntryId) ?? [];
    arr.push(l);
    byEntry.set(l.ledgerEntryId, arr);
  }
  return entries.map((e) => {
    const ls = byEntry.get(e.id) ?? [];
    return {
      ...e,
      lines: ls,
      totalCents: ls.reduce((s, l) => s + l.debitCents, 0),
    };
  });
}

financeRouter.get("/ledger-entries", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  const source = req.query.source;
  if (typeof source === "string" && source) where.source = source;
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where,
    order: { date: "DESC", createdAt: "DESC" },
    take: 200,
  });
  res.json(await hydrateLedgerEntries(entries));
});

const ledgerLineDraftSchema = z.object({
  accountId: z.string().uuid(),
  debitCents: z.number().int().min(0).max(2_000_000_000).optional(),
  creditCents: z.number().int().min(0).max(2_000_000_000).optional(),
  description: z.string().max(500).optional(),
});

const ledgerEntryCreateSchema = z.object({
  date: z.string().datetime().optional(),
  memo: z.string().max(1000).optional(),
  lines: z.array(ledgerLineDraftSchema).min(2).max(50),
});

financeRouter.post("/ledger-entries", validateBody(ledgerEntryCreateSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof ledgerEntryCreateSchema>;
    try {
      const { entry } = await postLedgerEntry({
        companyId: cid,
        date: body.date ? new Date(body.date) : new Date(),
        memo: body.memo ?? "",
        source: "manual",
        sourceRefId: null,
        createdById: req.userId ?? null,
        lines: body.lines,
      });
      const [hydrated] = await hydrateLedgerEntries([entry]);
      res.json(hydrated);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
});

financeRouter.delete("/ledger-entries/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(LedgerEntry);
  const e = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!e) return res.status(404).json({ error: "Entry not found" });
  if (e.source !== "manual") {
    return res
      .status(409)
      .json({ error: "Auto-posted entries cannot be deleted directly — void the source instead" });
  }
  await AppDataSource.getRepository(LedgerLine).delete({ ledgerEntryId: e.id });
  await repo.delete({ id: e.id });
  res.json({ ok: true });
});

// ─────────────────────────── Trial balance ─────────────────────────────

financeRouter.get("/ledger/trial-balance", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const asOfQ = req.query.asOf;
  const asOf = typeof asOfQ === "string" && asOfQ ? new Date(asOfQ) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    return res.status(400).json({ error: "Invalid asOf date" });
  }
  const rows = await trialBalance(cid, asOf);
  res.json({ asOf: asOf.toISOString(), rows });
});

// ───────────────────────────── Reports (Phase C) ───────────────────────

/**
 * Parse a query-string ISO date and validate it. Returns null when the
 * param is missing/empty (caller picks a default), throws when the
 * value is present but unparseable so the route can return 400.
 */
function parseDateParam(raw: unknown, label: string): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label} date`);
  }
  return d;
}

financeRouter.get("/reports/income-statement", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  try {
    const from = parseDateParam(req.query.from, "from");
    const to = parseDateParam(req.query.to, "to");
    if (!from || !to) {
      return res.status(400).json({ error: "from and to are required" });
    }
    const compareFrom = parseDateParam(req.query.compareFrom, "compareFrom");
    const compareTo = parseDateParam(req.query.compareTo, "compareTo");
    const current = await incomeStatement(cid, from, to);
    const prior =
      compareFrom && compareTo ? await incomeStatement(cid, compareFrom, compareTo) : null;
    res.json({ current, prior });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.get("/reports/balance-sheet", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  try {
    const asOfRaw = parseDateParam(req.query.asOf, "asOf");
    const asOf = asOfRaw ?? new Date();
    const compareAsOf = parseDateParam(req.query.compareAsOf, "compareAsOf");
    const current = await balanceSheet(cid, asOf);
    const prior = compareAsOf ? await balanceSheet(cid, compareAsOf) : null;
    res.json({ current, prior });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.get("/reports/cash-flow", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  try {
    const from = parseDateParam(req.query.from, "from");
    const to = parseDateParam(req.query.to, "to");
    if (!from || !to) {
      return res.status(400).json({ error: "from and to are required" });
    }
    const compareFrom = parseDateParam(req.query.compareFrom, "compareFrom");
    const compareTo = parseDateParam(req.query.compareTo, "compareTo");
    const current = await cashFlow(cid, from, to);
    const prior = compareFrom && compareTo ? await cashFlow(cid, compareFrom, compareTo) : null;
    res.json({ current, prior });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Account activity feed for a single account in an optional date
 * range. Powers the "click any line in a report to drill through"
 * panel — the report rows post `accountId` plus the report's date
 * range and get back a running-balance ledger.
 */
financeRouter.get("/reports/account-activity", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const accountId = req.query.accountId;
  if (typeof accountId !== "string" || !accountId) {
    return res.status(400).json({ error: "accountId is required" });
  }
  try {
    const from = parseDateParam(req.query.from, "from");
    const to = parseDateParam(req.query.to, "to");
    const report = await accountActivity(cid, accountId, from, to);
    if (!report) return res.status(404).json({ error: "Account not found" });
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─────────────────────── Bank feeds (Phase D) ──────────────────────────

const FEED_KINDS: [BankFeedKind, ...BankFeedKind[]] = [
  "stripe_payouts",
  "brex_cash",
  "csv",
];

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

financeRouter.get("/bank-feeds", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const feeds = await AppDataSource.getRepository(BankFeed).find({
    where: { companyId: cid },
    order: { createdAt: "ASC" },
  });
  res.json(feeds);
});

const brexAccountsQuerySchema = z.object({
  connectionId: z.string().uuid(),
});

financeRouter.get("/bank-feeds/brex-accounts", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const parsed = brexAccountsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "A valid Brex connectionId is required" });
  }
  try {
    res.json(await listBrexCashAccountsForConnection(cid, parsed.data.connectionId));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const feedCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(FEED_KINDS),
  accountId: z.string().uuid(),
  connectionId: z.string().uuid().nullable().optional(),
  externalAccountId: z.string().min(1).max(255).nullable().optional(),
});

financeRouter.post(
  "/bank-feeds",
  validateBody(feedCreateSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof feedCreateSchema>;
    const acct = await AppDataSource.getRepository(Account).findOneBy({
      id: body.accountId,
      companyId: cid,
    });
    if (!acct) return res.status(400).json({ error: "Invalid account" });
    if (acct.type !== "asset") {
      return res
        .status(400)
        .json({ error: "Bank feeds reconcile against asset accounts only" });
    }
    if (body.kind === "stripe_payouts") {
      if (!body.connectionId) {
        return res.status(400).json({ error: "Stripe feeds need a connectionId" });
      }
      const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
        id: body.connectionId,
        companyId: cid,
      });
      if (!conn || conn.provider !== "stripe") {
        return res.status(400).json({ error: "Connection is not Stripe" });
      }
    } else if (body.kind === "brex_cash") {
      if (!body.connectionId) {
        return res.status(400).json({ error: "Brex feeds need a connectionId" });
      }
      if (!body.externalAccountId) {
        return res.status(400).json({ error: "Brex feeds need a Cash account" });
      }
      try {
        await assertBrexCashAccountConnection(
          cid,
          body.connectionId,
          body.externalAccountId,
        );
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }
    }
    const repo = AppDataSource.getRepository(BankFeed);
    const f = repo.create({
      companyId: cid,
      name: body.name,
      kind: body.kind,
      accountId: body.accountId,
      connectionId: body.kind === "csv" ? null : body.connectionId ?? null,
      externalAccountId:
        body.kind === "brex_cash" ? body.externalAccountId ?? null : null,
    });
    await repo.save(f);
    res.json(f);
  },
);

financeRouter.delete("/bank-feeds/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(BankFeed);
  const f = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!f) return res.status(404).json({ error: "Feed not found" });
  await AppDataSource.getRepository(BankTransaction).delete({ feedId: f.id });
  await repo.delete({ id: f.id });
  res.json({ ok: true });
});

financeRouter.post("/bank-feeds/:id/sync", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(BankFeed);
  const f = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!f) return res.status(404).json({ error: "Feed not found" });
  try {
    const inserted = await syncBankFeed(f);
    const matched = await autoMatchFeed(f);
    res.json({ inserted, matched });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post(
  "/bank-feeds/:id/import",
  csvUpload.single("file"),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const repo = AppDataSource.getRepository(BankFeed);
    const f = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!f) return res.status(404).json({ error: "Feed not found" });
    if (!req.file) return res.status(400).json({ error: "Missing CSV file" });
    try {
      const text = req.file.buffer.toString("utf8");
      const result = await importBankCsv(f, text);
      const matched = await autoMatchFeed(f);
      res.json({ ...result, matched });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// ─────────────────────── Bank transactions ─────────────────────────────

type HydratedBankTransaction = BankTransaction & {
  match: null | {
    kind: "payment";
    paymentId: string;
    invoiceNumber: string;
    invoiceSlug: string;
    customerName: string;
  }
    | { kind: "ledger_entry"; entryId: string; memo: string };
};

async function hydrateBankTxns(
  companyId: string,
  txns: BankTransaction[],
): Promise<HydratedBankTransaction[]> {
  if (txns.length === 0) return [];
  const paymentIds = [
    ...new Set(txns.map((t) => t.matchedPaymentId).filter((x): x is string => !!x)),
  ];
  const entryIds = [
    ...new Set(txns.map((t) => t.matchedLedgerEntryId).filter((x): x is string => !!x)),
  ];
  const [payments, entries] = await Promise.all([
    paymentIds.length
      ? AppDataSource.getRepository(InvoicePayment).find({
          where: { id: In(paymentIds) },
        })
      : Promise.resolve([]),
    entryIds.length
      ? AppDataSource.getRepository(LedgerEntry).find({
          where: { id: In(entryIds), companyId },
        })
      : Promise.resolve([]),
  ]);
  const invIds = [...new Set(payments.map((p) => p.invoiceId))];
  const invoices = invIds.length
    ? await AppDataSource.getRepository(Invoice).find({
        where: { id: In(invIds), companyId },
      })
    : [];
  const customerIds = [...new Set(invoices.map((i) => i.customerId))];
  const customers = customerIds.length
    ? await AppDataSource.getRepository(Customer).find({
        where: { id: In(customerIds), companyId },
      })
    : [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const custById = new Map(customers.map((c) => [c.id, c]));
  const payById = new Map(payments.map((p) => [p.id, p]));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  return txns.map((t) => {
    let match: HydratedBankTransaction["match"] = null;
    if (t.matchedPaymentId) {
      const p = payById.get(t.matchedPaymentId);
      const inv = p ? invById.get(p.invoiceId) : null;
      const cust = inv ? custById.get(inv.customerId) : null;
      if (p && inv) {
        match = {
          kind: "payment",
          paymentId: p.id,
          invoiceNumber: inv.number || "(draft)",
          invoiceSlug: inv.slug,
          customerName: cust?.name ?? "—",
        };
      }
    } else if (t.matchedLedgerEntryId) {
      const e = entryById.get(t.matchedLedgerEntryId);
      if (e) match = { kind: "ledger_entry", entryId: e.id, memo: e.memo };
    }
    return { ...t, match };
  });
}

financeRouter.get("/bank-transactions", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  if (typeof req.query.feedId === "string" && req.query.feedId) {
    where.feedId = req.query.feedId;
  }
  let txns = await AppDataSource.getRepository(BankTransaction).find({
    where,
    order: { date: "DESC", createdAt: "DESC" },
    take: 500,
  });
  if (String(req.query.unmatched ?? "") === "true") {
    txns = txns.filter((t) => !t.reconciledAt);
  }
  res.json(await hydrateBankTxns(cid, txns));
});

financeRouter.get("/bank-transactions/:id/candidates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(BankTransaction);
  const t = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!t) return res.status(404).json({ error: "Transaction not found" });
  const candidates = await findMatchCandidates(t);
  res.json(candidates);
});

const matchSchema = z.object({
  paymentId: z.string().uuid().nullable().optional(),
  ledgerEntryId: z.string().uuid().nullable().optional(),
});

financeRouter.post("/bank-transactions/:id/match", validateBody(matchSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const repo = AppDataSource.getRepository(BankTransaction);
    const t = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!t) return res.status(404).json({ error: "Transaction not found" });
    const body = req.body as z.infer<typeof matchSchema>;
    try {
      const fresh = await manualMatch(t, body, req.userId ?? null);
      const [hydrated] = await hydrateBankTxns(cid, [fresh]);
      res.json(hydrated);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
});

financeRouter.post("/bank-transactions/:id/unmatch", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(BankTransaction);
  const t = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!t) return res.status(404).json({ error: "Transaction not found" });
  const fresh = await unmatch(t);
  const [hydrated] = await hydrateBankTxns(cid, [fresh]);
  res.json(hydrated);
});

// ─────────────────────── Multi-currency (Phase E) ──────────────────────

financeRouter.get("/finance-settings", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const s = await getFinanceSettings(cid);
  res.json(s);
});

const settingsPatchSchema = z.object({
  homeCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  defaultFromBlock: z.string().max(4000).optional(),
  defaultFooter: z.string().max(2000).optional(),
});

financeRouter.patch("/finance-settings", validateBody(settingsPatchSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof settingsPatchSchema>;
    if (body.homeCurrency !== undefined) {
      await setHomeCurrency(cid, body.homeCurrency);
    }
  if (body.defaultFromBlock !== undefined || body.defaultFooter !== undefined) {
      await setFinanceTemplates(cid, {
        defaultFromBlock: body.defaultFromBlock,
        defaultFooter: body.defaultFooter,
      });
    }
    res.json(await getFinanceSettings(cid));
});

financeRouter.get("/currencies", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  res.json(await seedCurrencies(cid));
});

const currencyCreateSchema = z.object({
  code: z.string().regex(/^[A-Za-z]{3}$/),
  name: z.string().min(1).max(60),
  symbol: z.string().max(8).optional(),
  decimalPlaces: z.number().int().min(0).max(8).optional(),
});

financeRouter.post("/currencies", validateBody(currencyCreateSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof currencyCreateSchema>;
    const repo = AppDataSource.getRepository(Currency);
    const code = body.code.toUpperCase();
    const dup = await repo.findOneBy({ companyId: cid, code });
    if (dup) return res.status(409).json({ error: "Currency already exists" });
    const c = await repo.save(
      repo.create({
        companyId: cid,
        code,
        name: body.name,
        symbol: body.symbol ?? "",
        decimalPlaces: body.decimalPlaces ?? 2,
      }),
    );
    res.json(c);
});

financeRouter.delete("/currencies/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(Currency);
  const c = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!c) return res.status(404).json({ error: "Currency not found" });
  const settings = await getFinanceSettings(cid);
  if (settings.homeCurrency === c.code) {
    return res.status(409).json({ error: "Cannot delete the home currency" });
  }
  await repo.delete({ id: c.id });
  res.json({ ok: true });
});

financeRouter.get("/exchange-rates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  if (typeof req.query.from === "string" && req.query.from) {
    where.fromCurrency = (req.query.from as string).toUpperCase();
  }
  if (typeof req.query.to === "string" && req.query.to) {
    where.toCurrency = (req.query.to as string).toUpperCase();
  }
  const rates = await AppDataSource.getRepository(ExchangeRate).find({
    where,
    order: { date: "DESC" },
    take: 200,
  });
  res.json(rates);
});

const rateUpsertSchema = z.object({
  fromCurrency: z.string().regex(/^[A-Za-z]{3}$/),
  toCurrency: z.string().regex(/^[A-Za-z]{3}$/),
  date: z.string().datetime(),
  rate: z.number().positive(),
  source: z.string().max(120).optional(),
});

financeRouter.post("/exchange-rates", validateBody(rateUpsertSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof rateUpsertSchema>;
    if (body.fromCurrency.toUpperCase() === body.toCurrency.toUpperCase()) {
    return res.status(400).json({ error: "from and to currencies must differ" });
    }
    const r = await setRate(
      cid,
      body.fromCurrency,
      body.toCurrency,
      new Date(body.date),
      body.rate,
      body.source ?? "manual",
    );
    res.json(r);
});

financeRouter.delete("/exchange-rates/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(ExchangeRate);
  const r = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!r) return res.status(404).json({ error: "Rate not found" });
  await repo.delete({ id: r.id });
  res.json({ ok: true });
});

// ─────────────────── Periods + exports (Phase F) ───────────────────────

financeRouter.get("/periods", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const periods = await AppDataSource.getRepository(AccountingPeriod).find({
    where: { companyId: cid },
    order: { startDate: "DESC" },
  });
  res.json(periods);
});

const periodCreateSchema = z.object({
  name: z.string().min(1).max(60),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
});

financeRouter.post("/periods", validateBody(periodCreateSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof periodCreateSchema>;
    const start = new Date(body.startDate);
    const end = new Date(body.endDate);
    if (end.getTime() < start.getTime()) {
      return res.status(400).json({ error: "endDate must be after startDate" });
    }
    const repo = AppDataSource.getRepository(AccountingPeriod);
    const p = await repo.save(
      repo.create({
        companyId: cid,
        name: body.name,
        startDate: start,
        endDate: end,
      }),
    );
    res.json(p);
});

financeRouter.delete("/periods/:id", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(AccountingPeriod);
  const p = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!p) return res.status(404).json({ error: "Period not found" });
  if (p.status === "closed") {
    return res.status(409).json({ error: "Re-open the period before deleting" });
  }
  await repo.delete({ id: p.id });
  res.json({ ok: true });
});

financeRouter.post("/periods/:id/close", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(AccountingPeriod);
  const p = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!p) return res.status(404).json({ error: "Period not found" });
  try {
    const closed = await closePeriod(p, req.userId ?? null);
    res.json(closed);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/periods/:id/reopen", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(AccountingPeriod);
  const p = await repo.findOneBy({ id: req.params.id, companyId: cid });
  if (!p) return res.status(404).json({ error: "Period not found" });
  try {
    const opened = await reopenPeriod(p);
    res.json(opened);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// CSV exports — text/csv with a Content-Disposition so the browser
// saves to a sensible filename. `from` and `to` are optional ISO
// dates; missing means unbounded on that side.

function parseOptionalDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

financeRouter.get("/exports/customers.csv", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const csv = await exportCustomersCsv(cid);
  res.type("text/csv").attachment("customers.csv").send(csv);
});

financeRouter.get("/exports/invoices.csv", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const csv = await exportInvoicesCsv(
    cid,
    parseOptionalDate(req.query.from),
    parseOptionalDate(req.query.to),
  );
  res.type("text/csv").attachment("invoices.csv").send(csv);
});

financeRouter.get("/exports/journal.csv", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const csv = await exportJournalCsv(
    cid,
    parseOptionalDate(req.query.from),
    parseOptionalDate(req.query.to),
  );
  res.type("text/csv").attachment("journal.csv").send(csv);
});

financeRouter.get("/exports/trial-balance.csv", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const asOf = parseOptionalDate(req.query.asOf) ?? new Date();
  const csv = await exportTrialBalanceCsv(cid, asOf);
  res.type("text/csv").attachment("trial-balance.csv").send(csv);
});

// ─────────────────────────── Vendors (Phase G) ─────────────────────────

async function uniqueVendorSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Vendor);
  let slug = base || "vendor";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

financeRouter.get("/vendors", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const includeArchived = String(req.query.archived ?? "") === "true";
  const list = await AppDataSource.getRepository(Vendor).find({
    where: { companyId: cid },
    order: { createdAt: "DESC" },
  });
  res.json(includeArchived ? list : list.filter((v) => !v.archivedAt));
});

const vendorWriteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200).or(z.literal("")).optional(),
  phone: z.string().max(60).optional(),
  address: z.string().max(2000).optional(),
  taxNumber: z.string().max(60).optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(2000).optional(),
});

financeRouter.post("/vendors", validateBody(vendorWriteSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof vendorWriteSchema>;
    const slug = await uniqueVendorSlug(cid, toSlug(body.name));
    const repo = AppDataSource.getRepository(Vendor);
    const v = repo.create({
      companyId: cid,
      name: body.name,
      slug,
      email: body.email ?? "",
      phone: body.phone ?? "",
      address: body.address ?? "",
      taxNumber: body.taxNumber ?? "",
      currency: body.currency ?? "USD",
      notes: body.notes ?? "",
      createdById: req.userId ?? null,
    });
    await repo.save(v);
    res.json(v);
});

financeRouter.patch(
  "/vendors/:slug",
  validateBody(vendorWriteSchema.extend({ archived: z.boolean().optional() }).partial()),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const v = await loadVendorBySlug(cid, req.params.slug);
    if (!v) return res.status(404).json({ error: "Vendor not found" });
    const body = req.body as Partial<z.infer<typeof vendorWriteSchema>> & {
      archived?: boolean;
    };
    if (body.name !== undefined) v.name = body.name;
    if (body.email !== undefined) v.email = body.email;
    if (body.phone !== undefined) v.phone = body.phone;
    if (body.address !== undefined) v.address = body.address;
    if (body.taxNumber !== undefined) v.taxNumber = body.taxNumber;
    if (body.currency !== undefined) v.currency = body.currency;
    if (body.notes !== undefined) v.notes = body.notes;
    if (body.archived !== undefined) {
      v.archivedAt = body.archived ? new Date() : null;
    }
    await AppDataSource.getRepository(Vendor).save(v);
    res.json(v);
  },
);

financeRouter.delete("/vendors/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const v = await loadVendorBySlug(cid, req.params.slug);
  if (!v) return res.status(404).json({ error: "Vendor not found" });
  const billCount = await AppDataSource.getRepository(Bill).count({
    where: { companyId: cid, vendorId: v.id },
  });
  if (billCount > 0) {
    return res
      .status(409)
      .json({ error: "Vendor has bills. Archive instead or delete the bills first." });
  }
  await AppDataSource.getRepository(Vendor).delete({ id: v.id });
  res.json({ ok: true });
});

// ─────────────────────────── Bills ─────────────────────────────────────

async function draftBillSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Bill);
  for (let i = 0; i < 16; i += 1) {
    const slug = `bdraft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `bdraft-${Date.now().toString(36)}`;
}

const billLineDraftSchema = z.object({
  expenseAccountId: z.string().uuid().nullable().optional(),
  description: z.string().min(1).max(500),
  quantity: z.number().min(0).max(1_000_000),
  unitPriceCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  taxRateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const billCreateSchema = z.object({
  vendorId: z.string().uuid(),
  vendorRef: z.string().max(120).optional(),
  issueDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(4000).optional(),
  lines: z.array(billLineDraftSchema).max(200).optional(),
});

financeRouter.get("/bills", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  if (typeof req.query.status === "string" && req.query.status) {
    where.status = req.query.status;
  }
  if (typeof req.query.vendorId === "string" && req.query.vendorId) {
    where.vendorId = req.query.vendorId;
  }
  const list = await AppDataSource.getRepository(Bill).find({
    where,
    order: { createdAt: "DESC" },
  });
  const hydrated = await hydrateBills(cid, list);
  res.json(
    hydrated.map(({ lines: _lines, payments: _payments, ...rest }) => ({
      ...rest,
      linesCount: _lines.length,
      paymentsCount: _payments.length,
    })),
  );
});

financeRouter.post("/bills", validateBody(billCreateSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof billCreateSchema>;
    const vendor = await AppDataSource.getRepository(Vendor).findOneBy({
      id: body.vendorId,
      companyId: cid,
    });
    if (!vendor) return res.status(400).json({ error: "Invalid vendor" });
    const repo = AppDataSource.getRepository(Bill);
    const slug = await draftBillSlug(cid);
    const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
    const dueDate = body.dueDate
      ? new Date(body.dueDate)
      : new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
    const b = repo.create({
      companyId: cid,
      vendorId: vendor.id,
      slug,
      numberSeq: 0,
      number: "",
      vendorRef: body.vendorRef ?? "",
      status: "draft",
      issueDate,
      dueDate,
      currency: body.currency ?? vendor.currency ?? "USD",
      notes: body.notes ?? "",
      createdById: req.userId ?? null,
    });
    await repo.save(b);
    if (body.lines && body.lines.length > 0) {
      await replaceBillLines(b, body.lines);
    }
    const recomputed = await recomputeBillTotals(b);
    const [hydrated] = await hydrateBills(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.get("/bills/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBillBySlug(cid, req.params.slug);
  if (!b) return res.status(404).json({ error: "Bill not found" });
  const [hydrated] = await hydrateBills(cid, [b]);
  res.json(hydrated);
});

const billPatchSchema = z.object({
  notes: z.string().max(4000).optional(),
  vendorRef: z.string().max(120).optional(),
  dueDate: z.string().datetime().optional(),
  vendorId: z.string().uuid().optional(),
  issueDate: z.string().datetime().optional(),
  currency: currencySchema.optional(),
  lines: z.array(billLineDraftSchema).max(200).optional(),
});

financeRouter.patch("/bills/:slug", validateBody(billPatchSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBillBySlug(cid, req.params.slug);
    if (!b) return res.status(404).json({ error: "Bill not found" });
    if (b.status === "void") {
      return res.status(409).json({ error: "Voided bills cannot be edited" });
    }
    const body = req.body as z.infer<typeof billPatchSchema>;
    const draftOnly =
      body.vendorId !== undefined ||
      body.issueDate !== undefined ||
      body.currency !== undefined ||
      body.lines !== undefined;
    if (draftOnly && b.status !== "draft") {
      return res
        .status(409)
        .json({ error: "Lines and header (vendor/date/currency) are draft-only" });
    }
    if (body.notes !== undefined) b.notes = body.notes;
    if (body.vendorRef !== undefined) b.vendorRef = body.vendorRef;
    if (body.dueDate !== undefined) b.dueDate = new Date(body.dueDate);
    if (body.vendorId !== undefined) {
      const v = await AppDataSource.getRepository(Vendor).findOneBy({
        id: body.vendorId,
        companyId: cid,
      });
      if (!v) return res.status(400).json({ error: "Invalid vendor" });
      b.vendorId = v.id;
    }
    if (body.issueDate !== undefined) b.issueDate = new Date(body.issueDate);
    if (body.currency !== undefined) b.currency = body.currency;
    await AppDataSource.getRepository(Bill).save(b);
    if (body.lines !== undefined) await replaceBillLines(b, body.lines);
    const recomputed = await recomputeBillTotals(b);
    const [hydrated] = await hydrateBills(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.delete("/bills/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBillBySlug(cid, req.params.slug);
  if (!b) return res.status(404).json({ error: "Bill not found" });
  if (b.status !== "draft") {
    return res
      .status(409)
      .json({ error: "Only drafts can be deleted — void issued bills instead" });
  }
  await AppDataSource.getRepository(BillLineItem).delete({ billId: b.id });
  await AppDataSource.getRepository(BillPayment).delete({ billId: b.id });
  await AppDataSource.getRepository(Bill).delete({ id: b.id });
  res.json({ ok: true });
});

financeRouter.post("/bills/:slug/issue", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBillBySlug(cid, req.params.slug);
  if (!b) return res.status(404).json({ error: "Bill not found" });
  if (b.status !== "draft") return res.status(409).json({ error: "Already issued" });
  try {
    const issued = await issueBill(b, req.userId ?? null);
    const [hydrated] = await hydrateBills(cid, [issued]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

financeRouter.post("/bills/:slug/void", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBillBySlug(cid, req.params.slug);
  if (!b) return res.status(404).json({ error: "Bill not found" });
  try {
    const voided = await voidBill(b, req.userId ?? null);
    const [hydrated] = await hydrateBills(cid, [voided]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const billPaymentSchema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  currency: currencySchema.optional(),
  paidAt: z.string().datetime().optional(),
  method: z.enum(["cash", "bank_transfer", "stripe", "lightning", "other"]).optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

financeRouter.post("/bills/:slug/payments", validateBody(billPaymentSchema), async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBillBySlug(cid, req.params.slug);
    if (!b) return res.status(404).json({ error: "Bill not found" });
    if (b.status === "draft") {
      return res.status(409).json({ error: "Issue the bill before paying" });
    }
    if (b.status === "void") {
      return res.status(409).json({ error: "Voided bills cannot be paid" });
    }
    const body = req.body as z.infer<typeof billPaymentSchema>;
    const repo = AppDataSource.getRepository(BillPayment);
    const p = await repo.save(
      repo.create({
        billId: b.id,
        amountCents: body.amountCents,
        currency: body.currency ?? b.currency,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        method: (body.method ?? "other") as BillPaymentMethod,
        reference: body.reference ?? "",
        notes: body.notes ?? "",
        createdById: req.userId ?? null,
      }),
    );
    try {
      await postBillPayment(b, p, req.userId ?? null);
    } catch (err) {
      // Roll back the payment row if the ledger post fails (typical
      // cause: a closed period covers the payment date).
      await repo.delete({ id: p.id });
      return res.status(400).json({ error: (err as Error).message });
    }
    const recomputed = await recomputeBillTotals(b);
    const [hydrated] = await hydrateBills(cid, [recomputed]);
    res.json(hydrated);
});

financeRouter.delete("/bills/:slug/payments/:pid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBillBySlug(cid, req.params.slug);
  if (!b) return res.status(404).json({ error: "Bill not found" });
  const repo = AppDataSource.getRepository(BillPayment);
  const p = await repo.findOneBy({ id: req.params.pid, billId: b.id });
  if (!p) return res.status(404).json({ error: "Payment not found" });
  await reverseBillPayment(b, p, req.userId ?? null);
  await repo.delete({ id: p.id });
  const recomputed = await recomputeBillTotals(b);
  const [hydrated] = await hydrateBills(cid, [recomputed]);
  res.json(hydrated);
});

// Convenience for the UI: a "display status" snapshot that promotes
// `sent` → `overdue` past dueDate. The list endpoint above already
// returns enough info for the client to compute this; this endpoint
// exists so MCP tools (Phase H+) can ask the server for the same.
financeRouter.get("/bills/:slug/display-status", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBillBySlug(cid, req.params.slug);
  if (!b) return res.status(404).json({ error: "Bill not found" });
  res.json({ status: billDisplayStatus(b) });
});

// ──────────────────────── Recurring invoices ───────────────────────────
//
// Schedule-driven invoice templates. Each row carries a cron expression
// and a set of template line items; the heartbeat in
// `services/recurringInvoices.ts` materializes a fresh Invoice on each
// fire. See ROADMAP.md M19 (Phase A follow-up).

async function uniqueRecurringInvoiceSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(RecurringInvoice);
  for (let i = 0; i < 16; i += 1) {
    const slug = `ri-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `ri-${Date.now().toString(36)}`;
}

const recurringLineDraftSchema = z.object({
  productId: z.string().uuid().nullable().optional(),
  description: z.string().min(1).max(500),
  quantity: z.number().min(0).max(1_000_000),
  unitPriceCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  taxRateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const recurringInvoiceCreateSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().min(1).max(200),
  cronExpr: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => cron.validate(v), "Invalid cron expression"),
  frequency: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).optional(),
  intervalCount: z.number().int().min(1).max(99).optional(),
  status: z.enum(["active", "paused"]).optional(),
  daysUntilDue: z.number().int().min(0).max(365).optional(),
  autoSend: z.boolean().optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(4000).optional(),
  footer: z.string().max(1000).optional(),
  maxRuns: z.number().int().min(1).max(10_000).nullable().optional(),
  endsOn: z.string().datetime().nullable().optional(),
  lines: z.array(recurringLineDraftSchema).max(200).optional(),
});

financeRouter.get("/recurring-invoices", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  const status = req.query.status;
  if (typeof status === "string" && status) where.status = status;
  const customerId = req.query.customerId;
  if (typeof customerId === "string" && customerId) where.customerId = customerId;
  const rows = await AppDataSource.getRepository(RecurringInvoice).find({
    where,
    order: { createdAt: "DESC" },
  });
  const hydrated = await hydrateRecurringInvoices(cid, rows);
  res.json(
    hydrated.map(({ lines: _lines, ...rest }) => ({
      ...rest,
      linesCount: _lines.length,
    })),
  );
});

financeRouter.post(
  "/recurring-invoices",
  validateBody(recurringInvoiceCreateSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof recurringInvoiceCreateSchema>;
    const customer = await AppDataSource.getRepository(Customer).findOneBy({
      id: body.customerId,
      companyId: cid,
    });
    if (!customer) return res.status(400).json({ error: "Invalid customer" });

    const repo = AppDataSource.getRepository(RecurringInvoice);
    const slug = await uniqueRecurringInvoiceSlug(cid);
    const ri = repo.create({
      companyId: cid,
      customerId: customer.id,
      slug,
      name: body.name,
      cronExpr: body.cronExpr,
      frequency: body.frequency ?? "monthly",
      intervalCount: body.intervalCount ?? 1,
      status: body.status ?? "active",
      daysUntilDue: body.daysUntilDue ?? 14,
      autoSend: body.autoSend ?? false,
      currency: body.currency ?? customer.currency ?? "USD",
      notes: body.notes ?? "",
      footer: body.footer ?? "",
      maxRuns: body.maxRuns ?? null,
      endsOn: body.endsOn ? new Date(body.endsOn) : null,
      runsCreated: 0,
      lastInvoiceSlug: "",
      createdById: req.userId ?? null,
    });
    registerRecurringInvoice(ri);
    await repo.save(ri);
    if (body.lines && body.lines.length > 0) {
      await replaceRecurringInvoiceLines(ri, body.lines);
    }
    const [hydrated] = await hydrateRecurringInvoices(cid, [ri]);
    res.json(hydrated);
  },
);

financeRouter.get("/recurring-invoices/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const ri = await loadRecurringInvoiceBySlug(cid, req.params.slug);
  if (!ri) return res.status(404).json({ error: "Recurring invoice not found" });
  const [hydrated] = await hydrateRecurringInvoices(cid, [ri]);
  res.json(hydrated);
});

const recurringInvoicePatchSchema = z.object({
  customerId: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  cronExpr: z
    .string()
    .min(1)
    .max(120)
    .refine((v) => cron.validate(v), "Invalid cron expression")
    .optional(),
  frequency: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]).optional(),
  intervalCount: z.number().int().min(1).max(99).optional(),
  status: z.enum(["active", "paused", "ended"]).optional(),
  daysUntilDue: z.number().int().min(0).max(365).optional(),
  autoSend: z.boolean().optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(4000).optional(),
  footer: z.string().max(1000).optional(),
  maxRuns: z.number().int().min(1).max(10_000).nullable().optional(),
  endsOn: z.string().datetime().nullable().optional(),
  lines: z.array(recurringLineDraftSchema).max(200).optional(),
});

financeRouter.patch(
  "/recurring-invoices/:slug",
  validateBody(recurringInvoicePatchSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const ri = await loadRecurringInvoiceBySlug(cid, req.params.slug);
    if (!ri) return res.status(404).json({ error: "Recurring invoice not found" });
    const body = req.body as z.infer<typeof recurringInvoicePatchSchema>;

    if (body.customerId !== undefined) {
      const c = await AppDataSource.getRepository(Customer).findOneBy({
        id: body.customerId,
        companyId: cid,
      });
      if (!c) return res.status(400).json({ error: "Invalid customer" });
      ri.customerId = c.id;
    }
    if (body.name !== undefined) ri.name = body.name;
    if (body.cronExpr !== undefined) ri.cronExpr = body.cronExpr;
    if (body.frequency !== undefined) ri.frequency = body.frequency;
    if (body.intervalCount !== undefined) ri.intervalCount = body.intervalCount;
    // A changed cadence (pattern, unit, or count) re-phases the interval:
    // drop the anchor so re-registration seeds a fresh one from now.
    if (
      body.cronExpr !== undefined ||
      body.frequency !== undefined ||
      body.intervalCount !== undefined
    ) {
      ri.anchorAt = null;
    }
    if (body.daysUntilDue !== undefined) ri.daysUntilDue = body.daysUntilDue;
    if (body.autoSend !== undefined) ri.autoSend = body.autoSend;
    if (body.currency !== undefined) ri.currency = body.currency;
    if (body.notes !== undefined) ri.notes = body.notes;
    if (body.footer !== undefined) ri.footer = body.footer;
    if (body.maxRuns !== undefined) ri.maxRuns = body.maxRuns;
    if (body.endsOn !== undefined) {
      ri.endsOn = body.endsOn ? new Date(body.endsOn) : null;
    }
    if (body.status !== undefined) {
      applyRecurringInvoiceStatus(ri, body.status);
    } else {
      // Re-register so a changed cron / cap / endsOn takes effect.
      registerRecurringInvoice(ri);
    }
    await AppDataSource.getRepository(RecurringInvoice).save(ri);

    if (body.lines !== undefined) {
      await replaceRecurringInvoiceLines(ri, body.lines);
    }
    const [hydrated] = await hydrateRecurringInvoices(cid, [ri]);
    res.json(hydrated);
  },
);

financeRouter.delete("/recurring-invoices/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const ri = await loadRecurringInvoiceBySlug(cid, req.params.slug);
  if (!ri) return res.status(404).json({ error: "Recurring invoice not found" });
  await AppDataSource.getRepository(RecurringInvoiceLineItem).delete({
    recurringInvoiceId: ri.id,
  });
  await AppDataSource.getRepository(RecurringInvoice).delete({ id: ri.id });
  res.json({ ok: true });
});

// Run-now: generate a single invoice immediately. Does NOT consume a
// scheduled slot — `nextRunAt` is untouched so the next scheduled fire
// still happens on time. The generated invoice is counted toward
// `runsCreated` though, so any `maxRuns` cap is respected.
financeRouter.post("/recurring-invoices/:slug/run-now", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const ri = await loadRecurringInvoiceBySlug(cid, req.params.slug);
  if (!ri) return res.status(404).json({ error: "Recurring invoice not found" });
  if (ri.status === "ended") {
    return res.status(409).json({ error: "This schedule has ended" });
  }
  try {
    const result = await generateInvoiceFromRecurring(ri, req.userId ?? null);
    ri.runsCreated += 1;
    ri.lastRunAt = new Date();
    ri.lastInvoiceSlug = result.invoice.slug;
    // Re-evaluate the cap; if this manual run hit it, status flips
    // automatically.
    registerRecurringInvoice(ri);
    await AppDataSource.getRepository(RecurringInvoice).save(ri);
    const [hydrated] = await hydrateRecurringInvoices(cid, [ri]);
    res.json({
      recurringInvoice: hydrated,
      invoice: result.invoice,
      emailStatus: result.emailStatus,
      emailError: result.emailError,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Duplicate: clone the schedule into a fresh, paused copy (run history
// reset, template lines copied). Paused on purpose so an exact copy of an
// active schedule doesn't immediately start billing the customer.
financeRouter.post("/recurring-invoices/:slug/duplicate", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const ri = await loadRecurringInvoiceBySlug(cid, req.params.slug);
  if (!ri) return res.status(404).json({ error: "Recurring invoice not found" });
  try {
    const copy = await duplicateRecurringInvoice(ri, req.userId ?? null);
    const [hydrated] = await hydrateRecurringInvoices(cid, [copy]);
    res.json(hydrated);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
