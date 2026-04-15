import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { runRoutine } from "./runner.js";

const tasks = new Map<string, ScheduledTask>();

/**
 * When a cron tick fires for a routine marked `requiresApproval`, we don't
 * run — we insert a pending {@link Approval} and emit a journal entry so
 * the human operator can decide from the Approvals inbox.
 */
async function tickRoutine(routineId: string): Promise<void> {
  // Re-fetch each tick so edits (including flipping requiresApproval or
  // disabling the routine) take effect without restarting the process.
  const repo = AppDataSource.getRepository(Routine);
  const fresh = await repo.findOneBy({ id: routineId });
  if (!fresh || !fresh.enabled) return;
  if (fresh.requiresApproval) {
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: fresh.employeeId,
    });
    if (!emp) return;
    const approvalRepo = AppDataSource.getRepository(Approval);
    const pending = approvalRepo.create({
      companyId: emp.companyId,
      routineId: fresh.id,
      employeeId: emp.id,
      status: "pending",
    });
    await approvalRepo.save(pending);
    await AppDataSource.getRepository(JournalEntry).save(
      AppDataSource.getRepository(JournalEntry).create({
        employeeId: emp.id,
        kind: "system",
        title: `Approval requested for routine "${fresh.name}"`,
        body: "Cron tick was gated; waiting for a human to approve or reject.",
        routineId: fresh.id,
        runId: null,
        authorUserId: null,
      }),
    );
    return;
  }
  await runRoutine(fresh);
}

export function registerRoutine(routine: Routine): void {
  unregisterRoutine(routine.id);
  if (!routine.enabled) return;
  if (!cron.validate(routine.cronExpr)) {
    // eslint-disable-next-line no-console
    console.warn(`[cron] invalid expression for routine ${routine.id}: ${routine.cronExpr}`);
    return;
  }
  const task = cron.schedule(routine.cronExpr, () => {
    tickRoutine(routine.id).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[cron] routine ${routine.id} failed:`, err);
    });
  });
  tasks.set(routine.id, task);
}

export function unregisterRoutine(routineId: string): void {
  const task = tasks.get(routineId);
  if (task) {
    task.stop();
    tasks.delete(routineId);
  }
}

export async function bootCron(): Promise<void> {
  const repo = AppDataSource.getRepository(Routine);
  const routines = await repo.find({ where: { enabled: true } });
  for (const r of routines) registerRoutine(r);
}
