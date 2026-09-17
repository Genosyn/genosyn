import { In, type EntityManager } from "typeorm";
import { type ExploreFormula, validateFormula } from "../../shared/exploreFormula.js";
import { AppDataSource } from "../db/datasource.js";
import { Chart } from "../db/entities/Chart.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";

export class DashboardCardError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function parseDashboardFormula(json: string | null): ExploreFormula | null {
  if (!json) return null;
  try {
    const formula = JSON.parse(json) as ExploreFormula;
    validateFormula(formula);
    return formula;
  } catch {
    return null;
  }
}

type CardLayout = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  titleOverride?: string;
};

type CreateCard = CardLayout & { chartId?: string; formula?: ExploreFormula };
type PatchCard = CardLayout & { formula?: ExploreFormula };

const pendingWrites = new Map<string, Promise<DashboardCard>>();

/** Keep graph validation and its write together, including across SaaS replicas. */
async function writeDashboardCard(
  dashboard: Dashboard,
  write: (manager: EntityManager) => Promise<DashboardCard>,
): Promise<DashboardCard> {
  const previous = pendingWrites.get(dashboard.id);
  const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
    if (AppDataSource.options.type === "postgres") {
      return AppDataSource.transaction(async (manager) => {
        const locked = await manager.getRepository(Dashboard).findOne({
          where: { id: dashboard.id, companyId: dashboard.companyId },
          lock: { mode: "pessimistic_write" },
        });
        if (!locked) throw new DashboardCardError("Dashboard not found", 404);
        return write(manager);
      });
    }
    // SQLite is single-process; a queue avoids overlapping transactions on
    // its shared connection while protecting concurrent formula edits.
    return write(AppDataSource.manager);
  });
  pendingWrites.set(dashboard.id, current);
  try {
    return await current;
  } finally {
    if (pendingWrites.get(dashboard.id) === current) pendingWrites.delete(dashboard.id);
  }
}

/**
 * Formula bindings stay within a Dashboard and end at scalar Charts belonging
 * to the same company. Actual values are checked when the dashboard runs: a
 * scalar Chart may still return a null, text value, or failed query.
 */
async function validateDashboardFormula(
  dashboard: Dashboard,
  formula: ExploreFormula,
  manager: EntityManager,
  cardId?: string,
): Promise<void> {
  try {
    validateFormula(formula);
  } catch (error) {
    throw new DashboardCardError(error instanceof Error ? error.message : "Invalid formula");
  }
  const cards = await manager.getRepository(DashboardCard).findBy({
    dashboardId: dashboard.id,
  });
  const byId = new Map(cards.map((card) => [card.id, card]));
  const chartIds = cards.flatMap((card) => (card.chartId ? [card.chartId] : []));
  const charts = chartIds.length
    ? await manager.getRepository(Chart).findBy({
        id: In(chartIds),
        companyId: dashboard.companyId,
      })
    : [];
  const byChartId = new Map(charts.map((chart) => [chart.id, chart]));
  const rootId = cardId ?? "new-formula";
  const visiting = new Set<string>();
  const depths = new Map<string, number>();
  const formulas = new Map(cards.map((card) => [card.id, parseDashboardFormula(card.formulaJson)]));
  formulas.set(rootId, formula);

  function visit(id: string, requireValidInputs: boolean): number {
    if (visiting.has(id)) {
      throw new DashboardCardError("Formula cards cannot reference themselves or form a cycle");
    }
    const knownDepth = depths.get(id);
    if (visiting.size + (knownDepth ?? 1) > 32) {
      throw new DashboardCardError("Formula dependencies can contain at most 32 cards in a chain");
    }
    if (knownDepth !== undefined) return knownDepth;
    const source = byId.get(id);
    if (!source && id !== rootId) {
      if (requireValidInputs)
        throw new DashboardCardError("Choose input cards from this dashboard");
      return 1;
    }
    let depth = 1;
    if (source?.chartId && id !== rootId) {
      if (requireValidInputs && byChartId.get(source.chartId)?.vizType !== "scalar") {
        throw new DashboardCardError("Formula inputs must be Number or formula cards");
      }
    } else {
      const nested = formulas.get(id);
      if (!nested) {
        if (requireValidInputs)
          throw new DashboardCardError("An input card has an invalid formula");
        return 1;
      }
      visiting.add(id);
      for (const input of nested.inputs)
        depth = Math.max(depth, 1 + visit(input.cardId, requireValidInputs));
      visiting.delete(id);
    }
    depths.set(id, depth);
    return depth;
  }

  visit(rootId, true);
  // Updating a formula can lengthen the chain of an existing dependent card.
  // Validate those incoming paths too; unrelated broken cards stay editable.
  const dependents = new Map<string, string[]>();
  for (const [id, candidate] of formulas) {
    for (const input of candidate?.inputs ?? []) {
      const ids = dependents.get(input.cardId) ?? [];
      ids.push(id);
      dependents.set(input.cardId, ids);
    }
  }
  const affected = new Set([rootId]);
  for (const id of affected) {
    for (const dependentId of dependents.get(id) ?? []) affected.add(dependentId);
  }
  // A dependent may already have a removed sibling input. Its structural
  // depth still matters, but repairing that sibling is a separate edit.
  for (const id of affected) visit(id, false);
}

