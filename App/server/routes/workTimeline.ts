import { Request, Router } from "express";
import { z } from "zod";
import { Role } from "../db/entities/Membership.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import {
  getEmployeeWorkTimeline,
  WORK_TIMELINE_DEFAULT_LIMIT,
  WORK_TIMELINE_WINDOW_HOURS,
} from "../services/employeeWorkTimeline.js";

/**
 * The AI Employee **work timeline** behind the Home panel — what one employee,
 * or the whole roster, did inside a window. See `services/employeeWorkTimeline.ts`
 * for the shape and for which tables it unions.
 *
 * ## Why this reads `audit_events` on its own path
 *
 * `routes/audit.ts` is admin-gated *and* behind the `auditLog` entitlement
 * (Scale plan / Enterprise licence), and this endpoint deliberately is neither.
 * Browsing the company's whole history — every actor, every action, unbounded
 * back in time, with the raw metadata blob — is an investigation tool, and
 * charging for it is a defensible product line. Seeing what your own AI
 * employees did today is not that: it is the minimum a company needs to trust
 * a workforce it is being asked to leave unattended, and a Community install
 * that can see "the routine completed" but not "and here is what it changed"
 * is back in the position M58 exists to end.
 *
 * The precedent is exact. `routes/routineChecks.ts` exempts one Run's own
 * effects from the same entitlement on the same argument. This is that
 * argument at the employee's scope, and the window keeps it honest: one
 * employee at a time, a bounded number of hours, no metadata JSON, no action
 * filter, no paging into history. Anyone who wants the investigation tool
 * still buys the audit log.
 */
export const workTimelineRouter = Router({ mergeParams: true });
workTimelineRouter.use(requireAuth);
workTimelineRouter.use(requireCompanyMember);

const workTimelineQuerySchema = z
  .object({
    /** Narrow to one employee. Absent means the whole roster. */
    employeeId: z.string().uuid().optional(),
    /**
     * Window size. 24 is the product promise; the ceiling leaves room for a
     * week without letting a caller ask for the whole history through a route
     * that is deliberately not the audit log.
     */
    hours: z.coerce.number().int().min(1).max(168).default(WORK_TIMELINE_WINDOW_HOURS),
    limit: z.coerce.number().int().min(1).max(200).default(WORK_TIMELINE_DEFAULT_LIMIT),
  })
  .strict();

workTimelineRouter.get(
  "/work-timeline",
  validateQuery(workTimelineQuerySchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const q = req.query as unknown as z.infer<typeof workTimelineQuerySchema>;
    res.json(
      await getEmployeeWorkTimeline({
        companyId: cid,
        userId: req.userId!,
        // `requireCompanyMember` stamped `role` after proving the membership.
        role: (req as Request & { role: Role }).role,
        employeeId: q.employeeId,
        hours: q.hours,
        limit: q.limit,
      }),
    );
  },
);
