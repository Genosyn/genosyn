import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
  type MailAccessLevel,
} from "../db/entities/EmployeeMailAccountGrant.js";
import { attachedModels } from "./models.js";
import { isModelConnected } from "./providers.js";
import { hasCompanyDirection } from "./companyDirection.js";
import { PROACTIVE_RECIPES } from "./proactive/catalogue.js";

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
  /**
   * How many of the scheduled Routines are standing work that Automatic setup
   * (or the Proactive starter library) assigned rather than Routines somebody
   * chose. Kept apart so the guide's summary can count the two honestly.
   */
  standingRoutineCount: number;
  /** Company.proactiveAutoSetup: whether new standing work is assigned automatically. */
  automaticSetup: boolean;
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

const STANDING_WORK_SLUG_PREFIXES = PROACTIVE_RECIPES.filter(
  (recipe) => recipe.kind === "routine",
).map((recipe) => `proactive-${recipe.id}-`);

/**
 * A Routine the Proactive starters created. They carry a `proactive-<starter>-`
 * slug (`services/proactive/setup.ts`), which is how the Proactive page and
 * Automatic setup recognise their own work too.
 */
function isStandingWorkRoutine(routine: Pick<Routine, "slug">): boolean {
  return STANDING_WORK_SLUG_PREFIXES.some((prefix) => routine.slug.startsWith(prefix));
}

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
  const directionReady = await hasCompanyDirection(company);
  const automaticSetup = company?.proactiveAutoSetup ?? false;
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
      standingRoutineCount: 0,
      automaticSetup,
      nextRunAt: null,
      skillCount: 0,
      mailGranted: false,
      mailAccessLevel: null,
      nextStep: directionReady ? "employee" : "company",
    };
  }

  const [attached, routines, skillCount, mailGrants] = await Promise.all([
    attachedModels(employee.id),
    AppDataSource.getRepository(Routine).find({ where: { employeeId: employee.id } }),
    AppDataSource.getRepository(Skill).countBy({ employeeId: employee.id }),
    AppDataSource.getRepository(EmployeeMailAccountGrant).find({
      where: { employeeId: employee.id },
    }),
  ]);

  const active = attached.models.find((model) => model.id === attached.activeId) ?? null;
  const modelConnected = active !== null && isModelConnected(active);

  const scheduled = routines.filter((routine) => routine.enabled && routine.nextRunAt !== null);
  const standing = scheduled.filter(isStandingWorkRoutine);
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
    standingRoutineCount: standing.length,
    automaticSetup,
    nextRunAt: dueRuns[0]?.toISOString() ?? null,
    skillCount,
    mailGranted: mailGrants.length > 0,
    mailAccessLevel,
    nextStep: !directionReady ? "company" : modelConnected ? "done" : "employee",
  };
}
