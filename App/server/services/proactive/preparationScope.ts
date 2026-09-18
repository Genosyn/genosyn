import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Routine } from "../../db/entities/Routine.js";
import { Workstream } from "../../db/entities/Workstream.js";

type PreparationContext = {
  companyId: string;
  employeeId: string;
  routineId?: string | null;
};

const idSchema = z.string().uuid();

async function keepsPreparationBoundary(context: PreparationContext): Promise<boolean> {
  const parsed = idSchema.safeParse(context.routineId);
  if (!parsed.success) return false;
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: parsed.data,
    employeeId: context.employeeId,
    selfReviewOnly: false,
  });
  // Event/webhook/retry Runs may be preparation-only even though a later
  // scheduled Run of that same Routine has broader authority. Its stateDoc
  // must not become a way to carry restricted work into that later turn.
  return routine?.mailDeliveryMode != null;
}

/** Stored state can carry authority that a field allowlist alone cannot see.
 * Keep preparation away from broader Routine briefs and recurring/reminding
 * follow-ups. Resource Grants and route validation still apply afterward. */
export async function proactivePreparationError(
  context: PreparationContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const workstreamBoundary =
    "Proactive preparation can track an unbound Workstream or this turn's own permanently restricted Routine only. It cannot change a broader Routine's work instructions. Record the finding in an unbound Workstream instead.";
  if (toolName === "create_workstream") {
    if (
      args.routineId !== undefined &&
      (args.routineId !== context.routineId || !(await keepsPreparationBoundary(context)))
    )
      return workstreamBoundary;
  }
  if (toolName === "update_workstream") {
    const parsed = idSchema.safeParse(args.workstreamId);
    if (!parsed.success) return null;
    const row = await AppDataSource.getRepository(Workstream).findOneBy({
      id: parsed.data,
      companyId: context.companyId,
      employeeId: context.employeeId,
    });
    if (
      row?.routineId &&
      (row.routineId !== context.routineId || !(await keepsPreparationBoundary(context)))
    )
      return workstreamBoundary;
  }
  if (toolName === "update_follow_up") {
    const parsed = idSchema.safeParse(args.followUpId);
    if (!parsed.success) return null;
    const row = await AppDataSource.getRepository(Activity).findOneBy({
      id: parsed.data,
      companyId: context.companyId,
      kind: "task",
    });
    if (
      row &&
      (row.recurrenceRule ||
        row.reminderAt ||
        row.assignedUserId ||
        (row.assignedEmployeeId && row.assignedEmployeeId !== context.employeeId))
    )
      return "Proactive preparation can maintain only ordinary follow-ups assigned to you or unassigned, without reminders or recurrence. Preserve this follow-up and record your finding in your Workstream.";
  }
  return null;
}
