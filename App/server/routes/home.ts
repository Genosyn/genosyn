import { Request, Router } from "express";
import { z } from "zod";
import { Role } from "../db/entities/Membership.js";
import { requireAuth, requireBrowserSession, requireCompanyMember } from "../middleware/auth.js";
import { validateParams, validateQuery } from "../middleware/validate.js";
import { getHomeData } from "../services/home.js";
import { listHomeRepositoryWork } from "../services/homeRepositoryWork.js";

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
      canReadRepositoryWork: !req.apiKey,
      canReadWorkReviews: !req.apiKey,
    }),
  );
});

const repositoryWorkParamsSchema = z.object({ cid: z.string().uuid() });
const repositoryWorkQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(8),
  })
  .strict();

homeRouter.get(
  "/home/repository-work",
  requireBrowserSession,
  validateParams(repositoryWorkParamsSchema),
  validateQuery(repositoryWorkQuerySchema),
  async (req, res) => {
    const { offset, limit } = req.query as unknown as z.infer<typeof repositoryWorkQuerySchema>;
    res.json(await listHomeRepositoryWork({ companyId: req.params.cid, offset, limit }));
  },
);
