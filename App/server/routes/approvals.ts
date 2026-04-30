import { Router } from "express";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import {
  executeApproval,
  recordApprovalRejection,
} from "../services/approvals.js";

/**
 * Human-in-the-loop inbox. Two kinds today:
 *
 *   * `routine` — cron tick for a routine marked `requiresApproval`
 *   * `lightning_payment` — Lightning payment over the Connection's
 *                            `requireApprovalAboveSats` threshold
 *
 * Approve dispatches to the right execute path in `services/approvals.ts`;
 * reject only stamps the row + writes a journal entry.
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

  // Routine kind needs the routine name; both kinds need the employee
  // name. Hydrate in two batched queries so the inbox renders without
  // an N+1 round-trip.
  const routineIds = [
    ...new Set(
      approvals
        .filter((a) => a.kind === "routine" && a.routineId)
        .map((a) => a.routineId),
    ),
  ];
  const empIds = [...new Set(approvals.map((a) => a.employeeId).filter(Boolean))];
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
      const r = a.routineId ? (rById.get(a.routineId) ?? null) : null;
      const e = a.employeeId ? (eById.get(a.employeeId) ?? null) : null;
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
    targetLabel: approval.title ?? "",
    metadata: {
      kind: approval.kind,
      routineId: approval.routineId || undefined,
    },
  });

  // Execute the side-effect. For routines this fires-and-forgets; for
  // payments the await blocks long enough for relay round-trips so the
  // UI sees the outcome on the response.
  try {
    await executeApproval(approval);
  } catch (err) {
    approval.errorMessage = err instanceof Error ? err.message : String(err);
    await AppDataSource.getRepository(Approval).save(approval);
    return res.status(500).json({
      ...approval,
      executeError: approval.errorMessage,
    });
  }

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
    targetLabel: approval.title ?? "",
    metadata: {
      kind: approval.kind,
      routineId: approval.routineId || undefined,
    },
  });

  await recordApprovalRejection(approval);
  res.json(approval);
});
