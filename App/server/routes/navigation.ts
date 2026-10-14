import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateParams } from "../middleware/validate.js";
import { countWaitingElsewhere, listUsedSections } from "../services/navigation.js";
import type { UsedSectionsResponse, WaitingElsewhere } from "../../shared/navigation.js";

/**
 * What the app chrome needs to show less: which sections this company uses
 * (the ⌘K palette lists those beside the core), and what waits on the viewer
 * in the queues the Decision stack links to. Both are cheap reads; see
 * `services/navigation.ts`.
 */
export const navigationRouter = Router({ mergeParams: true });
navigationRouter.use(requireAuth);
navigationRouter.use(requireCompanyMember);

const paramsSchema = z.object({ cid: z.string().uuid() });

navigationRouter.get("/navigation/sections", validateParams(paramsSchema), async (req, res) => {
  const body: UsedSectionsResponse = { used: await listUsedSections(req.params.cid) };
  res.json(body);
});

navigationRouter.get("/navigation/waiting", validateParams(paramsSchema), async (req, res) => {
  const body: WaitingElsewhere = await countWaitingElsewhere({
    companyId: req.params.cid,
    userId: req.userId!,
    role: req.companyRole ?? "member",
    financeAccess: req.membership?.financeAccess,
  });
  res.json(body);
});
