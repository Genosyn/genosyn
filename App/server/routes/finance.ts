import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account, AccountType } from "../db/entities/Account.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Product } from "../db/entities/Product.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import {
  hydrateInvoices,
  issueInvoice,
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
import { renderInvoiceHtmlForCompany } from "../services/invoiceHtml.js";
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

financeRouter.get("/customers", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const includeArchived = String(req.query.archived ?? "") === "true";
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { companyId: cid },
    order: { createdAt: "DESC" },
  });
  const filtered = includeArchived
    ? customers
    : customers.filter((c) => !c.archivedAt);
  res.json(filtered);
});

const customerWriteSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(200).or(z.literal("")).optional(),
  phone: z.string().max(60).optional(),
  billingAddress: z.string().max(2000).optional(),
  shippingAddress: z.string().max(2000).optional(),
  taxNumber: z.string().max(60).optional(),
  currency: currencySchema.optional(),
  notes: z.string().max(2000).optional(),
});

financeRouter.post(
  "/customers",
  validateBody(customerWriteSchema),
  async (req, res) => {
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
      notes: body.notes ?? "",
      createdById: req.userId ?? null,
    });
    await repo.save(c);
    res.json(c);
  },
);

financeRouter.get("/customers/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const c = await loadCustomerBySlug(cid, req.params.slug);
  if (!c) return res.status(404).json({ error: "Customer not found" });
  res.json(c);
});

financeRouter.patch(
  "/customers/:slug",
  validateBody(
    customerWriteSchema.extend({
      archived: z.boolean().optional(),
    }).partial(),
  ),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const c = await loadCustomerBySlug(cid, req.params.slug);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    const body = req.body as z.infer<typeof customerWriteSchema> & {
      archived?: boolean;
    };
    if (body.name !== undefined) c.name = body.name;
    if (body.email !== undefined) c.email = body.email;
    if (body.phone !== undefined) c.phone = body.phone;
    if (body.billingAddress !== undefined) c.billingAddress = body.billingAddress;
    if (body.shippingAddress !== undefined) c.shippingAddress = body.shippingAddress;
    if (body.taxNumber !== undefined) c.taxNumber = body.taxNumber;
    if (body.currency !== undefined) c.currency = body.currency;
    if (body.notes !== undefined) c.notes = body.notes;
    if (body.archived !== undefined) {
      c.archivedAt = body.archived ? new Date() : null;
    }
    await AppDataSource.getRepository(Customer).save(c);
    res.json(c);
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
  await AppDataSource.getRepository(Customer).delete({ id: c.id });
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

financeRouter.post(
  "/products",
  validateBody(productWriteSchema),
  async (req, res) => {
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
  },
);

financeRouter.patch(
  "/products/:slug",
  validateBody(
    productWriteSchema.extend({
      archived: z.boolean().optional(),
    }).partial(),
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

financeRouter.post(
  "/tax-rates",
  validateBody(taxRateWriteSchema),
  async (req, res) => {
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
  },
);

financeRouter.patch(
  "/tax-rates/:id",
  validateBody(
    taxRateWriteSchema.extend({ archived: z.boolean().optional() }).partial(),
  ),
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

financeRouter.post(
  "/invoices",
  validateBody(invoiceCreateSchema),
  async (req, res) => {
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
  },
);

financeRouter.get("/invoices/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const [hydrated] = await hydrateInvoices(cid, [inv]);
  res.json(hydrated);
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

financeRouter.patch(
  "/invoices/:slug",
  validateBody(invoicePatchSchema),
  async (req, res) => {
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
  },
);

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

// Email send (auto-issues drafts, then sends)
financeRouter.post("/invoices/:slug/send", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  let inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (inv.status === "void") {
    return res.status(409).json({ error: "Voided invoices cannot be sent" });
  }
  if (inv.status === "draft") {
    inv = await issueInvoice(inv, req.userId ?? null);
  }
  try {
    const result = await sendInvoiceEmail(cid, inv, req.userId ?? null);
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

// Printable HTML — used by the React InvoicePrint route via iframe so the
// browser's File → Print menu produces a clean PDF without our app chrome.
financeRouter.get("/invoices/:slug/html", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const inv = await loadInvoiceBySlug(cid, req.params.slug);
  if (!inv) return res.status(404).type("text/plain").send("Not found");
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: inv.customerId,
    companyId: cid,
  });
  if (!customer) return res.status(404).type("text/plain").send("Customer missing");
  const [lines, payments] = await Promise.all([
    AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: inv.id },
      order: { sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: inv.id },
      order: { paidAt: "ASC" },
    }),
  ]);
  const html = await renderInvoiceHtmlForCompany(cid, inv, customer, lines, payments);
  res.type("text/html").send(html);
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
      return res
        .status(409)
        .json({ error: "Issue the invoice before recording payments" });
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
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/),
  name: z.string().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().uuid().nullable().optional(),
});

financeRouter.post(
  "/accounts",
  validateBody(accountWriteSchema),
  async (req, res) => {
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
  },
);

financeRouter.patch(
  "/accounts/:id",
  validateBody(
    accountWriteSchema.partial().extend({ archived: z.boolean().optional() }),
  ),
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
        return res
          .status(409)
          .json({ error: "An account with that code already exists" });
      }
      a.code = body.code;
    }
    if (body.name !== undefined) a.name = body.name;
    if (body.type !== undefined) {
      if (a.isSystem) {
        return res
          .status(409)
          .json({ error: "System account types cannot change" });
      }
      a.type = body.type;
    }
    if (body.parentId !== undefined) a.parentId = body.parentId;
    if (body.archived !== undefined) {
      if (a.isSystem && body.archived) {
        return res
          .status(409)
          .json({ error: "System accounts cannot be archived" });
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
    return res
      .status(409)
      .json({ error: "Account has ledger lines — archive it instead" });
  }
  await repo.delete({ id: a.id });
  res.json({ ok: true });
});

// ─────────────────────────── Ledger entries ────────────────────────────

type HydratedLedgerEntry = LedgerEntry & {
  lines: LedgerLine[];
  totalCents: number;
};

async function hydrateLedgerEntries(
  entries: LedgerEntry[],
): Promise<HydratedLedgerEntry[]> {
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

financeRouter.post(
  "/ledger-entries",
  validateBody(ledgerEntryCreateSchema),
  async (req, res) => {
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
  },
);

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
  const asOf =
    typeof asOfQ === "string" && asOfQ ? new Date(asOfQ) : new Date();
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
      compareFrom && compareTo
        ? await incomeStatement(cid, compareFrom, compareTo)
        : null;
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
    const prior =
      compareFrom && compareTo ? await cashFlow(cid, compareFrom, compareTo) : null;
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
