import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Chart } from "../db/entities/Chart.js";
import { Goal, type GoalDirection, type GoalMetricKind, type GoalStatus } from "../db/entities/Goal.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { toSlug } from "../lib/slug.js";
// The shared uuid-PK guard, not a second copy — see routineFolders.ts for why
// arbitrary text must never reach a uuid lookup on Postgres.
import { UUID_RE } from "./bases.js";
import { runSqlAgainstConnection } from "./explore.js";
import { createNotifications } from "./notifications.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * Goals — the machine-readable layer of company intent (M51).
 *
 * The invariants live here so the HTTP router, the MCP tool handlers, and the
 * sweep all enforce the same ones: a Goal tree that cannot cycle or exceed a
 * readable depth, a chart binding that only ever reads a Chart of the same
 * company, progress that is arithmetic rather than vibes, and `achieved` /
 * `missed` transitions that settle exactly once however many processes race
 * the sweep.
 */

/**
 * How deep the cascade may go, counting a top-level company Goal as 1.
 * Company → department → employee is the whole point; a fourth level absorbs
 * real-world nesting without letting a client build a tree nobody can read.
 */
export const MAX_GOAL_DEPTH = 4;

/** Keep prompt injection bounded however many goals a company writes. */
const PROMPT_GOALS_MAX = 5;

/** One refresh pass is bounded so a pathological company cannot wedge the
 * heartbeat behind hundreds of SQL round-trips. Later goals catch the next
 * tick — refresh order is stable (oldest value first), so nothing starves. */
const SWEEP_REFRESH_MAX = 25;

export class GoalError extends Error {}

export type GoalInput = {
  title: string;
  description?: string;
  parentGoalId?: string | null;
  ownerEmployeeId?: string | null;
  metricKind?: GoalMetricKind;
  chartId?: string | null;
  startValue?: number | null;
  targetValue: number;
  currentValue?: number | null;
  direction?: GoalDirection;
  unit?: string;
  dueAt?: Date | null;
};

export type GoalPatch = Partial<GoalInput> & { status?: GoalStatus };

export type GoalDTO = {
  id: string;
  slug: string;
  title: string;
  description: string;
  parentGoalId: string | null;
  ownerEmployeeId: string | null;
  metricKind: GoalMetricKind;
  chartId: string | null;
  startValue: number | null;
  targetValue: number;
  currentValue: number | null;
  currentValueUpdatedAt: string | null;
  direction: GoalDirection;
  unit: string;
  dueAt: string | null;
  status: GoalStatus;
  settledAt: string | null;
  createdAt: string;
  /** 0..1 when computable, null when there is no basis to compute one. */
  progress: number | null;
  /** Whether `currentValue` already clears `targetValue` in `direction`. */
  met: boolean;
};

function goalRepo() {
  return AppDataSource.getRepository(Goal);
}

/**
 * Whether the metric already clears the target. Null current value is never
 * "met" — absence of evidence stays absence, exactly like a null verdict.
 */
export function isGoalMet(goal: Pick<Goal, "currentValue" | "targetValue" | "direction">): boolean {
  if (goal.currentValue === null) return false;
  return goal.direction === "decrease_to"
    ? goal.currentValue <= goal.targetValue
    : goal.currentValue >= goal.targetValue;
}

/**
 * Progress toward the target as 0..1, or null when there is no honest basis:
 * no current value, or a `decrease_to` goal with no baseline (without knowing
 * where the metric started, "how far along is the decrease" has no answer).
 * Overachievement clamps to 1 — the bar was cleared; by how much is the
 * chart's job to show.
 */
