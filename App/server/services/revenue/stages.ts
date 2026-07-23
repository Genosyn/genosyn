import { IsNull } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { DealStage, type DealStageKind } from "../../db/entities/DealStage.js";
import { toSlug } from "../../lib/slug.js";

/**
 * The company's sales process: an ordered list of {@link DealStage} rows.
 *
 * Seeded on first read rather than at company creation, matching how the
 * finance chart of accounts appears the first time somebody opens the books.
 * Seeding at creation would mean every company that never touches Revenue
 * carries seven rows it does not want, and would need a backfill migration for
 * every company that already exists.
 */

/**
 * A conventional B2B SaaS ladder. Opinionated on purpose: a board that arrives
 * empty asks the user to design a sales process before they have run one, and
 * most teams answer that question by copying this exact list anyway.
 *
 * Probabilities are the usual forecast weights. They are defaults, not claims —
 * a company that closes 80% of demos should edit them, and the UI says so.
 */
export const DEFAULT_DEAL_STAGES: Array<{
  name: string;
  probability: number;
  kind: DealStageKind;
  color: string;
  description: string;
}> = [
  {
    name: "New",
    probability: 10,
    kind: "open",
    color: "#94a3b8",
    description: "Identified, not yet worked.",
  },
  {
    name: "Qualified",
    probability: 25,
    kind: "open",
    color: "#38bdf8",
    description: "Real need, real budget, right person.",
  },
  {
    name: "Demo",
    probability: 40,
    kind: "open",
    color: "#818cf8",
    description: "They have seen the product.",
  },
  {
    name: "Proposal",
    probability: 60,
    kind: "open",
    color: "#a78bfa",
    description: "Pricing is with them.",
  },
  {
    name: "Negotiation",
    probability: 80,
    kind: "open",
    color: "#fbbf24",
    description: "Agreeing terms, security review, redlines.",
  },
  {
    name: "Closed Won",
    probability: 100,
    kind: "won",
    color: "#34d399",
    description: "Signed. Time to invoice.",
  },
  {
    name: "Closed Lost",
    probability: 0,
    kind: "lost",
    color: "#f87171",
    description: "Not this time. Record why.",
  },
];

/**
 * Every live stage for the company, in board order, seeding the default ladder
 * the first time anybody looks.
 *
 * The seed is written inside a transaction with a re-check, because two tabs
 * opening the board at once would otherwise each insert a full ladder and leave
 * the company with fourteen stages.
 */
export async function listDealStages(companyId: string): Promise<DealStage[]> {
  const repo = AppDataSource.getRepository(DealStage);
  const existing = await repo.find({
    where: { companyId, archivedAt: IsNull() },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  if (existing.length > 0) return existing;
  return seedDefaultStages(companyId);
}

/** Insert the default ladder. Safe to call concurrently — see the re-check. */
export async function seedDefaultStages(companyId: string): Promise<DealStage[]> {
  await AppDataSource.transaction(async (m) => {
    const already = await m.count(DealStage, { where: { companyId } });
    if (already > 0) return;
    const rows = DEFAULT_DEAL_STAGES.map((stage, index) =>
      m.create(DealStage, {
        companyId,
        name: stage.name,
        slug: toSlug(stage.name),
        sortOrder: index,
        probability: stage.probability,
        kind: stage.kind,
        color: stage.color,
        description: stage.description,
      }),
    );
    await m.save(rows);
  });
  return AppDataSource.getRepository(DealStage).find({
    where: { companyId, archivedAt: IsNull() },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
}

/** Look one up, scoped to the company. Archived stages resolve — a closed deal */
/** must not lose the name of the stage it closed in. */
export async function getDealStage(
  companyId: string,
  id: string,
): Promise<DealStage | null> {
  return AppDataSource.getRepository(DealStage).findOneBy({ id, companyId });
}

/** The stage a brand-new deal lands in: the first open stage in board order. */
export async function defaultStageFor(companyId: string): Promise<DealStage | null> {
  const stages = await listDealStages(companyId);
  return stages.find((s) => s.kind === "open") ?? stages[0] ?? null;
}

/**
 * Unique stage slug within one company.
 *
 * Archived stages still hold their slug, so a rename-then-recreate cycle does
 * not collide with history.
 */
export async function uniqueStageSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(DealStage);
  const root = toSlug(base) || "stage";
  let slug = root;
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

/**
 * Reorder the board. Takes the full ordered id list and rewrites `sortOrder`,
 * rather than accepting a single "move X to position N" — a drag-and-drop board
 * already knows the whole order, and applying it wholesale makes concurrent
 * drags converge instead of interleaving into nonsense.
 *
 * Ids not belonging to the company are ignored rather than rejected, so a stale
 * tab cannot fail the whole reorder.
 */
export async function reorderDealStages(
  companyId: string,
  orderedIds: string[],
): Promise<DealStage[]> {
  const repo = AppDataSource.getRepository(DealStage);
  const stages = await repo.findBy({ companyId });
  const byId = new Map(stages.map((s) => [s.id, s]));
  let index = 0;
  const touched: DealStage[] = [];
  for (const id of orderedIds) {
    const stage = byId.get(id);
    if (!stage) continue;
    stage.sortOrder = index;
    index += 1;
    touched.push(stage);
  }
  if (touched.length > 0) await repo.save(touched);
  return listDealStages(companyId);
}
