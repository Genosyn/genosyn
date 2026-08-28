import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AutonomyWaiver } from "../db/entities/AutonomyWaiver.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { autonomyOverview, revokeWaiver } from "../services/autonomy.js";

/**
 * Earned autonomy, read side + the human revoke (M53). Reads are
 * member-level: an employee's track record and waivers are how the company
 * understands what it has delegated. Revoking is admin-gated and only ever
 * tightens — it re-arms the gate the waiver switched off.
 *
 * There is deliberately no grant route here: promotions are proposed by the
 * eligibility sweep and land in the ordinary Approvals inbox.
 */
export const autonomyRouter = Router({ mergeParams: true });
autonomyRouter.use(requireAuth);
autonomyRouter.use(requireCompanyMember);
autonomyRouter.use(onRoutePaths(["/autonomy-waivers"], requireCompanyRoleForMutations("admin")));

const employeeParamsSchema = z.object({ cid: z.string().uuid(), eid: z.string().uuid() }).strict();
const waiverParamsSchema = z.object({ cid: z.string().uuid(), wid: z.string().uuid() }).strict();

autonomyRouter.get(
  "/employees/:eid/autonomy",
  validateParams(employeeParamsSchema),
  async (req, res) => {
    const overview = await autonomyOverview(req.params.cid, req.params.eid);
    if (!overview) return res.status(404).json({ error: "Employee not found" });
    res.json({
      stats: overview.stats,
      waivers: overview.waivers.map((w) => ({
        id: w.id,
        kind: w.kind,
        routineId: w.routineId,
        grantedAt: w.grantedAt.toISOString(),
        grantedByUserId: w.grantedByUserId,
        evidence: w.evidence,
        revokedAt: w.revokedAt?.toISOString() ?? null,
        revokedReason: w.revokedReason,
      })),
    });
  },
);

autonomyRouter.delete(
  "/autonomy-waivers/:wid",
  validateParams(waiverParamsSchema),
  async (req, res) => {
    const waiver = await AppDataSource.getRepository(AutonomyWaiver).findOneBy({
      id: req.params.wid,
      companyId: req.params.cid,
    });
    if (!waiver) return res.status(404).json({ error: "Waiver not found" });
    if (waiver.revokedAt) return res.status(409).json({ error: "Waiver already revoked" });
    await revokeWaiver(waiver, "Revoked by a human from the employee page", req.userId ?? null);
    res.json({ ok: true });
  },
);
