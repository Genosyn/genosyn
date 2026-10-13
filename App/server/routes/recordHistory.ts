import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateParams, validateQuery } from "../middleware/validate.js";
import { canReadRecordHistory, listRecordHistory } from "../services/recordHistory.js";

/**
 * One record's History — who changed it, and when. Member-readable behind the
 * record's own read bar, unlike the whole-company `GET /audit`; see
 * `services/recordHistory.ts` for why the two are separate.
 */
export const recordHistoryRouter = Router({ mergeParams: true });

const paramsSchema = z
  .object({
    cid: z.string().min(1),
    targetType: z.string().regex(/^[a-z_]{1,48}$/),
    targetId: z.string().min(1).max(80),
  })
  .strict();

const querySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().datetime().optional(),
  })
  .strict();

recordHistoryRouter.get(
  "/history/:targetType/:targetId",
  // Bound to the route rather than `.use()`d: this router shares the
  // `/api/companies/:cid` mount, and an unscoped guard would run for every
  // sibling's requests too (see `onRoutePaths` in `middleware/auth.ts`).
  requireAuth,
  requireCompanyMember,
  validateParams(paramsSchema),
  validateQuery(querySchema),
  async (req, res) => {
    const { cid, targetType, targetId } = req.params as z.infer<typeof paramsSchema>;
    const q = req.query as unknown as z.infer<typeof querySchema>;
    const allowed = await canReadRecordHistory(cid, targetType, targetId, {
      userId: req.userId!,
      role: req.companyRole,
      financeAccess: req.membership?.financeAccess,
    });
    // 404 rather than 403: a type without a History and a record the viewer
    // cannot open look the same from outside.
    if (!allowed) return res.status(404).json({ error: "No history for that record" });
    res.json(await listRecordHistory({ companyId: cid, targetType, targetId, ...q }));
  },
);
