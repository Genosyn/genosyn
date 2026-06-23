import { Router } from "express";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { getSystemHealthReport } from "../services/systemHealth.js";

/**
 * System Health — a company-scoped roll-up of everything that might be
 * quietly broken (failed routines, stuck runs, missing models, dead
 * integrations, …). Read-only; see `services/systemHealth.ts` for the shape.
 */
export const systemHealthRouter = Router({ mergeParams: true });
systemHealthRouter.use(requireAuth);
systemHealthRouter.use(requireCompanyMember);

systemHealthRouter.get("/system-health", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  res.json(await getSystemHealthReport(cid));
});
