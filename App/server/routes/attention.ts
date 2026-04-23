import { Router } from "express";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { getAttentionForUser } from "../services/attention.js";

/**
 * Summary of "things that need the viewer's attention" for the current
 * company. Drives the notification badges in the top nav — a single poll
 * keeps the client quiet.
 */
export const attentionRouter = Router({ mergeParams: true });
attentionRouter.use(requireAuth);
attentionRouter.use(requireCompanyMember);

attentionRouter.get("/attention", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const summary = await getAttentionForUser({
    companyId: cid,
    userId: req.userId!,
  });
  res.json(summary);
});
