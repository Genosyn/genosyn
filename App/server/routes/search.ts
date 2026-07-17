import { Request, Router } from "express";
import { z } from "zod";
import { Role } from "../db/entities/Membership.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { searchCompany } from "../services/search.js";

/**
 * Company-wide quick search, powering the ⌘K palette's entity results.
 * One endpoint, names-only matching, capped output — see services/search.ts
 * for what is searched and why.
 */

const searchQuerySchema = z.object({
  q: z.string().max(200).default(""),
});

export const searchRouter = Router({ mergeParams: true });
searchRouter.use(requireAuth);
searchRouter.use(requireCompanyMember);

searchRouter.get("/search", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "ValidationError", issues: parsed.error.issues });
  }
  const results = await searchCompany({
    companyId: cid,
    userId: req.userId!,
    role: (req as Request & { role: Role }).role,
    query: parsed.data.q,
  });
  res.json({ results });
});
