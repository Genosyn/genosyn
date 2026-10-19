import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { RevenueDuplicateCandidate } from "../db/entities/RevenueDuplicateCandidate.js";
import { requireFinanceRead, requireFinanceWrite } from "../middleware/financeAccess.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { loadCustomerBySlug } from "../services/finance.js";
import {
  mergeRevenueAccounts,
  previewRevenueAccountMerge,
} from "../services/revenue/accounts.js";
import { dismissRevenueDuplicateCandidate } from "../services/revenue/duplicates.js";

/**
 * Merging duplicate customers, from the Customers pages.
 *
 * A Customer and a Revenue Account are one row, and Revenue's account merge
 * (`mergeRevenueAccounts`) does the work in one transaction: every contact,
 * deal, activity, contract, invoice, estimate, recurring invoice and credit
 * moves to the customer that stays; issued document numbers keep their public
 * identity; the duplicate's name and domain become aliases, so mail and
 * imports still find the survivor; and the duplicate is archived, not
 * deleted, so the merge can be undone. These routes are that merge behind the
 * Customers pages' own bar. Reading a preview, or the duplicates Revenue's
 * scan found, needs read finance access; merging or dismissing one needs
 * full, like every other change made from Customers.
 */
export const customerMergeRouter = Router({ mergeParams: true });

/** How many likely duplicates one customer's page lists, strongest first. */
export const CUSTOMER_DUPLICATES_SHOWN = 5;

function companyOf(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

type CustomerSummary = Pick<Customer, "id" | "slug" | "name" | "domain" | "email">;

function summary({ id, slug, name, domain, email }: Customer): CustomerSummary {
  return { id, slug, name, domain, email };
}

/** The merge service's refusals read as sentences; a missing record is the 404. */
function mergeRefused(res: Response, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(message.endsWith("not found") ? 404 : 409).json({ error: message });
}

const mergePreviewQuery = z.object({ targetCustomerId: z.string().uuid() }).strict();

customerMergeRouter.get(
  "/customers/:slug/merge-preview",
  requireFinanceRead,
  validateQuery(mergePreviewQuery),
  async (req, res) => {
    const cid = companyOf(req);
    const source = await loadCustomerBySlug(cid, req.params.slug);
    if (!source) return res.status(404).json({ error: "Customer not found" });
    const { targetCustomerId } = req.query as unknown as z.infer<typeof mergePreviewQuery>;
    try {
      return res.json(await previewRevenueAccountMerge(cid, source.id, targetCustomerId));
    } catch (error) {
      return mergeRefused(res, error);
    }
  },
);

const mergeBody = z
  .object({
    targetCustomerId: z.string().uuid(),
    /** The duplicate's name, typed again: the merge archives it. */
    confirmSourceName: z.string().min(1).max(120),
    resolutions: z.record(z.enum(["source", "target"])).default({}),
  })
  .strict();

customerMergeRouter.post(
  "/customers/:slug/merge",
  requireFinanceWrite,
  validateBody(mergeBody),
  async (req, res) => {
    const cid = companyOf(req);
    const source = await loadCustomerBySlug(cid, req.params.slug);
    if (!source) return res.status(404).json({ error: "Customer not found" });
    const body = req.body as z.infer<typeof mergeBody>;
    let result: Awaited<ReturnType<typeof mergeRevenueAccounts>>;
    try {
      result = await mergeRevenueAccounts(
        cid,
        source.id,
        body.targetCustomerId,
        body.confirmSourceName,
        { userId: req.userId ?? null },
        body.resolutions,
      );
    } catch (error) {
      return mergeRefused(res, error);
    }
    // Both customers' History says it: the duplicate's, where an old link
    // lands, and the survivor's, which is the page people keep using.
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "finance.customer.merge",
      targetType: "customer",
      targetId: result.source.id,
      targetLabel: `${result.source.name} → ${result.target.name}`,
      metadata: { targetCustomerId: result.target.id, moved: result.counts },
    });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "finance.customer.merge",
      targetType: "customer",
      targetId: result.target.id,
      targetLabel: result.target.name,
      metadata: { mergedFrom: result.source.name },
    });
    return res.json(result);
  },
);

type DuplicateReason = { kind: string; value?: string; score: number };

function reasonsOf(row: RevenueDuplicateCandidate): DuplicateReason[] {
  try {
    const parsed = JSON.parse(row.reasonsJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (reason): reason is DuplicateReason =>
            !!reason && typeof (reason as DuplicateReason).kind === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * The active customers Revenue's duplicate scan pairs with this one and nobody
 * has dismissed yet, strongest match first. The scan runs on its own schedule,
 * so a duplicate made a minute ago shows up after the next one.
 */
customerMergeRouter.get("/customers/:slug/duplicates", requireFinanceRead, async (req, res) => {
  const cid = companyOf(req);
  const customer = await loadCustomerBySlug(cid, req.params.slug);
  if (!customer) return res.status(404).json({ error: "Customer not found" });
  if (customer.archivedAt) return res.json([]);
  const open = { companyId: cid, resourceType: "account" as const, status: "open" as const };
  const candidates = await AppDataSource.getRepository(RevenueDuplicateCandidate).find({
    where: [
      { ...open, leftId: customer.id },
      { ...open, rightId: customer.id },
    ],
    order: { score: "DESC", detectedAt: "DESC" },
  });
  const otherOf = (row: RevenueDuplicateCandidate) =>
    row.leftId === customer.id ? row.rightId : row.leftId;
  const others = candidates.length
    ? await AppDataSource.getRepository(Customer).findBy({
        companyId: cid,
        id: In(candidates.map(otherOf)),
        archivedAt: IsNull(),
      })
    : [];
  const byId = new Map(others.map((row) => [row.id, row]));
  return res.json(
    candidates
      .flatMap((row) => {
        const other = byId.get(otherOf(row));
        return other
          ? [{ id: row.id, score: row.score, reasons: reasonsOf(row), customer: summary(other) }]
          : [];
      })
      .slice(0, CUSTOMER_DUPLICATES_SHOWN),
  );
});

customerMergeRouter.post(
  "/customers/:slug/duplicates/:candidateId/dismiss",
  requireFinanceWrite,
  async (req, res) => {
    const cid = companyOf(req);
    const candidateId = z.string().uuid().safeParse(req.params.candidateId);
    if (!candidateId.success) return res.status(404).json({ error: "Duplicate not found" });
    const customer = await loadCustomerBySlug(cid, req.params.slug);
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const candidate = await AppDataSource.getRepository(RevenueDuplicateCandidate).findOneBy({
      companyId: cid,
      id: candidateId.data,
      resourceType: "account",
    });
    // Only a pair this customer is part of can be dismissed from its page.
    if (!candidate || (candidate.leftId !== customer.id && candidate.rightId !== customer.id)) {
      return res.status(404).json({ error: "Duplicate not found" });
    }
    try {
      const row = await dismissRevenueDuplicateCandidate(cid, candidate.id, req.userId ?? null);
      if (!row) return res.status(404).json({ error: "Duplicate not found" });
      // Revenue's Data quality dismisses the same pair in the same words.
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "revenue.duplicate.dismiss",
        targetType: "revenue_duplicate_candidate",
        targetId: row.id,
        targetLabel: row.resourceType,
      });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  },
);
