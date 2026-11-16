import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember, usesBearerCredential } from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { countAttention, countWaitingElsewhere } from "../services/navigation.js";
import type { NavigationAttention, WaitingElsewhere } from "../../shared/navigation.js";

/**
 * What waits on the viewer: in the queues the Decision stack links to, and in
 * total for the app sidebar. Cheap reads; see `services/navigation.ts`.
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

navigationRouter.get("/navigation/attention", validateParams(paramsSchema), async (req, res) => {
  const body: NavigationAttention = await countAttention({
    companyId: req.params.cid,
    userId: req.userId!,
    role: req.companyRole ?? "member",
    financeAccess: req.membership?.financeAccess,
    canReadReviews: !usesBearerCredential(req),
  });
  res.json(body);
});
