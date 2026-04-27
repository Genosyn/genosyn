import { Router } from "express";
import { Brackets } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";

/**
 * Read-only email-delivery log per company. Mounted under
 * `/api/companies/:cid/email/logs`.
 *
 *   GET /          — paged list with filtering by status / purpose / search
 *   GET /:lid      — single row, including the captured body preview
 *
 * Logs are append-only and written by the email service; there is no DELETE.
 * Self-hosters who want to prune can do so via SQL.
 */
export const emailLogsRouter = Router({ mergeParams: true });
emailLogsRouter.use(requireAuth);
emailLogsRouter.use(requireCompanyMember);

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

function parseInteger(v: unknown, def: number, max: number): number {
  if (typeof v !== "string" || !v.trim()) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

function serialize(row: EmailLog): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.companyId,
    providerId: row.providerId,
    transport: row.transport,
    purpose: row.purpose,
    toAddress: row.toAddress,
    fromAddress: row.fromAddress,
    subject: row.subject,
    bodyPreview: row.bodyPreview,
    status: row.status,
    errorMessage: row.errorMessage,
    messageId: row.messageId,
    triggeredByUserId: row.triggeredByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

emailLogsRouter.get("/", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const limit = parseInteger(req.query.limit, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX);
  const offset = parseInteger(req.query.offset, 0, 100_000);
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const purpose = typeof req.query.purpose === "string" ? req.query.purpose : "";
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  const qb = AppDataSource.getRepository(EmailLog)
    .createQueryBuilder("log")
    .where("log.companyId = :companyId", { companyId: cid });
  if (status) qb.andWhere("log.status = :status", { status });
  if (purpose) qb.andWhere("log.purpose = :purpose", { purpose });
  if (search) {
    const pattern = `%${search}%`;
    qb.andWhere(
      new Brackets((b) => {
        b.where("log.toAddress LIKE :pattern", { pattern })
          .orWhere("log.subject LIKE :pattern", { pattern })
          .orWhere("log.errorMessage LIKE :pattern", { pattern });
      }),
    );
  }
  const total = await qb.clone().getCount();
  const rows = await qb
    .orderBy("log.createdAt", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();
  res.json({
    total,
    limit,
    offset,
    rows: rows.map(serialize),
  });
});

emailLogsRouter.get("/:lid", async (req, res) => {
  const { cid, lid } = req.params as Record<string, string>;
  const row = await AppDataSource.getRepository(EmailLog).findOneBy({
    id: lid,
    companyId: cid,
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(serialize(row));
});