export function goalProgress(
  goal: Pick<Goal, "startValue" | "targetValue" | "currentValue" | "direction">,
): number | null {
  const current = goal.currentValue;
  if (current === null) return null;
  if (isGoalMet(goal as Pick<Goal, "currentValue" | "targetValue" | "direction">)) return 1;
  if (goal.direction === "decrease_to") {
    if (goal.startValue === null || goal.startValue === goal.targetValue) return null;
    const span = goal.startValue - goal.targetValue;
    return clamp01((goal.startValue - current) / span);
  }
  const start = goal.startValue ?? 0;
  if (goal.targetValue === start) return null;
  return clamp01((current - start) / (goal.targetValue - start));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function serializeGoal(goal: Goal): GoalDTO {
  return {
    id: goal.id,
    slug: goal.slug,
    title: goal.title,
    description: goal.description,
    parentGoalId: goal.parentGoalId,
    ownerEmployeeId: goal.ownerEmployeeId,
    metricKind: goal.metricKind,
    chartId: goal.chartId,
    startValue: goal.startValue,
    targetValue: goal.targetValue,
    currentValue: goal.currentValue,
    currentValueUpdatedAt: goal.currentValueUpdatedAt?.toISOString() ?? null,
    direction: goal.direction,
    unit: goal.unit,
    dueAt: goal.dueAt?.toISOString() ?? null,
    status: goal.status,
    settledAt: goal.settledAt?.toISOString() ?? null,
    createdAt: goal.createdAt.toISOString(),
    progress: goalProgress(goal),
    met: isGoalMet(goal),
  };
}

export async function listGoals(companyId: string): Promise<Goal[]> {
  return goalRepo().find({ where: { companyId }, order: { createdAt: "ASC" } });
}

export async function getGoal(companyId: string, id: string): Promise<Goal | null> {
  if (!UUID_RE.test(id)) return null;
  return goalRepo().findOneBy({ id, companyId });
}

/** Resolve a Goal by uuid or by its company slug — the shape MCP tools accept. */
export async function resolveGoal(companyId: string, ref: string): Promise<Goal | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (UUID_RE.test(trimmed)) return goalRepo().findOneBy({ id: trimmed, companyId });
  return goalRepo().findOneBy({ companyId, slug: toSlug(trimmed) || trimmed });
}

