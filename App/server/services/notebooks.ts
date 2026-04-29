import { AppDataSource } from "../db/datasource.js";
import { Notebook } from "../db/entities/Notebook.js";
import { toSlug } from "../lib/slug.js";

/**
 * Notebook helpers shared by the human-facing routes, the MCP tool surface,
 * and the company-create seed step. Slug uniqueness is enforced per company
 * (matching the Note convention) — collisions across the two namespaces
 * don't matter because URLs put them at different path depths.
 */

export async function uniqueNotebookSlug(
  companyId: string,
  base: string,
): Promise<string> {
  const repo = AppDataSource.getRepository(Notebook);
  let slug = base || "notebook";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/**
 * Idempotent default-notebook seed. Called from the company-create route so
 * a fresh company always has a place to file notes; safe to call again
 * because we no-op if the slug `general` already exists.
 */
export async function ensureDefaultNotebook(
  companyId: string,
  createdById: string | null,
): Promise<Notebook> {
  const repo = AppDataSource.getRepository(Notebook);
  const existing = await repo.findOneBy({ companyId, slug: "general" });
  if (existing) return existing;
  const nb = repo.create({
    companyId,
    title: "General",
    slug: "general",
    icon: "📚",
    sortOrder: 0,
    createdById,
    createdByEmployeeId: null,
  });
  await repo.save(nb);
  return nb;
}

export { toSlug };
