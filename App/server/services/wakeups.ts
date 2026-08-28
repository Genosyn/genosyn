import { LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { EmployeeWakeup } from "../db/entities/EmployeeWakeup.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Routine } from "../db/entities/Routine.js";
import { chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";
import { recordAudit } from "./audit.js";

/**
 * Wakeups — the timer the wake-source family lacked (M54). Everything here
 * follows the kickoff shape the codebase standardized on four times: a fresh
 * background session under the employee's own authority, briefed with the
 * note its past self left, claimed with a conditional UPDATE so one session
 * starts however many schedulers race, degrading to a journal entry when the
 * employee has no model.
 */

/** A runaway loop of an employee scheduling itself forever is bounded twice:
 * a pending cap, and a horizon past which "check back" is a Routine's job. */
const PENDING_PER_EMPLOYEE_MAX = 20;
const HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

/** Per heartbeat pass — late wakeups drain over a few ticks, oldest first. */
const DISPATCH_PER_SWEEP = 10;

const OUTCOME_CAP = 8_000;

export class WakeupError extends Error {}

export async function scheduleWakeup(args: {
  companyId: string;
  employeeId: string;
  at: Date;
  brief: string;
  sourceRunId?: string | null;
  sourceRoutineId?: string | null;
}): Promise<EmployeeWakeup> {
  const brief = args.brief.trim();
  if (!brief) throw new WakeupError("Leave your future self a note — the brief is the wakeup");
  const now = Date.now();
  if (args.at.getTime() <= now) throw new WakeupError("The wake time must be in the future");
  if (args.at.getTime() > now + HORIZON_MS) {
    throw new WakeupError(
      "Wakeups reach at most 90 days out — for standing work that far ahead, propose a Routine",
    );
  }
  const repo = AppDataSource.getRepository(EmployeeWakeup);
  const pending = await repo.countBy({ employeeId: args.employeeId, status: "pending" });
  if (pending >= PENDING_PER_EMPLOYEE_MAX) {
    throw new WakeupError(
      `You already have ${pending} pending wakeups — cancel one, or fold this into an existing one`,
    );
  }
  return repo.save(
    repo.create({
      companyId: args.companyId,
      employeeId: args.employeeId,
      at: args.at,
      brief: brief.slice(0, 4_000),
      sourceRunId: args.sourceRunId ?? null,
      sourceRoutineId: args.sourceRoutineId ?? null,
    }),
  );
}

/** Cancel a pending wakeup; exactly once, whoever asks first. */
export async function cancelWakeup(
  companyId: string,
  id: string,
  actor: { employeeId?: string | null; userId?: string | null },
): Promise<boolean> {
  const repo = AppDataSource.getRepository(EmployeeWakeup);
  const wakeup = await repo.findOneBy({ id, companyId });
  if (!wakeup) return false;
  // An employee may cancel only its own; a human route passes userId and no
  // employee, and its router owns the role gate.
  if (actor.employeeId && wakeup.employeeId !== actor.employeeId) return false;
  const claim = await repo.update({ id, status: "pending" }, { status: "cancelled" });
  if (claim.affected !== 1) return false;
  await recordAudit({
    companyId,
    actorEmployeeId: actor.employeeId ?? null,
    actorUserId: actor.userId ?? null,
    action: "wakeup.cancel",
    targetType: "wakeup",
    targetId: id,
    targetLabel: wakeup.brief.slice(0, 80),
  });
  return true;
}

export async function listWakeups(
  companyId: string,
  employeeId: string,
): Promise<EmployeeWakeup[]> {
  return AppDataSource.getRepository(EmployeeWakeup).find({
    where: { companyId, employeeId },
    order: { at: "ASC" },
    take: 100,
  });
}

/**
 * The heartbeat pass. Each due wakeup is claimed, then briefed into a fresh
 * session; the session's reply (or why none ran) lands on the row and in the
 * journal, so a wakeup is never a timer that fired into silence.
 */
export async function dispatchDueWakeups(
  now: Date = new Date(),
  runChat: typeof chatWithEmployee = chatWithEmployee,
): Promise<void> {
  const repo = AppDataSource.getRepository(EmployeeWakeup);
  const due = await repo.find({
    where: { status: "pending", at: LessThanOrEqual(now) },
    order: { at: "ASC" },
    take: DISPATCH_PER_SWEEP,
  });
  for (const wakeup of due) {
    const claim = await repo.update(
      { id: wakeup.id, status: "pending" },
      { status: "fired", firedAt: new Date() },
    );
    if (claim.affected !== 1) continue;
    try {
      await fireWakeup(wakeup, runChat);
    } catch (err) {
      await repo.update(
        { id: wakeup.id },
        { outcomeNote: `The wake session failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, OUTCOME_CAP) },
      );
      // eslint-disable-next-line no-console
      console.error(`[wakeups] fire failed for ${wakeup.id}:`, err);
    }
  }
}

async function fireWakeup(
  wakeup: EmployeeWakeup,
  runChat: typeof chatWithEmployee,
): Promise<void> {
  const repo = AppDataSource.getRepository(EmployeeWakeup);
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: wakeup.employeeId,
    companyId: wakeup.companyId,
  });
  if (!employee) {
    await repo.update({ id: wakeup.id }, { outcomeNote: "The employee no longer exists." });
    return;
  }
  if (!(await getActiveModel(employee.id))) {
    // The journal fallback: the note still reaches the employee's next prompt.
    await repo.update(
      { id: wakeup.id },
      { outcomeNote: "No AI Model connected — delivered to the journal instead." },
    );
    await journal(
      employee.id,
      "A wakeup you scheduled is due",
      wakeup.brief,
      wakeup.sourceRoutineId,
    );
    return;
  }
  const result = await runChat(
    wakeup.companyId,
    employee.id,
    await composeWakeBrief(wakeup),
    [],
    { toolAuthority: "employee" },
  );
  const note = result.reply.trim().slice(0, OUTCOME_CAP) || "(no reply)";
  await repo.update({ id: wakeup.id }, { outcomeNote: note });
  await journal(employee.id, `Woke up: ${wakeup.brief.slice(0, 80)}`, note, wakeup.sourceRoutineId);
}

async function composeWakeBrief(wakeup: EmployeeWakeup): Promise<string> {
  const lines = [
    "This session exists because you scheduled it. Your past self left this note:",
    "---",
    wakeup.brief,
    "---",
  ];
  if (wakeup.sourceRoutineId) {
    const routine = await AppDataSource.getRepository(Routine).findOneBy({
      id: wakeup.sourceRoutineId,
    });
    if (routine) lines.push("", `You scheduled it while running your routine "${routine.name}".`);
  }
  lines.push(
    "",
    "Do the follow-up now with your tools — check the thing, chase the thing, finish the thing.",
    "- If it resolved itself, say so briefly and stop.",
    "- If it needs longer, schedule the next wakeup before you finish, and say when.",
    "- Your reply is stored on the wakeup and in your journal, so report what you found.",
  );
  return lines.join("\n");
}

async function journal(
  employeeId: string,
  title: string,
  body: string,
  routineId: string | null,
): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title,
        body: body.slice(0, OUTCOME_CAP),
        runId: null,
        routineId,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[wakeups] journal write failed", err);
  }
}