async function uniqueGoalSlug(companyId: string, title: string): Promise<string> {
  const base = toSlug(title) || "goal";
  const taken = new Set(
    (await goalRepo().find({ where: { companyId }, select: { slug: true } })).map((g) => g.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Depth of the tree the goal would sit in if parented under `parentGoalId`,
 * walking up. Also the cycle guard: hitting `selfId` on the way up means the
 * proposed parent lives inside the goal's own subtree.
 */
async function depthUnder(
  companyId: string,
  parentGoalId: string | null,
  selfId: string | null,
): Promise<number> {
  let depth = 1;
  let cursor = parentGoalId;
  const seen = new Set<string>();
  while (cursor) {
    if (selfId && cursor === selfId) throw new GoalError("A goal cannot be nested inside itself");
    if (seen.has(cursor)) throw new GoalError("The goal tree contains a cycle");
    seen.add(cursor);
    const parent = await goalRepo().findOneBy({ id: cursor, companyId });
    if (!parent) throw new GoalError("Parent goal not found");
    depth += 1;
    cursor = parent.parentGoalId;
  }
  if (depth > MAX_GOAL_DEPTH) {
    throw new GoalError(`Goals can be nested at most ${MAX_GOAL_DEPTH} levels deep`);
  }
  return depth;
}

/**
 * A goal's descendants must stay inside {@link MAX_GOAL_DEPTH} after a
 * re-parent too, so the subtree's own height bounds where it may move.
 */
async function subtreeHeight(companyId: string, goalId: string): Promise<number> {
  const all = await goalRepo().find({ where: { companyId }, select: { id: true, parentGoalId: true } });
  const children = new Map<string | null, string[]>();
  for (const row of all) {
    const list = children.get(row.parentGoalId) ?? [];
    list.push(row.id);
    children.set(row.parentGoalId, list);
  }
  const walk = (id: string): number => {
    const kids = children.get(id) ?? [];
    let deepest = 0;
    for (const kid of kids) deepest = Math.max(deepest, walk(kid));
    return 1 + deepest;
  };
  return walk(goalId);
}

async function assertOwnerEmployee(companyId: string, employeeId: string): Promise<void> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new GoalError("Owner employee not found in this company");
}

async function assertChart(companyId: string, chartId: string): Promise<void> {
  if (!UUID_RE.test(chartId)) throw new GoalError("Chart not found in this company");
  const chart = await AppDataSource.getRepository(Chart).findOneBy({ id: chartId, companyId });
  if (!chart) throw new GoalError("Chart not found in this company");
}

function assertMetricShape(metricKind: GoalMetricKind, chartId: string | null): void {
  if (metricKind === "chart" && !chartId) {
    throw new GoalError("A chart-metric goal needs a chart");
  }
  if (metricKind === "manual" && chartId) {
    throw new GoalError("A manual goal cannot carry a chart binding");
  }
}

export async function createGoal(
  companyId: string,
  input: GoalInput,
  createdById: string | null,
): Promise<Goal> {
  const title = input.title.trim();
  if (!title) throw new GoalError("A goal needs a title");
  const metricKind = input.metricKind ?? "manual";
  const chartId = input.chartId ?? null;
  assertMetricShape(metricKind, chartId);
  if (chartId) await assertChart(companyId, chartId);
  if (input.ownerEmployeeId) await assertOwnerEmployee(companyId, input.ownerEmployeeId);
  await depthUnder(companyId, input.parentGoalId ?? null, null);

  const goal = goalRepo().create({
    companyId,
    title,
    slug: await uniqueGoalSlug(companyId, title),
    description: (input.description ?? "").trim(),
    parentGoalId: input.parentGoalId ?? null,
    ownerEmployeeId: input.ownerEmployeeId ?? null,
    metricKind,
    chartId,
    startValue: input.startValue ?? null,
    targetValue: input.targetValue,
    currentValue: input.currentValue ?? null,
    currentValueUpdatedAt: input.currentValue != null ? new Date() : null,
    direction: input.direction ?? "increase_to",
    unit: (input.unit ?? "").trim(),
    dueAt: input.dueAt ?? null,
    status: "active",
    createdById,
  });
  return goalRepo().save(goal);
}

export async function updateGoal(companyId: string, id: string, patch: GoalPatch): Promise<Goal> {
  const goal = await getGoal(companyId, id);
  if (!goal) throw new GoalError("Goal not found");

  if (patch.parentGoalId !== undefined && patch.parentGoalId !== goal.parentGoalId) {
    const depth = await depthUnder(companyId, patch.parentGoalId ?? null, goal.id);
    const height = await subtreeHeight(companyId, goal.id);
    if (depth + height - 1 > MAX_GOAL_DEPTH) {
      throw new GoalError(`Goals can be nested at most ${MAX_GOAL_DEPTH} levels deep`);
    }
    goal.parentGoalId = patch.parentGoalId ?? null;
  }
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new GoalError("A goal needs a title");
    // The slug survives a rename so links stay stable — the company-wide rule.
    goal.title = title;
  }
  if (patch.description !== undefined) goal.description = patch.description.trim();
  if (patch.ownerEmployeeId !== undefined) {
    if (patch.ownerEmployeeId) await assertOwnerEmployee(companyId, patch.ownerEmployeeId);
    goal.ownerEmployeeId = patch.ownerEmployeeId ?? null;
  }
  const nextMetricKind = patch.metricKind ?? goal.metricKind;
  const nextChartId = patch.chartId !== undefined ? patch.chartId : goal.chartId;
  if (nextMetricKind !== goal.metricKind || nextChartId !== goal.chartId) {
    assertMetricShape(nextMetricKind, nextChartId ?? null);
    if (nextChartId && nextChartId !== goal.chartId) await assertChart(companyId, nextChartId);
    goal.metricKind = nextMetricKind;
    goal.chartId = nextChartId ?? null;
  }
  if (patch.startValue !== undefined) goal.startValue = patch.startValue;
  if (patch.targetValue !== undefined) goal.targetValue = patch.targetValue;
  if (patch.currentValue !== undefined) {
    goal.currentValue = patch.currentValue;
    goal.currentValueUpdatedAt = new Date();
  }
  if (patch.direction !== undefined) goal.direction = patch.direction;
  if (patch.unit !== undefined) goal.unit = patch.unit.trim();
  if (patch.dueAt !== undefined) goal.dueAt = patch.dueAt;
  if (patch.status !== undefined && patch.status !== goal.status) {
    goal.status = patch.status;
    // A human decision about the state is also a settle/unsettle: reactivating
    // clears the stamp so the sweep may settle the goal again later.
    goal.settledAt = patch.status === "active" ? null : new Date();
  }
  return goalRepo().save(goal);
}

/**
 * Deleting a goal never deletes what hangs off it: child goals re-parent to
 * the deleted goal's own parent (the RoutineFolder rule), and routines that
 * declared it simply stop declaring an objective.
 */
export async function deleteGoal(companyId: string, id: string): Promise<Goal> {
  const goal = await getGoal(companyId, id);
  if (!goal) throw new GoalError("Goal not found");
  await AppDataSource.transaction(async (m) => {
    await m.update(Goal, { companyId, parentGoalId: goal.id }, { parentGoalId: goal.parentGoalId });
    // Goal ids are uuids, so the id alone cannot collide across companies; the
    // routine hop to a company is through its employee, which this write does
    // not need.
    await m.update(Routine, { goalId: goal.id }, { goalId: null });
    await m.delete(Goal, { id: goal.id, companyId });
  });
  // Routine rows changed through update(), which gives the subscriber no
  // entity to resolve a company from — announce the routine change explicitly.
  emitResourceChange(companyId, "routine");
  return goal;
}

/**
 * Record a manual progress report. Chart-bound goals refuse it — their number
 * comes from the database, and letting a report overwrite it would make the
 * next sweep silently erase what was reported.
 */
export async function reportGoalProgress(
  companyId: string,
  id: string,
  value: number,
): Promise<Goal> {
  const goal = await getGoal(companyId, id);
  if (!goal) throw new GoalError("Goal not found");
  if (goal.metricKind !== "manual") {
    throw new GoalError("This goal's value comes from its chart — it cannot be reported by hand");
  }
  if (goal.status === "archived") throw new GoalError("This goal is archived");
  goal.currentValue = value;
  goal.currentValueUpdatedAt = new Date();
  const saved = await goalRepo().save(goal);
  await settleIfDue(saved);
  return saved;
}

/**
 * Pull the current value for a chart-bound goal: run the Chart's SQL over its
 * own Connection and read the first numeric cell of the first row — the same
 * contract the `scalar` viz renders. Throws {@link GoalError} with the reason
 * when the chart cannot produce a number, so callers can surface it.
 */
export async function refreshGoalValue(goal: Goal): Promise<Goal> {
  if (goal.metricKind !== "chart" || !goal.chartId) {
    throw new GoalError("Only chart-metric goals can be refreshed");
  }
  const chart = await AppDataSource.getRepository(Chart).findOneBy({
    id: goal.chartId,
    companyId: goal.companyId,
  });
  if (!chart) throw new GoalError("The bound chart no longer exists");
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: chart.connectionId,
    companyId: goal.companyId,
  });
  if (!connection) throw new GoalError("The chart's database connection no longer exists");
  const result = await runSqlAgainstConnection(connection, chart.sql, { maxRows: 1 });
  const first = result.rows[0];
  if (!first) throw new GoalError("The chart returned no rows");
  const value = firstNumericCell(first);
  if (value === null) throw new GoalError("The chart's first row has no numeric cell");
  goal.currentValue = value;
  goal.currentValueUpdatedAt = new Date();
  return goalRepo().save(goal);
}

