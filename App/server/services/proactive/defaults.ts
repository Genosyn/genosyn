import { MoreThan } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import {
  proactiveReadiness,
  type ProactiveOverview,
  type ProactiveEmployee,
  type ProactiveMailbox,
  type ProactiveRecipe,
} from "../../../shared/proactive.js";
import { PlanLimitError } from "../entitlements.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { workBlocked } from "../standdowns.js";
import { initializeProactiveDefaults } from "./defaultsState.js";
import {
  getProactiveOverview,
  installProactiveStarter,
  ProactiveSetupError,
  type ProactiveSetupInput,
} from "./setup.js";
import { proactiveScope, proactiveScopeKind } from "./scopes.js";

type DefaultsOverview = ProactiveOverview & {
  automaticSetup: boolean;
  defaultAssignments: Record<string, string>;
};

/** Pure ownership planner: an existing reservation includes paused, customized, and deleted work. */
export function planProactiveDefaults(
  overview: DefaultsOverview,
  blockedEmployeeIds: ReadonlySet<string> = new Set(),
): ProactiveSetupInput[] {
  if (!overview.automaticSetup) return [];
  const occupied = new Set(Object.keys(overview.defaultAssignments));
  for (const row of overview.installations) {
    occupied.add(proactiveScope(row.recipeId, row.accountId, row.employeeId));
  }
  const employees = [...overview.employees]
    .filter((employee) => !blockedEmployeeIds.has(employee.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const mailboxes = [...overview.mailboxes].sort((left, right) => left.id.localeCompare(right.id));
  const plan: ProactiveSetupInput[] = [];
  const assignedEmployees = new Set(
    overview.installations
      .filter((row) => row.enabled && row.recipeId !== "work-followthrough")
      .map((row) => row.employeeId),
  );
  const choose = (recipe: ProactiveRecipe, mailbox?: ProactiveMailbox) => {
    const preferred = (
      mailbox as (ProactiveMailbox & { analysisEmployeeId?: string | null }) | undefined
    )?.analysisEmployeeId;
    return [...employees]
      .sort((left, right) => Number(right.id === preferred) - Number(left.id === preferred))
      .find((employee) => proactiveReadiness(recipe, employee, mailbox, "draft").length === 0);
  };
  const add = (
    recipe: ProactiveRecipe,
    employee: ProactiveEmployee,
    mailbox?: ProactiveMailbox,
  ) => {
    const accountId = mailbox?.id ?? null;
    const scope = proactiveScope(recipe.id, accountId, employee.id);
    if (occupied.has(scope)) return;
    occupied.add(scope);
    assignedEmployees.add(employee.id);
    plan.push({
      recipeId: recipe.id,
      employeeId: employee.id,
      accountId,
      delivery: "draft",
      instruction: recipe.brief,
    });
  };
  // Select owners before adding follow-through, so even the first ready inbox
  // worker gets a continuation Routine before optional scheduled work uses capacity.
  for (const recipe of overview.recipes) {
    const kind = proactiveScopeKind(recipe.id);
    if (kind === "employee") continue;
    if (kind === "mailbox") {
      for (const mailbox of mailboxes) {
        const employee = choose(recipe, mailbox);
        if (employee) add(recipe, employee, mailbox);
      }
    } else if (recipe.requirements.includes("mail")) {
      for (const mailbox of mailboxes) {
        const employee = choose(recipe, mailbox);
        if (employee) {
          add(recipe, employee, mailbox);
          break;
        }
      }
    } else {
      const employee = choose(recipe);
      if (employee) add(recipe, employee);
    }
  }
  const followthrough = overview.recipes.find((recipe) => recipe.id === "work-followthrough");
  if (followthrough) {
    for (const employee of employees) {
      if (
        assignedEmployees.has(employee.id) &&
        proactiveReadiness(followthrough, employee, undefined).length === 0
      ) {
        add(followthrough, employee);
      }
    }
  }
  return plan.sort((left, right) => {
    const priority = (input: ProactiveSetupInput) =>
      input.recipeId === "work-followthrough"
        ? 0
        : overview.recipes.find((recipe) => recipe.id === input.recipeId)?.kind === "email"
          ? 1
          : 2;
    return priority(left) - priority(right);
  });
}

type DefaultsDependencies = {
  initialize: (companyId: string) => Promise<unknown>;
  overview: (companyId: string) => Promise<DefaultsOverview>;
  install: typeof installProactiveStarter;
  blocked: typeof workBlocked;
};
const defaultsDependencies: DefaultsDependencies = {
  initialize: initializeProactiveDefaults,
  overview: getProactiveOverview,
  install: installProactiveStarter,
  blocked: workBlocked,
};

const companyRuns = new Map<string, Promise<void>>();

/** Initialization and native installation claims are durable; this coalesces local arrivals. */
export function reconcileProactiveDefaults(
  companyId: string,
  dependencies: DefaultsDependencies = defaultsDependencies,
): Promise<void> {
  const active = companyRuns.get(companyId);
  if (active) return active;
  const run = (async () => {
    if (dependencies.blocked(companyId).blocked) return;
    await dependencies.initialize(companyId);
    const overview = await dependencies.overview(companyId);
    const blocked = new Set(
      overview.employees
        .filter((employee) => dependencies.blocked(companyId, { employeeId: employee.id }).blocked)
        .map((employee) => employee.id),
    );
    for (const input of planProactiveDefaults(overview, blocked)) {
      if (dependencies.blocked(companyId, { employeeId: input.employeeId }).blocked) continue;
      try {
        await dependencies.install(companyId, null, input, { automatic: true });
      } catch (error) {
        // Missing live prerequisites, a paused scope, or plan capacity are
        // pending setup, not incidents. A later reconciliation can try again.
        if (!(error instanceof ProactiveSetupError) && !(error instanceof PlanLimitError))
          throw error;
      }
    }
  })().finally(() => {
    if (companyRuns.get(companyId) === run) companyRuns.delete(companyId);
  });
  companyRuns.set(companyId, run);
  return run;
}

const DISCOVERY_INTERVAL_MS = 60_000;
const COMPANY_PAGE_SIZE = 50;
let discoveryTimer: NodeJS.Timeout | null = null;
let discovering = false;

/** Repair sweep also covers new companies/mailboxes and writes made on other replicas. */
export async function sweepProactiveDefaults(): Promise<void> {
  if (discovering) return;
  discovering = true;
  try {
    await withSchedulerLease("proactive-defaults", 60_000, async (lease) => {
      let cursor: string | undefined;
      for (;;) {
        const companies = await AppDataSource.getRepository(Company).find({
          where: { proactiveAutoSetup: true, ...(cursor ? { id: MoreThan(cursor) } : {}) },
          select: { id: true },
          order: { id: "ASC" },
          take: COMPANY_PAGE_SIZE,
        });
        for (const company of companies) {
          if (!lease.isHeld()) return;
          try {
            await reconcileProactiveDefaults(company.id);
          } catch (error) {
            // One unavailable company must not prevent other ready companies starting.
            // eslint-disable-next-line no-console
            console.error(`[proactive] automatic setup failed for company ${company.id}:`, error);
          }
        }
        if (companies.length < COMPANY_PAGE_SIZE) return;
        cursor = companies.at(-1)!.id;
      }
    });
  } finally {
    discovering = false;
  }
}

export async function bootProactiveDefaults(): Promise<void> {
  stopProactiveDefaults();
  await sweepProactiveDefaults();
  discoveryTimer = setInterval(() => {
    void sweepProactiveDefaults().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[proactive] automatic setup sweep failed:", error);
    });
  }, DISCOVERY_INTERVAL_MS);
  discoveryTimer.unref();
}

/** Stop discovery before a test database closes or a lifecycle restarts it. */
export function stopProactiveDefaults(): void {
  if (discoveryTimer) clearInterval(discoveryTimer);
  discoveryTimer = null;
}
