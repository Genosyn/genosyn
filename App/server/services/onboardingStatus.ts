import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
  type MailAccessLevel,
} from "../db/entities/EmployeeMailAccountGrant.js";
import { effectiveActiveId } from "./models.js";
import { isModelConnected } from "./providers.js";
import { hasCompanyDirection } from "./companyDirection.js";

/**
 * Where a first-run guide should resume. These ids mirror the client's step
 * machine in `client/pages/Onboarding.tsx` — keep the two lists in step.
 */
export type OnboardingStepId =
  | "company"
  | "employee"
  | "recommendations"
  | "email"
  | "first_request"
  | "done";

export type OnboardingStatus = {
  /** True once company direction is set and an AI Employee can answer. */
  complete: boolean;
  /** The AI Employee the guide is about, or null before the first hire. */
  employee: { id: string; name: string; slug: string; role: string } | null;
  /** An active AI Model with usable credentials. */
  modelConnected: boolean;
  /**
   * Every Routine the employee owns, and the subset that will actually fire.
   * Kept apart so a summary cannot say "3 Routines run on their own schedule"
   * about Routines the member has since switched off.
   */
  routineCount: number;
  scheduledRoutineCount: number;
  nextRunAt: string | null;
  /** Hiring without a template creates no Skills — do not claim otherwise. */
  skillCount: number;
  /**
   * The strongest mailbox access the employee holds. The level matters: a
   * summary that says "you press send" about a `send` Grant misstates a
   * safety property, which is worse than saying nothing.
   */
  mailGranted: boolean;
  mailAccessLevel: MailAccessLevel | null;
  /** The step a "finish setting up" link should land on. */
  nextStep: OnboardingStepId;
};

/**
 * Derive first-run progress from what actually exists rather than from a
 * stored flag.
 *
 * A persisted `onboardingStep` column would go stale the moment someone hires
 * an employee from the regular wizard, connects a model from the employee tab,
 * or deletes the employee the flag pointed at. Deriving it keeps the resume
 * banner honest in all three cases, uses indexed lookups, and needs no migration.
 *
 * "Complete" means company direction is set and the employee can answer with
 * a connected AI Model. Routines, Gmail, and the first request are all
 * optional, so a member who skipped them is finished, not nagged forever.
 */
export async function loadOnboardingStatus(
  companyId: string,
  /**
   * Which AI Employee to report on. Callers that are already talking about a
   * specific one — the guide's closing summary — must pass it, or the summary
   * ends up printing the oldest employee's facts beside a different name.
   * Omit it for the first-run question "is this company set up at all?", which
   * is about the first hire.
   */
  employeeId?: string,
): Promise<OnboardingStatus> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  const directionReady = hasCompanyDirection(company);
  const repo = AppDataSource.getRepository(AIEmployee);
  // Always scoped by companyId, so an id from another company resolves to
  // nothing rather than leaking that company's state.
  const employee = employeeId
    ? await repo.findOneBy({ id: employeeId, companyId })
    : ((await repo.find({ where: { companyId }, order: { createdAt: "ASC" }, take: 1 }))[0] ??
      null);
  if (!employee) {
    return {
      complete: false,
      employee: null,
      modelConnected: false,
      routineCount: 0,
      scheduledRoutineCount: 0,
      nextRunAt: null,
      skillCount: 0,
      mailGranted: false,
      mailAccessLevel: null,
      nextStep: directionReady ? "employee" : "company",
    };
  }

  const [models, routines, skillCount, mailGrants] = await Promise.all([
    AppDataSource.getRepository(AIModel).find({ where: { employeeId: employee.id } }),
    AppDataSource.getRepository(Routine).find({ where: { employeeId: employee.id } }),
    AppDataSource.getRepository(Skill).countBy({ employeeId: employee.id }),
    AppDataSource.getRepository(EmployeeMailAccountGrant).find({
      where: { employeeId: employee.id },
    }),
  ]);

  const activeId = effectiveActiveId(models);
  const active = models.find((model) => model.id === activeId) ?? null;
  const modelConnected = active !== null && isModelConnected(active);

  const scheduled = routines.filter((routine) => routine.enabled && routine.nextRunAt !== null);
  const dueRuns = scheduled
    .map((routine) => routine.nextRunAt as Date)
    .sort((a, b) => a.getTime() - b.getTime());

  const mailAccessLevel = mailGrants.reduce<MailAccessLevel | null>(
    (strongest, grant) =>
      strongest === null || MAIL_ACCESS_RANK[grant.accessLevel] > MAIL_ACCESS_RANK[strongest]
        ? grant.accessLevel
        : strongest,
    null,
  );

  return {
    complete: directionReady && modelConnected,
    employee: {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
    },
    modelConnected,
    routineCount: routines.length,
    scheduledRoutineCount: scheduled.length,
    nextRunAt: dueRuns[0]?.toISOString() ?? null,
    skillCount,
    mailGranted: mailGrants.length > 0,
    mailAccessLevel,
    nextStep: !directionReady ? "company" : modelConnected ? "done" : "employee",
  };
}