function firstNumericCell(row: Record<string, unknown>): number | null {
  for (const cell of Object.values(row)) {
    if (typeof cell === "number" && Number.isFinite(cell)) return cell;
    if (typeof cell === "string" && cell.trim() !== "") {
      const parsed = Number(cell);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Settle `achieved` / `missed` at most once. The transition is claimed with a
 * conditional UPDATE on `status: "active"` — the escalation-sweep pattern —
 * so however many processes race (the heartbeat, a manual refresh, a progress
 * report), exactly one of them notifies.
 */
async function settleIfDue(goal: Goal, now: Date = new Date()): Promise<void> {
  if (goal.status !== "active") return;
  let next: GoalStatus | null = null;
  if (isGoalMet(goal)) next = "achieved";
  else if (goal.dueAt && goal.dueAt.getTime() <= now.getTime()) next = "missed";
  if (!next) return;
  const claimed = await goalRepo().update(
    { id: goal.id, status: "active" },
    { status: next, settledAt: now },
  );
  if (claimed.affected !== 1) return;
  goal.status = next;
  goal.settledAt = now;
  await notifyGoalSettled(goal, next);
}

async function notifyGoalSettled(goal: Goal, status: "achieved" | "missed"): Promise<void> {
  try {
    const admins = await AppDataSource.getRepository(Membership).find({
      where: { companyId: goal.companyId, role: In(["owner", "admin"]) },
    });
    if (admins.length === 0) return;
    const value =
      goal.currentValue === null ? "no reported value" : `${goal.currentValue}${goal.unit ? ` ${goal.unit}` : ""}`;
    await createNotifications(
      admins.map((m) => ({
        companyId: goal.companyId,
        userId: m.userId,
        kind: status === "achieved" ? ("goal_achieved" as const) : ("goal_missed" as const),
        title:
          status === "achieved"
            ? `Goal achieved: ${goal.title}`
            : `Goal missed: ${goal.title}`,
        body:
          status === "achieved"
            ? `The target of ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""} was met (${value}).`
            : `The deadline passed at ${value} against a target of ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""}.`,
        link: `/goals`,
        entityKind: "goal",
        entityId: goal.id,
      })),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[goals] failed to notify settle of goal ${goal.id}:`, err);
  }
}

/**
 * The heartbeat pass: refresh chart-bound values (bounded, stalest first),
 * then settle every active goal that is now met or past due. Each goal's
 * failure is its own — one broken chart must not stop the rest of the sweep.
 */
export async function sweepGoals(now: Date = new Date()): Promise<void> {
  const repo = goalRepo();
  const chartGoals = await repo.find({
    where: { status: "active", metricKind: "chart" },
    order: { currentValueUpdatedAt: "ASC" },
    take: SWEEP_REFRESH_MAX,
  });
  for (const goal of chartGoals) {
    try {
      await refreshGoalValue(goal);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[goals] refresh failed for goal ${goal.id}:`, err);
    }
  }
  const active = await repo.find({ where: { status: "active" } });
  for (const goal of active) {
    try {
      await settleIfDue(goal, now);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[goals] settle failed for goal ${goal.id}:`, err);
    }
  }
}

function goalPromptLine(goal: Goal): string {
  const pieces = [
    `- **${goal.title}** — ${goal.currentValue ?? "?"} of ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""}`,
    goal.direction === "decrease_to" ? "(driving down)" : "",
    goal.dueAt ? `due ${goal.dueAt.toISOString().slice(0, 10)}` : "",
  ].filter(Boolean);
  const head = pieces.join(" ");
  const description = goal.description.trim().split("\n")[0];
  return description ? `${head}\n  ${description}` : head;
}

/**
 * The "## Goals" system-prompt block for one employee: the active goals it
 * owns, then the company's top-level active goals for shared direction. Empty
 * string when the company has written no goals — no header with nothing
 * under it.
 */
export async function composeGoalsContext(companyId: string, employeeId: string): Promise<string> {
  const repo = goalRepo();
  const [own, top] = await Promise.all([
    repo.find({
      where: { companyId, status: "active", ownerEmployeeId: employeeId },
      order: { createdAt: "ASC" },
      take: PROMPT_GOALS_MAX,
    }),
    repo.find({
      where: { companyId, status: "active", parentGoalId: IsNull() },
      order: { createdAt: "ASC" },
      take: PROMPT_GOALS_MAX,
    }),
  ]);
  const company = top.filter((g) => g.ownerEmployeeId !== employeeId);
  if (own.length === 0 && company.length === 0) return "";
  const parts: string[] = ["\n## Goals\n"];
  if (own.length > 0) {
    parts.push("Goals you own — steer your work toward these:");
    parts.push(...own.map(goalPromptLine));
  }
  if (company.length > 0) {
    if (own.length > 0) parts.push("");
    parts.push("Company goals for shared direction:");
    parts.push(...company.map(goalPromptLine));
  }
  parts.push("");
  parts.push(
    "When your work moves a goal's number, report it with update_goal_progress (manual goals only — chart goals track themselves).",
  );
  return parts.join("\n");
}

/**
 * The Run-brief block for a Routine's linked Goal — folded beside the
 * acceptance criteria so the employee aims at the objective it is graded on.
 * Null when the link dangles or the goal is not active.
 */
export async function goalBriefBlock(
  companyId: string,
  goalId: string | null,
): Promise<string | null> {
  if (!goalId) return null;
  const goal = await goalRepo().findOneBy({ id: goalId, companyId });
  if (!goal || goal.status !== "active") return null;
  const lines = [
    `This routine serves the goal "${goal.title}": ` +
      `${goal.direction === "decrease_to" ? "drive down to" : "reach"} ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""}` +
      `${goal.currentValue !== null ? ` (currently ${goal.currentValue}${goal.unit ? ` ${goal.unit}` : ""})` : ""}` +
      `${goal.dueAt ? `, due ${goal.dueAt.toISOString().slice(0, 10)}` : ""}.`,
  ];
  const description = goal.description.trim();
  if (description) lines.push(description);
  return lines.join("\n");
}
