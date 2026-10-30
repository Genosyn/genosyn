import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateParams, validateQuery } from "../middleware/validate.js";
import { CURSOR_MAX_LENGTH, ListQueryError } from "../services/listPaging.js";
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
    cursor: z
      .string()
      .min(1)
      .max(CURSOR_MAX_LENGTH)
      .optional()
      .describe(
        "nextCursor from the previous page. It names the oldest change shown, so changes made in the same instant are neither skipped nor repeated; a bare timestamp from an older page still reads on from that instant.",
      ),
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
  async (req, res, next) => {
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
    try {
      res.json(await listRecordHistory({ companyId: cid, targetType, targetId, ...q }));
    } catch (err) {
      if (err instanceof ListQueryError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);
