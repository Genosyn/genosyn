import {
  evaluateFormula,
  validateFormula,
  type ExploreFormula,
} from "../../shared/exploreFormula.js";
import { exploreScalarMeasure, type QueryResult, type VizConfig, type VizType } from "./explore.js";

export type DashboardChart = {
  id: string;
  slug: string;
  title: string;
  vizType: VizType;
  vizConfig: VizConfig;
};

export type DashboardCard = {
  id: string;
  dashboardId: string;
  chartId: string | null;
  formula: ExploreFormula | null;
  x: number;
  y: number;
  w: number;
  h: number;
  titleOverride: string;
};

export type DashboardRunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; result: QueryResult }
  | { kind: "error"; message: string };

/** Count each chain from its leaves so shared inputs never depend on card order. */
function dependencyDepths(cards: Map<string, DashboardCard>): Map<string, number> {
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const longest = new Map<string, number>();
  const depths = new Map<string, number>();
  const ready: string[] = [];
  for (const card of cards.values()) {
    const inputs = Array.isArray(card.formula?.inputs) ? card.formula.inputs : [];
    const dependencies = new Set(
      inputs.map((input) => input?.cardId).filter((id) => cards.has(id)),
    );
    remaining.set(card.id, dependencies.size);
    if (!dependencies.size) ready.push(card.id);
    for (const id of dependencies) {
      const parents = dependents.get(id) ?? [];
      parents.push(card.id);
      dependents.set(id, parents);
    }
  }
  // An iterative pass also handles oversized or cyclic saved graphs without
  // recursing through them. Cards left unresolved reach a dependency cycle.
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index];
    const depth = longest.get(id) ?? 1;
    depths.set(id, depth);
    for (const parent of dependents.get(id) ?? []) {
      longest.set(parent, Math.max(longest.get(parent) ?? 1, depth + 1));
      const count = remaining.get(parent)! - 1;
      remaining.set(parent, count);
      if (!count) ready.push(parent);
    }
  }
  return depths;
}

/** Derive formulas from the current card results; never keep a second, stale value cache. */
export function dashboardCardStates(
  cards: DashboardCard[],
  charts: DashboardChart[],
  runs: Record<string, DashboardRunState>,
): Map<string, DashboardRunState> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chartById = new Map(charts.map((chart) => [chart.id, chart]));
  const states = new Map<string, DashboardRunState>();
  const depths = dependencyDepths(byId);

  function resolve(id: string): DashboardRunState {
    const cached = states.get(id);
    if (cached) return cached;
    const card = byId.get(id);
    if (!card)
      return {
        kind: "error",
        message: "An input card was removed. Edit the formula to choose another input.",
      };
    let state: DashboardRunState;
    const depth = depths.get(id);
    if (depth === undefined) {
      state = {
        kind: "error",
        message: "Formula cards cannot reference themselves, even through another formula.",
      };
    } else if (depth > 32) {
      state = { kind: "error", message: "This formula has too many nested inputs." };
    } else if (card.formula) {
      try {
        validateFormula(card.formula);
        const values: Record<string, number> = Object.create(null);
        let pending: DashboardRunState | undefined;
        for (const input of card.formula.inputs) {
          const source = byId.get(input.cardId);
          const sourceChart = source?.chartId ? chartById.get(source.chartId) : undefined;
          const label = source?.titleOverride || sourceChart?.title || input.name;
          if (source && !source.formula && sourceChart?.vizType !== "scalar") {
            throw new Error(`${label} must be a Number card.`);
          }
          const inputState = resolve(input.cardId);
          if (inputState.kind === "error") throw new Error(`${label}: ${inputState.message}`);
          if (inputState.kind !== "ok") {
            pending = { kind: "running" };
            continue;
          }
          const row = inputState.result.rows[0];
          const measure = source?.formula
            ? "value"
            : exploreScalarMeasure(row, sourceChart?.vizConfig ?? {});
          const raw = row?.[measure];
          if (
            (typeof raw !== "number" && typeof raw !== "string") ||
            (typeof raw === "string" && !raw.trim()) ||
            !Number.isFinite(Number(raw))
          ) {
            throw new Error(`${label} has no numeric value.`);
          }
          values[input.name] = Number(raw);
        }
        state = pending ?? {
          kind: "ok",
          result: {
            fields: [{ name: "value" }],
            rows: [{ value: evaluateFormula(card.formula.expression, values) }],
            rowCount: 1,
            truncated: false,
          },
        };
      } catch (error) {
        state = {
          kind: "error",
          message: error instanceof Error ? error.message : "Could not calculate this formula.",
        };
      }
    } else {
      const chart = card.chartId ? chartById.get(card.chartId) : undefined;
      state = chart
        ? (runs[chart.slug] ?? { kind: "idle" })
        : { kind: "error", message: "Chart unavailable." };
    }
    states.set(id, state);
    return state;
  }
  for (const card of cards) resolve(card.id);
  return states;
}

/** A formula's refresh reruns each underlying Chart once, including nested formulas. */
export function formulaChartSlugs(
  cardId: string,
  cards: DashboardCard[],
  charts: DashboardChart[],
): string[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chartById = new Map(charts.map((chart) => [chart.id, chart]));
  const visited = new Set<string>();
  const slugs = new Set<string>();
  const pending = [cardId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (visited.has(id)) continue;
    visited.add(id);
    const card = byId.get(id);
    if (card?.formula) pending.push(...card.formula.inputs.map((input) => input.cardId));
    else if (card?.chartId) {
      const chart = chartById.get(card.chartId);
      if (chart) slugs.add(chart.slug);
    }
  }
  return [...slugs];
}
