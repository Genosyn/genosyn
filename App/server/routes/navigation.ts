import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { countWaitingElsewhere } from "../services/navigation.js";
import type { WaitingElsewhere } from "../../shared/navigation.js";

/**
 * What waits on the viewer in the queues the Decision stack links to. A cheap
 * read; see `services/navigation.ts`.
 */
export const navigationRouter = Router({ mergeParams: true });
navigationRouter.use(requireAuth);
navigationRouter.use(requireCompanyMember);

const paramsSchema = z.object({ cid: z.string().uuid() });

navigationRouter.get("/navigation/waiting", validateParams(paramsSchema), async (req, res) => {
  const body: WaitingElsewhere = await countWaitingElsewhere({
    companyId: req.params.cid,
    userId: req.userId!,
    role: req.companyRole ?? "member",
    financeAccess: req.membership?.financeAccess,
  });
  res.json(body);
});
