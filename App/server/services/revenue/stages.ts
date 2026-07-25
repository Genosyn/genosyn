import { IsNull } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Deal } from "../../db/entities/Deal.js";
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
export async function getDealStage(companyId: string, id: string): Promise<DealStage | null> {
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

export type DealStageCreate = {
  name: string;
  probability?: number;
  kind?: DealStageKind;
  color?: string;
  description?: string;
};

export async function createDealStage(
  companyId: string,
  input: DealStageCreate,
): Promise<DealStage> {
  const repo = AppDataSource.getRepository(DealStage);
  const last = await repo.findOne({
    where: { companyId },
    order: { sortOrder: "DESC" },
  });
  return repo.save(
    repo.create({
      companyId,
      name: input.name.trim(),
      slug: await uniqueStageSlug(companyId, input.name),
      sortOrder: (last?.sortOrder ?? -1) + 1,
      probability: input.probability ?? 0,
      kind: input.kind ?? "open",
      color: input.color ?? "",
      description: input.description ?? "",
      archivedAt: null,
    }),
  );
}

/**
 * Stage kind is intentionally immutable after creation. It determines every
 * Deal's derived status, and changing a populated stage from open to won would
 * silently close records without the stage-change Activities the reports read.
 */
export async function updateDealStage(
  companyId: string,
  id: string,
  patch: Partial<Omit<DealStageCreate, "kind">>,
): Promise<DealStage | null> {
  const repo = AppDataSource.getRepository(DealStage);
  const stage = await repo.findOneBy({ companyId, id });
  if (!stage) return null;
  if (patch.name !== undefined) stage.name = patch.name.trim();
  if (patch.probability !== undefined) stage.probability = patch.probability;
  if (patch.color !== undefined) stage.color = patch.color;
  if (patch.description !== undefined) stage.description = patch.description;
  return repo.save(stage);
}

export async function archiveDealStage(
  companyId: string,
  id: string,
  now = new Date(),
): Promise<{ stage: DealStage | null; openDealCount: number }> {
  const repo = AppDataSource.getRepository(DealStage);
  const stage = await repo.findOneBy({ companyId, id });
  if (!stage) return { stage: null, openDealCount: 0 };
  const openDealCount = await AppDataSource.getRepository(Deal).countBy({
    companyId,
    stageId: stage.id,
    status: "open",
    archivedAt: IsNull(),
  });
  if (openDealCount > 0) return { stage, openDealCount };
  stage.archivedAt = now;
  return { stage: await repo.save(stage), openDealCount: 0 };
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
