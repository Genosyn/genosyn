import { Router } from "express";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { runRoutine } from "../services/runner.js";
import { recordAudit } from "../services/audit.js";

/**
 * Human-in-the-loop inbox. Cron ticks for routines marked `requiresApproval`
 * land here as `pending`. A human approves (→ we actually run the routine
 * now, from the approval handler) or rejects (→ nothing runs, request is
 * stamped).
 */
export const approvalsRouter = Router({ mergeParams: true });
approvalsRouter.use(requireAuth);
approvalsRouter.use(requireCompanyMember);

approvalsRouter.get("/approvals", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const approvals = await AppDataSource.getRepository(Approval).find({
    where: { companyId: cid },
    order: { requestedAt: "DESC" },
    take: 200,
  });
  // Hydrate with routine + employee labels so the inbox renders without
  // another round-trip per row.
  const routineIds = [...new Set(approvals.map((a) => a.routineId))];
  const empIds = [...new Set(approvals.map((a) => a.employeeId))];
  const routines = routineIds.length
    ? await AppDataSource.getRepository(Routine).find({
        where: { id: In(routineIds) },
      })
    : [];
  const emps = empIds.length
    ? await AppDataSource.getRepository(AIEmployee).find({
        where: { id: In(empIds) },
      })
    : [];
  const rById = new Map(routines.map((r) => [r.id, r]));
  const eById = new Map(emps.map((e) => [e.id, e]));
  res.json(
    approvals.map((a) => {
      const r = rById.get(a.routineId) ?? null;
      const e = eById.get(a.employeeId) ?? null;
      return {
        ...a,
        routine: r ? { id: r.id, name: r.name, slug: r.slug } : null,
        employee: e ? { id: e.id, name: e.name, slug: e.slug } : null,
      };
    }),
  );
});

async function loadApproval(cid: string, id: string) {
  const a = await AppDataSource.getRepository(Approval).findOneBy({ id });
  if (!a || a.companyId !== cid) return null;
  return a;
}

approvalsRouter.post("/approvals/:id/approve", async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  const approval = await loadApproval(cid, id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  if (approval.status !== "pending") {
    return res.status(409).json({ error: `Approval already ${approval.status}` });
  }
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: approval.routineId,
  });
  if (!routine) return res.status(404).json({ error: "Routine no longer exists" });
  approval.status = "approved";
  approval.decidedAt = new Date();
  approval.decidedByUserId = req.session?.userId ?? null;
  await AppDataSource.getRepository(Approval).save(approval);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "approval.approve",
    targetType: "approval",
    targetId: approval.id,
    targetLabel: routine.name,
    metadata: { routineId: routine.id },
  });
  // Fire the routine. We don't await the run here so the UI responds fast;
  // the runner persists progress to the Run table regardless.
  runRoutine(routine).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[approvals] routine ${routine.id} failed post-approval:`, err);
  });
  res.json(approval);
});

approvalsRouter.post("/approvals/:id/reject", async (req, res) => {
  const { cid, id } = req.params as Record<string, string>;
  const approval = await loadApproval(cid, id);
  if (!approval) return res.status(404).json({ error: "Not found" });
  if (approval.status !== "pending") {
    return res.status(409).json({ error: `Approval already ${approval.status}` });
  }
  approval.status = "rejected";
  approval.decidedAt = new Date();
  approval.decidedByUserId = req.session?.userId ?? null;
  await AppDataSource.getRepository(Approval).save(approval);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "approval.reject",
    targetType: "approval",
    targetId: approval.id,
    targetLabel: "",
    metadata: { routineId: approval.routineId },
  });
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: approval.routineId,
  });
  if (routine) {
    await AppDataSource.getRepository(JournalEntry).save(
      AppDataSource.getRepository(JournalEntry).create({
        employeeId: approval.employeeId,
        kind: "system",
        title: `Approval rejected for routine "${routine.name}"`,
        body: "No run was performed.",
        routineId: routine.id,
        runId: null,
        authorUserId: approval.decidedByUserId,
      }),
    );
  }
  res.json(approval);
});
