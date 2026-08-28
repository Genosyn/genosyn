import { Router } from "express";
import { z } from "zod";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody, validateParams } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { dismissLesson, listLessonsForRoutine } from "../services/runLessons.js";
import {
  RevisionError,
  applyRevisionProposal,
  getRevisionProposal,
  listRevisionProposals,
  rejectRevisionProposal,
  serializeRevisionProposal,
} from "../services/revisionProposals.js";

/**
 * The improvement loop's HTTP surface (M52): Lessons on a Routine, and the
 * Revision-proposal review queue. Reads are member-level — a Lesson and a
 * proposed diff are things any Member may see beside the Routine and employee
 * pages they already read. Mutations are admin-gated: dismissing a lesson
 * changes what future Runs are told, and applying a proposal rewrites a Soul,
 * Skill, or Routine — the same class of act as editing one by hand.
 */
export const improvementRouter = Router({ mergeParams: true });
improvementRouter.use(requireAuth);
improvementRouter.use(requireCompanyMember);
improvementRouter.use(
  onRoutePaths(["/run-lessons", "/revision-proposals"], requireCompanyRoleForMutations("admin")),
);

const companyParamsSchema = z.object({ cid: z.string().uuid() }).strict();
const lessonParamsSchema = z.object({ cid: z.string().uuid(), lid: z.string().uuid() }).strict();
const proposalParamsSchema = z.object({ cid: z.string().uuid(), pid: z.string().uuid() }).strict();
const reviewSchema = z.object({ note: z.string().max(2_000).optional() });

improvementRouter.get(
  "/run-lessons/routine/:rid",
  validateParams(z.object({ cid: z.string().uuid(), rid: z.string().uuid() }).strict()),
  async (req, res) => {
    const lessons = await listLessonsForRoutine(req.params.cid, req.params.rid);
    res.json(
      lessons.map((lesson) => ({
        id: lesson.id,
        routineId: lesson.routineId,
        runId: lesson.runId,
        cause: lesson.cause,
        advice: lesson.advice,
        dismissedAt: lesson.dismissedAt?.toISOString() ?? null,
        createdAt: lesson.createdAt.toISOString(),
      })),
    );
  },
);

improvementRouter.post(
  "/run-lessons/:lid/dismiss",
  validateParams(lessonParamsSchema),
  async (req, res) => {
    const lesson = await dismissLesson(req.params.cid, req.params.lid);
    if (!lesson) return res.status(404).json({ error: "Lesson not found" });
    await recordAudit({
      companyId: req.params.cid,
      actorUserId: req.userId ?? null,
      action: "lesson.dismiss",
      targetType: "run_lesson",
      targetId: lesson.id,
      targetLabel: lesson.advice.slice(0, 80),
    });
    res.json({ ok: true });
  },
);

improvementRouter.get(
  "/revision-proposals",
  validateParams(companyParamsSchema),
  async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !["pending", "applied", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Unknown status filter" });
    }
    const rows = await listRevisionProposals(req.params.cid, {
      status: status as "pending" | "applied" | "rejected" | undefined,
    });
    res.json(rows.map(serializeRevisionProposal));
  },
);

improvementRouter.get(
  "/revision-proposals/:pid",
  validateParams(proposalParamsSchema),
  async (req, res) => {
    const proposal = await getRevisionProposal(req.params.cid, req.params.pid);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    res.json(serializeRevisionProposal(proposal));
  },
);

improvementRouter.post(
  "/revision-proposals/:pid/apply",
  validateParams(proposalParamsSchema),
  validateBody(reviewSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof reviewSchema>;
    const proposal = await getRevisionProposal(req.params.cid, req.params.pid);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    try {
      const applied = await applyRevisionProposal(proposal, {
        userId: req.userId ?? null,
        note: body.note ?? null,
      });
      res.json(serializeRevisionProposal(applied));
    } catch (err) {
      if (!(err instanceof RevisionError)) throw err;
      res.status(400).json({ error: err.message });
    }
  },
);

improvementRouter.post(
  "/revision-proposals/:pid/reject",
  validateParams(proposalParamsSchema),
  validateBody(reviewSchema),
  async (req, res) => {
    const body = req.body as z.infer<typeof reviewSchema>;
    const proposal = await getRevisionProposal(req.params.cid, req.params.pid);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    try {
      const rejected = await rejectRevisionProposal(proposal, {
        userId: req.userId ?? null,
        note: body.note ?? null,
      });
      res.json(serializeRevisionProposal(rejected));
    } catch (err) {
      if (!(err instanceof RevisionError)) throw err;
      res.status(400).json({ error: err.message });
    }
  },
);
