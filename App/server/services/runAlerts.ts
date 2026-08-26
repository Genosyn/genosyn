import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import type { Run } from "../db/entities/Run.js";
import { createNotifications, type CreateNotificationInput } from "./notifications.js";
import { managingMemberIdForEmployee } from "./reportingLine.js";
import { redactSensitiveText } from "./approvalRedaction.js";

/**
 * Bell + push when scheduled work breaks or misses its bar.
 *
 * Failed Runs used to surface only on the pull-based, dismissible Home panel:
 * a company that believed its AI staff was working could have three Routines
 * silently wedged. These alerts make the two verdicts a human must act on —
 * "the Run broke" and "the Run finished but missed its acceptance criteria" —
 * arrive the way an Approval already does.
 *
 * Audience: the company's owners and admins, plus the Member at the top of the
 * employee's reporting line (who may be neither), deduplicated. Runs with a
 * retry still scheduled stay quiet, mirroring the Home panel: a failure is not
 * actionable until the last attempt has been spent.
 */

async function alertAudience(companyId: string, employeeId: string): Promise<string[]> {
  const [memberships, managerId] = await Promise.all([
    AppDataSource.getRepository(Membership).find({
      where: { companyId, role: In(["owner", "admin"]) },
    }),
    managingMemberIdForEmployee(companyId, employeeId),
  ]);
  const userIds = new Set(memberships.map((m) => m.userId));
  if (managerId) userIds.add(managerId);
  return [...userIds];
}

type RunAlertContext = {
  run: Run;
  routine: Routine;
  employee: AIEmployee;
  company: Company;
  userIds: string[];
};

async function loadContext(run: Run): Promise<RunAlertContext | null> {
  const routine = await AppDataSource.getRepository(Routine).findOneBy({ id: run.routineId });
  if (!routine) return null;
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: routine.employeeId,
  });
  if (!employee) return null;
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: employee.companyId });
  if (!company) return null;
  const userIds = await alertAudience(company.id, employee.id);
  if (userIds.length === 0) return null;
  return { run, routine, employee, company, userIds };
}

function runLink(ctx: RunAlertContext): string {
  // Same `?routine=&run=` deep link the Home failed-runs panel uses: the
  // Routines index resolves ids to the right detail page and opens the Run.
  return `/c/${ctx.company.slug}/routines?routine=${ctx.routine.id}&run=${ctx.run.id}`;
}

function notificationInputs(
  ctx: RunAlertContext,
  kind: "run_failed" | "run_off_goal",
  title: string,
  body: string,
): CreateNotificationInput[] {
  return ctx.userIds.map((userId) => ({
    companyId: ctx.company.id,
    userId,
    kind,
    title,
    body,
    link: runLink(ctx),
    actorKind: "ai" as const,
    actorId: ctx.employee.id,
    entityKind: "run" as const,
    entityId: ctx.run.id,
  }));
}

/**
 * A Run reached a terminal `failed` / `timeout` / `interrupted` with no retry
 * still owed. Callers fire-and-forget; a notification outage must never change
 * a Run's verdict, so everything here is best-effort.
 */
export async function notifyRunFailure(run: Run): Promise<void> {
  if (run.retryAt) return;
  const ctx = await loadContext(run);
  if (!ctx) return;
  const verb =
    run.status === "timeout"
      ? "timed out"
      : run.status === "interrupted"
        ? "was interrupted"
        : "failed";
  const attempts =
    run.attempt > 1 ? ` after ${run.attempt} attempts` : "";
  await createNotifications(
    notificationInputs(
      ctx,
      "run_failed",
      `Routine "${ctx.routine.name}" ${verb}`,
      `${ctx.employee.name}'s scheduled run ${verb}${attempts}. Open the Run log to see what happened.`,
    ),
  );
}

/**
 * A Run completed but the outcome check judged it off-goal against the
 * Routine's acceptance criteria. Louder than a journal line on purpose:
 * convincing-but-wrong is the failure mode a green checkmark hides.
 */
export async function notifyRunOffGoal(run: Run, note: string): Promise<void> {
  const ctx = await loadContext(run);
  if (!ctx) return;
  // The note is model-written from an untrusted Run transcript and this copy
  // rides out to bells and push payloads, so it meets the same redaction
  // boundary approval summaries do before it leaves the app.
  const body = note
    ? redactSensitiveText(note)
    : "The Run completed, but its work does not meet the Routine's acceptance criteria.";
  await createNotifications(
    notificationInputs(ctx, "run_off_goal", `Routine "${ctx.routine.name}" finished off-goal`, body),
  );
}
