import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Run } from "../db/entities/Run.js";

/**
 * The **effect ledger** — what a Run actually changed, according to the server.
 *
 * Everything the platform believed about a Run used to come from the Run
 * itself. `status` says the agent loop returned. The transcript is the model
 * narrating its own work, and until M58 it did not even include tool results.
 * The outcome verdict is a second model reading that same narration. None of
 * those is evidence in the sense that matters: nothing in the chain is
 * produced by anything other than the thing being judged.
 *
 * This module is. Every mutation inside a company already writes an
 * `AuditEvent` at the write seam — the server's own record, written after the
 * change succeeded — and since M58 those rows carry the `runId` of the Run
 * whose token authorized them. Reading them back, in order, gives the one
 * account of a Run that the model had no hand in writing.
 *
 * Three consumers:
 *   - the `effect` {@link RoutineCheck} kind, which asserts over these counts;
 *   - the outcome checker, which is finally shown what happened rather than
 *     only what was claimed; and
 *   - a retrying Run, which is told what its previous attempt already did —
 *     retries are at-least-once for side effects, and attempt 2 used to start
 *     completely blind.
 */

/** One recorded change, flattened for rendering and counting. */
export type EffectRow = {
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string;
  at: Date;
};

/**
 * Most Runs write a handful of rows. The cap exists for the pathological one
 * — a bulk import loop — where rendering ten thousand lines into a model
 * prompt would be worse than saying "and 9,800 more".
 */
export const RUN_EFFECT_ROW_CAP = 200;

/** How far back the retry chain is walked. Well past `maxAttempts`' ceiling. */
const RETRY_CHAIN_DEPTH_CAP = 20;

/**
 * Every effect one Run recorded, oldest first.
 *
 * Ordering is by `createdAt`, which `recordAudit` stamps from JS at
 * millisecond resolution precisely so this list reads in the order things
 * happened (the column's SQLite default was whole seconds, which made every
 * row in a Run tie). `id` breaks a same-millisecond tie — arbitrary, but
 * stable, so the same Run never renders two different orders.
 *
 * Scoped by `runId` alone — the column is a uuid minted by this install and an
 * AuditEvent's `companyId` is written from the same request that wrote its
 * `runId`, so there is no cross-company row to exclude. Callers that hold a
 * company id may pass it; it narrows the index scan and costs nothing.
 */
export async function runEffects(
  runId: string,
  opts: { companyId?: string; limit?: number } = {},
): Promise<EffectRow[]> {
  if (!runId) return [];
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: opts.companyId ? { runId, companyId: opts.companyId } : { runId },
    order: { createdAt: "ASC", id: "ASC" },
    take: Math.max(1, opts.limit ?? RUN_EFFECT_ROW_CAP),
  });
  return rows.map((r) => ({
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    targetLabel: r.targetLabel,
    at: r.createdAt,
  }));
}

/** How many effects a Run recorded, without loading them. */
export async function countEffects(
  runId: string,
  filter: { action?: string; targetType?: string } = {},
): Promise<number> {
  if (!runId) return 0;
  const where: Record<string, string> = { runId };
  if (filter.action) where.action = filter.action;
  if (filter.targetType) where.targetType = filter.targetType;
  return AppDataSource.getRepository(AuditEvent).countBy(where);
}

/**
 * The effects of every earlier attempt in this Run's retry chain, oldest
 * attempt first.
 *
 * Walks `parentRunId` upward. Depth-capped and cycle-guarded: `parentRunId` is
 * a bare varchar with no foreign key, so a hand-edited row could point at
 * itself, and a lookup loop inside the runner would hang a Run rather than
 * fail it.
 */
export async function priorAttemptEffects(run: Pick<Run, "parentRunId">): Promise<EffectRow[]> {
  const runRepo = AppDataSource.getRepository(Run);
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = run.parentRunId;
  for (let depth = 0; cursor && depth < RETRY_CHAIN_DEPTH_CAP; depth++) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    chain.push(cursor);
    const parent = await runRepo.findOne({
      where: { id: cursor },
      select: { id: true, parentRunId: true },
    });
    cursor = parent?.parentRunId ?? null;
  }
  if (chain.length === 0) return [];
  // Oldest attempt first: the chain was walked newest-to-oldest.
  chain.reverse();
  const collected: EffectRow[] = [];
  for (const id of chain) {
    if (collected.length >= RUN_EFFECT_ROW_CAP) break;
    collected.push(...(await runEffects(id, { limit: RUN_EFFECT_ROW_CAP - collected.length })));
  }
  return collected;
}

/**
 * Render effects as a block for a model prompt.
 *
 * The header is load-bearing rather than decorative. Everything else a model
 * is shown about a Run arrives as untrusted transcript, and the checker is
 * explicitly told to treat it that way. These lines are the one part of the
 * evidence the server wrote itself, and saying so is what lets the checker
 * weigh them differently from the story beside them.
 */
export function renderEffectDigest(
  rows: EffectRow[],
  opts: { title?: string; empty?: string } = {},
): string {
  const title = opts.title ?? "What this Run actually changed (recorded by the server)";
  if (rows.length === 0) {
    return [
      `## ${title}`,
      opts.empty ??
        "Nothing. The server recorded no change to any company record during this Run.",
    ].join("\n");
  }
  const lines = rows.map((r) => {
    const target = r.targetLabel || r.targetId || r.targetType || "";
    return `- \`${r.action}\`${target ? ` — ${target}` : ""}`;
  });
  return [
    `## ${title}`,
    "The rows below were written by the server at each write seam, not by the model. They are what actually changed.",
    ...lines,
    ...(rows.length >= RUN_EFFECT_ROW_CAP
      ? [`- … the list is capped at ${RUN_EFFECT_ROW_CAP} entries.`]
      : []),
  ].join("\n");
}

/**
 * The block a retrying Run opens with.
 *
 * `Routine.maxAttempts` documents retries as at-least-once for side effects and
 * tells the operator to raise it only on work that is safe to repeat. That
 * warning stood alone because attempt 2 had no way to know what attempt 1 had
 * done. Now it does — and the instruction is deliberately "verify before
 * redoing", not "skip", because the ledger proves an action was recorded, not
 * that its downstream effect landed.
 */
export function renderPriorAttemptBlock(rows: EffectRow[], attempt: number): string | null {
  if (rows.length === 0) return null;
  return [
    `## What earlier attempts of this Run already did`,
    `This is attempt ${attempt}. Retries repeat side effects unless you stop them: the server recorded the changes below during earlier attempts. Verify each one before doing it again — do not assume it needs redoing, and do not assume it succeeded downstream.`,
    ...rows.map((r) => {
      const target = r.targetLabel || r.targetId || "";
      return `- \`${r.action}\`${target ? ` — ${target}` : ""}`;
    }),
  ].join("\n");
}