function formulaTitle(value: string | undefined): string {
  const title = value?.trim() ?? "";
  if (!title) throw new DashboardCardError("Give the formula card a title");
  return title;
}

export async function createDashboardCard(
  dashboard: Dashboard,
  body: CreateCard,
): Promise<DashboardCard> {
  return writeDashboardCard(dashboard, (manager) => createCard(dashboard, body, manager));
}

async function createCard(
  dashboard: Dashboard,
  body: CreateCard,
  manager: EntityManager,
): Promise<DashboardCard> {
  const repo = manager.getRepository(DashboardCard);
  if (Boolean(body.chartId) === Boolean(body.formula)) {
    throw new DashboardCardError("Choose either a Chart or a formula");
  }
  if (body.chartId) {
    const chart = await manager.getRepository(Chart).findOneBy({
      id: body.chartId,
      companyId: dashboard.companyId,
    });
    if (!chart) throw new DashboardCardError("Unknown chart");
    if (await repo.existsBy({ dashboardId: dashboard.id, chartId: chart.id })) {
      throw new DashboardCardError("Chart is already on this dashboard", 409);
    }
  }
  if (body.formula) await validateDashboardFormula(dashboard, body.formula, manager);
  const existing = body.y === undefined ? await repo.findBy({ dashboardId: dashboard.id }) : [];
  const row = repo.create({
    dashboardId: dashboard.id,
    chartId: body.chartId ?? null,
    formulaJson: body.formula ? JSON.stringify(body.formula) : null,
    x: body.x ?? 0,
    y: body.y ?? existing.reduce((bottom, card) => Math.max(bottom, card.y + card.h), 0),
    w: body.w ?? 6,
    h: body.h ?? 4,
    titleOverride: body.formula ? formulaTitle(body.titleOverride) : (body.titleOverride ?? ""),
  });
  return repo.save(row);
}

export async function patchDashboardCard(
  dashboard: Dashboard,
  cardId: string,
  body: PatchCard,
): Promise<DashboardCard> {
  return writeDashboardCard(dashboard, (manager) => patchCard(dashboard, cardId, body, manager));
}

async function patchCard(
  dashboard: Dashboard,
  cardId: string,
  body: PatchCard,
  manager: EntityManager,
): Promise<DashboardCard> {
  const repo = manager.getRepository(DashboardCard);
  const card = await repo.findOneBy({ id: cardId, dashboardId: dashboard.id });
  if (!card) throw new DashboardCardError("Card not found", 404);
  if (body.formula) {
    if (card.chartId) throw new DashboardCardError("Only formula cards can have a formula");
    await validateDashboardFormula(dashboard, body.formula, manager, card.id);
    card.formulaJson = JSON.stringify(body.formula);
  }
  if (body.titleOverride !== undefined) {
    card.titleOverride = card.chartId ? body.titleOverride : formulaTitle(body.titleOverride);
  }
  if (body.x !== undefined) card.x = body.x;
  if (body.y !== undefined) card.y = body.y;
  if (body.w !== undefined) card.w = body.w;
  if (body.h !== undefined) card.h = body.h;
  return repo.save(card);
}
