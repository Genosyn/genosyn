import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import multer from "multer";
import { AppDataSource } from "../db/datasource.js";
import { CustomerContract } from "../db/entities/CustomerContract.js";
import { Company } from "../db/entities/Company.js";
import { companyDir, ensureDir } from "./paths.js";

/**
 * File-upload layer for signed customer contracts (the Customers section).
 *
 * Bytes land on disk under
 * `data/companies/<slug>/customer-contracts/<uuid>.<ext>`; the sqlite row
 * (CustomerContract) carries only metadata + a storage key so large binaries
 * never bloat the DB. Shaped to mirror services/baseRecordUploads.ts so the
 * patterns line up.
 */

export const CONTRACTS_MAX_BYTES = 25 * 1024 * 1024;

function contractsRoot(companySlug: string): string {
  const dir = path.join(companyDir(companySlug), "customer-contracts");
  ensureDir(dir);
  return dir;
}

function safeExt(filename: string): string {
  const e = path.extname(filename).toLowerCase();
  if (!e || e.length > 10) return "";
  if (!/^\.[a-z0-9]+$/.test(e)) return "";
  return e;
}

/**
 * Multer middleware: single-file upload under field name `file`, capped at
 * 25 MB. The route handler is expected to set `req.company` before multer
 * runs so we know which company's dir to write into.
 */
export const contractUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      try {
        const company = (req as unknown as { company?: Company }).company;
        if (!company) {
          cb(new Error("Company context missing on upload"), "");
          return;
        }
        cb(null, contractsRoot(company.slug));
      } catch (err) {
        cb(err as Error, "");
      }
    },
    filename: (_req, file, cb) => {
      const ext = safeExt(file.originalname);
      const id = crypto.randomUUID();
      cb(null, `${id}${ext}`);
    },
  }),
  limits: {
    fileSize: CONTRACTS_MAX_BYTES,
    files: 1,
  },
});

export async function recordContract(params: {
  companyId: string;
  customerId: string | null;
  title: string;
  signedAt: Date | null;
  notes: string;
  file: Express.Multer.File;
  uploadedByUserId: string;
}): Promise<CustomerContract> {
  const repo = AppDataSource.getRepository(CustomerContract);
  const row = repo.create({
    companyId: params.companyId,
    customerId: params.customerId,
    title: params.title || params.file.originalname,
    filename: params.file.originalname,
    mimeType: params.file.mimetype || "application/octet-stream",
    sizeBytes: params.file.size,
    storageKey: path.basename(params.file.path),
    signedAt: params.signedAt,
    notes: params.notes,
    uploadedByUserId: params.uploadedByUserId,
  });
  await repo.save(row);
  return row;
}

/**
 * Resolve a contract id → absolute path on disk. Guards against path
 * traversal by re-joining from the company's contracts root so an attacker
 * can't smuggle `..` through `storageKey`. Returns null if the file is
 * missing or the row doesn't belong to the requested company.
 */
export async function resolveContractFile(
  contractId: string,
  companyId: string,
): Promise<{ row: CustomerContract; absPath: string; company: Company } | null> {
  const row = await AppDataSource.getRepository(CustomerContract).findOneBy({
    id: contractId,
  });
  if (!row || row.companyId !== companyId) return null;
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return null;

  const root = contractsRoot(company.slug);
  const abs = path.join(root, path.basename(row.storageKey));
  if (!abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return { row, absPath: abs, company };
}

/**
 * Best-effort delete of bytes on disk; the row is removed by the caller. We
 * never throw if the file is already missing — the row delete is the source
 * of truth.
 */
export async function deleteContractBytes(
  row: CustomerContract,
  companySlug: string,
): Promise<void> {
  try {
    const root = contractsRoot(companySlug);
    const abs = path.join(root, path.basename(row.storageKey));
    if (!abs.startsWith(root)) return;
    if (fs.existsSync(abs)) await fs.promises.unlink(abs);
  } catch {
    /* noop */
  }
}
