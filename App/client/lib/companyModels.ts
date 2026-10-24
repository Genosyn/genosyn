import type { AIModel, ModelUser } from "./api";
import { describeModel } from "./modelSummary";

/**
 * The company's AI Models as Settings → AI Models and an employee's Model page
 * talk about them.
 *
 * A model belongs to the company: one set of keys and settings, attached to
 * any number of AI Employees, exactly one of each employee's models active.
 * These helpers say who uses a model, which company models an employee could
 * be given, which models are the same model twice, and what removing one does
 * — in the words the pages use, so every screen says it the same way.
 *
 * Dependency-free on purpose: it needs only the shape of a model, and runs
 * under `node --test`.
 */

/** `/api/companies/:cid/models[/:id][suffix]` — every route keyed on a model row. */
export function companyModelPath(companyId: string, modelId?: string, suffix = ""): string {
  return `/api/companies/${companyId}/models${modelId ? `/${modelId}` : ""}${suffix}`;
}

/** `/api/companies/:cid/employees/:eid/models[/:id][suffix]` — which models an employee uses. */
export function employeeModelPath(
  companyId: string,
  employeeId: string,
  modelId?: string,
  suffix = "",
): string {
  return `/api/companies/${companyId}/employees/${employeeId}/models${
    modelId ? `/${modelId}` : ""
  }${suffix}`;
}

/** "Ada", "Ada and Grace", "Ada, Grace and Linus". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The line under a company model saying who runs on it:
 * "Used by Ada and Grace", "Not used by any AI Employee yet".
 */
export function usedByLine(model: Pick<AIModel, "employees">): string {
  if (model.employees.length === 0) return "Not used by any AI Employee yet";
  return `Used by ${nameList(model.employees.map((user) => user.name))}`;
}

/**
 * On one employee's card, who else runs on the same model — so whoever changes
 * its keys or settings knows they change for them too. Null when nobody does.
 */
export function sharedWithLine(
  model: Pick<AIModel, "employees">,
  employeeId: string,
): string | null {
  const others = model.employees.filter((user) => user.id !== employeeId);
  if (others.length === 0) return null;
  return `Also used by ${nameList(others.map((user) => user.name))}`;
}

/**
 * The company's models an employee could be given: connected, not attached to
 * it already, the model most of the company runs on first, then the newest.
 */
export function attachableModels(models: readonly AIModel[], employeeId: string): AIModel[] {
  return models
    .filter(
      (model) =>
        model.status === "connected" && !model.employees.some((user) => user.id === employeeId),
    )
    .sort(
      (a, b) =>
        b.employees.length - a.employees.length ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        a.id.localeCompare(b.id),
    );
}

/**
 * The button that gives an employee a model the company already runs on:
 * "Use the same AI Model as Ada", "… as Ada and Grace", "… as Ada and 2 others".
 */
export function sameModelAsLabel(model: Pick<AIModel, "employees">): string {
  const users = model.employees.map((user) => user.name);
  if (users.length === 0) return "Use this AI Model";
  if (users.length <= 2) return `Use the same AI Model as ${nameList(users)}`;
  return `Use the same AI Model as ${users[0]} and ${users.length - 1} others`;
}

/** The line under an offered model: who runs on it, and where it connects. */
export function offerLine(
  model: Pick<AIModel, "employees" | "customEndpointHost" | "apiKeys" | "authMode">,
): string {
  const parts = [usedByLine(model)];
  if (model.customEndpointHost) parts.push(model.customEndpointHost);
  else if (model.authMode === "apikey" && model.apiKeys[0]) parts.push(model.apiKeys[0].preview);
  return parts.join(" · ");
}

/** Of `employees`, those that don't use this model yet, in the order given. */
export function attachCandidates<T extends { id: string }>(
  employees: readonly T[],
  model: Pick<AIModel, "employees">,
): T[] {
  const using = new Set(model.employees.map((user) => user.id));
  return employees.filter((employee) => !using.has(employee.id));
}

/** Copies of the same model with the same keys, and the one a merge keeps. */
export type DuplicateGroup = { keep: AIModel; duplicates: AIModel[] };

function oldestFirst(a: AIModel, b: AIModel): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * The company's exact duplicates, grouped: each group keeps its oldest model,
 * which stays with its settings, and folds the rest into it. Only models the
 * list itself holds are grouped.
 */
