import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import {
  contractUploadMiddleware,
  deleteContractBytes,
  recordContract,
  resolveContractFile,
} from "../services/customerContracts.js";

/**
 * Signed customer contracts — the upload-and-store surface for the Customers
 * section. A contract is an uploaded document optionally linked to a
 * Customer; bytes live on disk (see services/customerContracts.ts) and only
 * metadata sits in the DB.
 *
 * Mounted at `/api/companies/:cid`, so every route is gated by
 * `requireCompanyMember`. Kept in its own router (rather than finance.ts) to
 * match the Customers section it belongs to and keep finance.ts focused.
 */
export const contractsRouter = Router({ mergeParams: true });
contractsRouter.use(requireAuth);
contractsRouter.use(requireCompanyMember);

// Hydrate `req.company` from the URL param — the upload middleware needs the
// slug to compute the on-disk target dir. Mirrors workspace.ts.
contractsRouter.use(async (req, res, next) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return res.status(404).json({ error: "Company not found" });
  (req as unknown as { company: Company }).company = co;
  next();
});

function companyOf(req: { company?: Company }): Company {
  if (!req.company) throw new Error("Company context missing");
  return req.company;
}

type CustomerStub = { id: string; name: string; slug: string } | null;

/** Serialize a row for the client: coerce the bigint `sizeBytes` to a number
 *  and attach a lightweight customer stub so lists render without an extra
 *  request per row. */
function serializeContract(
  row: CustomerContract,
  customer: CustomerStub,
): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.companyId,
    customerId: row.customerId,
    title: row.title,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    signedAt: row.signedAt,
    notes: row.notes,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    customer,
  };
}

async function customerStubsFor(
  companyId: string,
  rows: CustomerContract[],
): Promise<Map<string, CustomerStub>> {
  const ids = [...new Set(rows.map((r) => r.customerId).filter((x): x is string => !!x))];
  const out = new Map<string, CustomerStub>();
  if (ids.length === 0) return out;
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { companyId, id: In(ids) },
  });
  for (const c of customers) out.set(c.id, { id: c.id, name: c.name, slug: c.slug });
  return out;
}

// List — newest first. Optional `?customerId=` filter powers the per-customer
// view; omit it for the global "all contracts" page.
contractsRouter.get("/contracts", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const where: Record<string, unknown> = { companyId: cid };
  const customerId = req.query.customerId;
  if (typeof customerId === "string" && customerId) where.customerId = customerId;
  const rows = await AppDataSource.getRepository(CustomerContract).find({
    where,
    order: { createdAt: "DESC" },
  });
  const stubs = await customerStubsFor(cid, rows);
  res.json(
    rows.map((r) => serializeContract(r, r.customerId ? stubs.get(r.customerId) ?? null : null)),
  );
});

// Text fields that ride alongside the multipart file. Parsed AFTER multer
// runs (multipart bodies aren't available until then), so this validates
// `req.body` by hand rather than via the `validateBody` middleware.
const contractFieldsSchema = z.object({
  title: z.string().max(200).optional(),
  customerId: z.string().uuid().or(z.literal("")).optional(),
  signedAt: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
});

contractsRouter.post(
  "/contracts",
  contractUploadMiddleware.single("file"),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const parsed = contractFieldsSchema.safeParse(req.body);
    if (!parsed.success) {
      // The bytes already landed on disk; drop them so a bad request can't
      // leave an orphan.
      await deleteContractBytes(
        { storageKey: file.filename } as CustomerContract,
        co.slug,
      );
      return res.status(400).json({ error: "Invalid contract fields" });
    }
    const body = parsed.data;

    let customerId: string | null = null;
    if (body.customerId) {
      const customer = await AppDataSource.getRepository(Customer).findOneBy({
        id: body.customerId,
        companyId: co.id,
      });
      if (!customer) {
        await deleteContractBytes(
          { storageKey: file.filename } as CustomerContract,
          co.slug,
        );
        return res.status(400).json({ error: "Invalid customer" });
      }
      customerId = customer.id;
    }

    const signedAt = parseDate(body.signedAt);
    const row = await recordContract({
      companyId: co.id,
      customerId,
      title: (body.title ?? "").trim(),
      signedAt,
      notes: (body.notes ?? "").trim(),
      file,
      uploadedByUserId: req.userId!,
    });
    const stub = customerId
      ? (await customerStubsFor(co.id, [row])).get(customerId) ?? null
      : null;
    res.status(201).json(serializeContract(row, stub));
  },
);

contractsRouter.get("/contracts/:id/file", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const resolved = await resolveContractFile(req.params.id, co.id);
  if (!resolved) return res.status(404).json({ error: "Contract not found" });
  res.setHeader("Content-Type", resolved.row.mimeType);
  const inline =
    resolved.row.mimeType === "application/pdf" ||
    resolved.row.mimeType.startsWith("image/");
  const disposition = inline ? "inline" : "attachment";
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${encodeURIComponent(resolved.row.filename)}"`,
  );
  res.sendFile(resolved.absPath);
});

const contractPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  customerId: z.string().uuid().nullable().optional(),
  signedAt: z.string().max(40).nullable().optional(),
  notes: z.string().max(2000).optional(),
});

contractsRouter.patch(
  "/contracts/:id",
  validateBody(contractPatchSchema),
  async (req, res) => {
    const co = companyOf(req as unknown as { company?: Company });
    const repo = AppDataSource.getRepository(CustomerContract);
    const row = await repo.findOneBy({ id: req.params.id, companyId: co.id });
    if (!row) return res.status(404).json({ error: "Contract not found" });
    const body = req.body as z.infer<typeof contractPatchSchema>;

    if (body.title !== undefined) row.title = body.title;
    if (body.notes !== undefined) row.notes = body.notes;
    if (body.signedAt !== undefined) {
      row.signedAt = body.signedAt ? parseDate(body.signedAt) : null;
    }
    if (body.customerId !== undefined) {
      if (body.customerId === null) {
        row.customerId = null;
      } else {
        const customer = await AppDataSource.getRepository(Customer).findOneBy({
          id: body.customerId,
          companyId: co.id,
        });
        if (!customer) return res.status(400).json({ error: "Invalid customer" });
        row.customerId = customer.id;
      }
    }
    await repo.save(row);
    const stub = row.customerId
      ? (await customerStubsFor(co.id, [row])).get(row.customerId) ?? null
      : null;
    res.json(serializeContract(row, stub));
  },
);

contractsRouter.delete("/contracts/:id", async (req, res) => {
  const co = companyOf(req as unknown as { company?: Company });
  const repo = AppDataSource.getRepository(CustomerContract);
  const row = await repo.findOneBy({ id: req.params.id, companyId: co.id });
  if (!row) return res.status(404).json({ error: "Contract not found" });
  // Reverse order from upload: drop bytes first, then the row. A stray file
  // is harmless; a row pointing at missing bytes is the worse failure mode.
  await deleteContractBytes(row, co.slug);
  await repo.delete({ id: row.id });
  res.json({ ok: true });
});

/** Parse a `YYYY-MM-DD` or ISO date string to a Date, or null when empty /
 *  unparseable. Kept lenient so a sloppy client value never 500s the upload. */
function parseDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
