import { Router } from "express";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Run } from "../db/entities/Run.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";

/**
 * Compute-time + run-count rollups. We don't have provider-emitted token/cost
 * metadata yet (the CLIs don't surface it in a stable way), so V1 reports what
 * we can measure reliably: number of runs and wall-clock duration. The UI
 * calls this out so operators know what's missing.
 *
 * Returns per-window totals plus per-employee and per-routine breakdowns so
 * the Usage page can render a dashboard from a single round-trip.
 */
export const usageRouter = Router({ mergeParams: true });
usageRouter.use(requireAuth);
usageRouter.use(requireCompanyMember);

type RunBucket = {
  runs: number;
  completed: number;
  failed: number;
  skipped: number;
  timeout: number;
  durationMs: number;
};

function emptyBucket(): RunBucket {
  return { runs: 0, completed: 0, failed: 0, skipped: 0, timeout: 0, durationMs: 0 };
}

function accumulate(b: RunBucket, run: Run): void {
  b.runs += 1;
  if (run.status === "completed") b.completed += 1;
  else if (run.status === "failed") b.failed += 1;
  else if (run.status === "skipped") b.skipped += 1;
  else if (run.status === "timeout") b.timeout += 1;
  if (run.finishedAt && run.startedAt) {
    const ms = run.finishedAt.getTime() - run.startedAt.getTime();
    if (ms > 0) b.durationMs += ms;
  }
}

usageRouter.get("/usage", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const windowDays = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30));

  // Scope: all routines in the company → their runs since (now - windowDays).
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: cid },
  });
  const empById = new Map(emps.map((e) => [e.id, e]));
  if (emps.length === 0) {
    return res.json({
      windowDays,
      totals: emptyBucket(),
      byEmployee: [],
      byRoutine: [],
    });
  }
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: In(emps.map((e) => e.id)) },
  });
  const routineById = new Map(routines.map((r) => [r.id, r]));
  if (routines.length === 0) {
    return res.json({
      windowDays,
      totals: emptyBucket(),
      byEmployee: emps.map((e) => ({
        employeeId: e.id,
        name: e.name,
        slug: e.slug,
        ...emptyBucket(),
      })),
      byRoutine: [],
    });
  }

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const runs = await AppDataSource.getRepository(Run)
    .createQueryBuilder("run")
    .where("run.routineId IN (:...ids)", { ids: routines.map((r) => r.id) })
    .andWhere("run.startedAt >= :since", { since })
    .getMany();

  const totals = emptyBucket();
  const byEmployee = new Map<string, RunBucket>();
  const byRoutine = new Map<string, RunBucket>();
  for (const e of emps) byEmployee.set(e.id, emptyBucket());
  for (const r of routines) byRoutine.set(r.id, emptyBucket());

  for (const run of runs) {
    accumulate(totals, run);
    const routine = routineById.get(run.routineId);
    if (!routine) continue;
    accumulate(byRoutine.get(run.routineId)!, run);
    const empBucket = byEmployee.get(routine.employeeId);
    if (empBucket) accumulate(empBucket, run);
  }

  res.json({
    windowDays,
    totals,
    byEmployee: emps
      .map((e) => ({
        employeeId: e.id,
        name: e.name,
        slug: e.slug,
        ...byEmployee.get(e.id)!,
      }))
      .sort((a, b) => b.runs - a.runs),
    byRoutine: routines
      .map((r) => {
        const emp = empById.get(r.employeeId);
        return {
          routineId: r.id,
          name: r.name,
          slug: r.slug,
          employeeId: r.employeeId,
          employeeName: emp?.name ?? "",
          employeeSlug: emp?.slug ?? "",
          ...byRoutine.get(r.id)!,
        };
      })
      .sort((a, b) => b.runs - a.runs),
  });
});