export function duplicateGroups(models: readonly AIModel[]): DuplicateGroup[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const model of models) {
    if (seen.has(model.id) || model.duplicateIds.length === 0) continue;
    const members = new Map<string, AIModel>();
    const queue = [model];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (members.has(next.id)) continue;
      members.set(next.id, next);
      for (const id of next.duplicateIds) {
        const other = byId.get(id);
        if (other && !members.has(id)) queue.push(other);
      }
    }
    const ordered = [...members.values()].sort(oldestFirst);
    for (const member of ordered) seen.add(member.id);
    if (ordered.length < 2) continue;
    groups.push({ keep: ordered[0], duplicates: ordered.slice(1) });
  }
  return groups;
}

/** What merging a group says, before anything happens. */
export function mergeSummary(group: DuplicateGroup): {
  title: string;
  message: string;
  confirmLabel: string;
} {
  const copies = group.duplicates.length + 1;
  const users = [
    ...new Map(
      [group.keep, ...group.duplicates].flatMap((model) =>
        model.employees.map((user) => [user.id, user.name] as const),
      ),
    ).values(),
  ];
  const who = users.length > 0 ? ` ${nameList(users)} will all run on the one that stays.` : "";
  return {
    title: `Merge ${copies} copies of ${describeModel(group.keep)}?`,
    message:
      `They hold the same keys, so one is enough.${who} The oldest copy stays with its settings ` +
      "— context window and concurrent Runs — and the others are removed.",
    confirmLabel: `Merge into one`,
  };
}

/**
 * The employees using `modelId` that would be left with no AI Model at all if
 * it went — they appear on no other model in the list.
 */
export function leftWithoutModel(models: readonly AIModel[], modelId: string): ModelUser[] {
  const target = models.find((model) => model.id === modelId);
  if (!target) return [];
  return target.employees.filter(
    (user) =>
      !models.some(
        (model) => model.id !== modelId && model.employees.some((other) => other.id === user.id),
      ),
  );
}

/**
 * What removing a model asks first. A model nobody uses goes with its keys; a
 * model in use is removed only by detaching it from everyone first, said in
 * so many words, naming who would be left with no AI Model.
 */
export function removalPrompt(
  models: readonly AIModel[],
  model: AIModel,
): { title: string; message: string; confirmLabel: string; detach: boolean } {
  const users = model.employees.map((user) => user.name);
  if (users.length === 0) {
    return {
      title: "Remove this AI Model?",
      message: `${describeModel(model)} and the keys saved with it are deleted. You can connect it again any time.`,
      confirmLabel: "Remove",
      detach: false,
    };
  }
  const stranded = leftWithoutModel(models, model.id).map((user) => user.name);
  const strandedLine =
    stranded.length === 0
      ? " Each of them switches to another AI Model they have."
      : ` ${nameList(stranded)} ${stranded.length === 1 ? "has" : "have"} no other AI Model and ${
          stranded.length === 1 ? "stops" : "stop"
        } working until one is attached.`;
  return {
    title:
      users.length === 1
        ? `Remove an AI Model ${users[0]} uses?`
        : `Remove an AI Model ${users.length} AI Employees use?`,
    message:
      `${nameList(users)} ${users.length === 1 ? "uses" : "use"} ${describeModel(model)}. ` +
      `Removing it detaches it from ${users.length === 1 ? "them" : "all of them"} and deletes its keys.` +
      strandedLine,
    confirmLabel: "Detach and remove",
    detach: true,
  };
}

/** What detaching a model from one employee says first. */
export function detachPrompt(
  model: AIModel,
  employee: { id: string; name: string },
): { title: string; message: string; confirmLabel: string } {
  const others = model.employees.filter((user) => user.id !== employee.id).map((user) => user.name);
  const stays =
    others.length > 0
      ? `It stays in Settings → AI Models, and ${nameList(others)} ${
          others.length === 1 ? "keeps" : "keep"
        } using it.`
      : "It stays in Settings → AI Models with its keys, ready to attach again.";
  return {
    title: `Detach this AI Model from ${employee.name}?`,
    message: `${employee.name} stops using ${describeModel(model)}. ${stays}`,
    confirmLabel: "Detach",
  };
}
