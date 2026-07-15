import { Request, Router } from "express";
import { Role } from "../db/entities/Membership.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { getHomeData } from "../services/home.js";

/**
 * Home page aggregation — everything the signed-in member might need to
 * act on, in one round-trip. See `services/home.ts` for the shape.
 */
export const homeRouter = Router({ mergeParams: true });
homeRouter.use(requireAuth);
homeRouter.use(requireCompanyMember);

homeRouter.get("/home", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  // `requireCompanyMember` stamped `role` after proving the membership, so
  // reading it back is a pure re-shaping — no DB hit.
  res.json(
    await getHomeData({
      companyId: cid,
      userId: req.userId!,
      role: (req as Request & { role: Role }).role,
    }),
  );
});
