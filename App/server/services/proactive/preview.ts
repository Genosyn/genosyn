import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { TldrSettings, type TldrCadence } from "../../db/entities/TldrSettings.js";
import type { ProactiveOverview } from "../../../shared/proactive.js";
import { planProactiveDefaults } from "./defaults.js";
import { getProactiveOverview, ProactiveSetupError } from "./setup.js";

/**
 * What the setup guide lists under "Also set up for {name}": the standing work
 * Automatic setup gives one AI Employee, and the company's TLDR briefing.
 *
 * Automatic setup used to be invisible. An employee with a model got four
 * Routines within a minute, and the guide, which was busy saying "choose up to
 * five", never mentioned them. The list is read from the planner that makes the
 * assignments (`planProactiveDefaults`), not from a second description of its
 * rules, so it cannot drift from what the switch really does.
 */

export type ProactiveDefaultsPreviewRow = {
  recipeId: string;
  name: string;
  /** In plain words: "Weekdays at 08:00", "Every 30 minutes". */
  schedule: string;
  /** Already set up, rather than something Automatic setup is about to add. */
  installed: boolean;
};

export type ProactiveDefaultsPreviewBriefing = {
  schedule: string;
  /** The AI Employee who writes it; null when the writer is no longer on the roster. */
  writerName: string | null;
  /** The writer is the employee the preview is about. */
  writerIsEmployee: boolean;
};

export type ProactiveDefaultsPreview = {
  /** Company.proactiveAutoSetup, the switch the Proactive page also owns. */
  automaticSetup: boolean;
  /** The employee's active AI Model is connected, so standing work starts right away. */
  employeeReady: boolean;
  /** In the order the Proactive page lists them. */
  starters: ProactiveDefaultsPreviewRow[];
  /** The company's TLDR briefing, when it is on and has someone to write it. */
  briefing: ProactiveDefaultsPreviewBriefing | null;
};

/** Worded as the TLDRs settings page words its cadences. */
const BRIEFING_SCHEDULE: Record<TldrCadence, string> = {
  four_hours: "Every 4 hours",
  eight_hours: "Every 8 hours",
  twelve_hours: "Every 12 hours",
  daily: "Daily",
  weekly: "Weekly",
};

/**
 * Standing work the planner would assign to `employeeId`, as `overview` stands.
 *
 * The planner is asked as though Automatic setup were on and the employee's AI
 * Model connected, whatever is true right now: the guide shows what the switch
 * does, and what the employee gets the moment it can run. The caller reports
 * the real state beside the list so neither is mistaken for the other.
 */
function plannedFor(overview: ProactiveOverview, employeeId: string): Set<string> {
  const asIfReady: ProactiveOverview = {
    ...overview,
    automaticSetup: true,
    employees: overview.employees.map((entry) =>
      entry.id === employeeId ? { ...entry, modelReady: true } : entry,
    ),
  };
  return new Set(
    planProactiveDefaults(asIfReady)
      .filter((input) => input.employeeId === employeeId)
      .map((input) => input.recipeId),
  );
}

export async function previewProactiveDefaults(
  companyId: string,
  employeeId: string,
): Promise<ProactiveDefaultsPreview> {
  const overview = await getProactiveOverview(companyId);
  const employee = overview.employees.find((entry) => entry.id === employeeId);
  if (!employee) throw new ProactiveSetupError("AI Employee not found", 404);

  const installed = new Set(
    overview.installations
      .filter((row) => row.employeeId === employeeId)
      .map((row) => row.recipeId),
  );
  const planned = plannedFor(overview, employeeId);
  const starters = overview.recipes
    .filter((recipe) => installed.has(recipe.id) || planned.has(recipe.id))
    .map((recipe) => ({
      recipeId: recipe.id,
      name: recipe.name,
      schedule:
        recipe.scheduleLabel ?? (recipe.kind === "email" ? "When a matching email arrives" : ""),
      installed: installed.has(recipe.id),
    }));

  return {
    automaticSetup: overview.automaticSetup,
    employeeReady: employee.modelReady,
    starters,
    briefing: await briefingFor(companyId, employeeId, employee.name),
  };
}

async function briefingFor(
  companyId: string,
  employeeId: string,
  employeeName: string,
): Promise<ProactiveDefaultsPreviewBriefing | null> {
  const settings = await AppDataSource.getRepository(TldrSettings).findOneBy({ companyId });
  if (!settings?.enabled || !settings.employeeId) return null;
  const writerIsEmployee = settings.employeeId === employeeId;
  const writerName = writerIsEmployee
    ? employeeName
    : ((
        await AppDataSource.getRepository(AIEmployee).findOneBy({
          id: settings.employeeId,
          companyId,
        })
      )?.name ?? null);
  return {
    schedule: BRIEFING_SCHEDULE[settings.cadence] ?? settings.cadence,
    writerName,
    writerIsEmployee,
  };
}
