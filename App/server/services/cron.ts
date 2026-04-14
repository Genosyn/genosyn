import cron, { ScheduledTask } from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { Routine } from "../db/entities/Routine.js";
import { runRoutine } from "./runner.js";

const tasks = new Map<string, ScheduledTask>();

export function registerRoutine(routine: Routine): void {
  unregisterRoutine(routine.id);
  if (!routine.enabled) return;
  if (!cron.validate(routine.cronExpr)) {
    // eslint-disable-next-line no-console
    console.warn(`[cron] invalid expression for routine ${routine.id}: ${routine.cronExpr}`);
    return;
  }
  const task = cron.schedule(routine.cronExpr, () => {
    runRoutine(routine).catch((err) => {
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
