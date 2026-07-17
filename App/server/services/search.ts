import { SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Base } from "../db/entities/Base.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { Chart } from "../db/entities/Chart.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import { Customer } from "../db/entities/Customer.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { Role } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { Project } from "../db/entities/Project.js";
import { Resource } from "../db/entities/Resource.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { Todo } from "../db/entities/Todo.js";
import { listAccessibleProjectIds } from "./projects.js";

/**
 * Company-wide quick search — the data source behind the ⌘K palette's
 * entity results (the palette matches the static section catalog on the
 * client; this covers everything that lives in the database).
 *
 * Deliberately a *name* search: it matches the fields a person would type to
 * jump somewhere (titles, names, a customer's email), not document bodies.
 * Body search would drown the palette in weak hits; the per-section search
 * surfaces (e.g. `/notes/search`) stay the right tool for content queries.
 *
 * Same crude-LIKE stance as notes search: SQLite + a few thousand rows per
 * table is fine, and every query is capped. If this ever feels slow we can
 * wire FTS in.
 */

export type SearchResultKind =
  | "employee"
  | "skill"
  | "routine"
  | "channel"
  | "project"
  | "todo"
  | "base"
  | "notebook"
  | "note"
  | "resource"
  | "chart"
  | "dashboard"
  | "repo"
  | "pipeline"
  | "customer";

export type CompanySearchResult = {
  kind: SearchResultKind;
  id: string;
  label: string;
  sublabel: string | null;
  /**
   * Client route under `/c/<companySlug>` that opens this result. Computed
   * here so the client keeps a single kind→icon mapping instead of fifteen
   * kind→URL builders; if a client route moves, update the matching
   * `path:` below in the same PR.
   */
  path: string;
};

/** How many rows each entity query fetches for JS-side ranking. */
const FETCH_WINDOW = 20;
/** How many results one kind may contribute. */
const PER_KIND_CAP = 5;
/** How many results the whole response may carry. */
const TOTAL_CAP = 30;
/**
 * How many query tokens participate. Each token adds a LIKE per searched
 * column to fifteen table scans, so an unbounded 200-char query of 1-char
 * words would be an easy way to pin the (synchronous, on sqlite) driver.
 * Nobody types nine words to find a name.
 */
const MAX_TOKENS = 8;

/** One query token in both casings the SQL needs — see `andWhereTokens`. */
type Token = { lo: string; raw: string };

/** Escape `%`, `_`, and `\` so user input matches literally inside LIKE. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => "\\" + c);
}

/**
 * Require every whitespace-separated token of the query to appear in at
 * least one of `cols`. Tokens AND together, columns OR together — "acme
 * invoice" should match a row named "Invoice run — Acme" regardless of
 * word order.
 *
 * Case-folding is two-pronged because SQLite's LOWER() (no ICU) folds only
 * ASCII: `LOWER(col) LIKE :lowercased` handles ASCII case on both drivers,
 * and `col LIKE :as-typed` lets a non-ASCII query ("Café", "Отчёт") match
 * verbatim on sqlite too. The one gap left: uppercase non-ASCII *stored*
 * text queried in lowercase won't match on sqlite (it will on postgres) —
 * closing that needs ICU or a normalized shadow column; not worth it here.
 */
function andWhereTokens<T extends object>(
  qb: SelectQueryBuilder<T>,
  cols: string[],
  tokens: Token[],
): SelectQueryBuilder<T> {
  tokens.forEach((tok, i) => {
    const variants = [`LOWER(%c) LIKE :tokLo${i} ESCAPE '\\'`];
    const params: Record<string, string> = {
      [`tokLo${i}`]: `%${escapeLike(tok.lo)}%`,
    };
    if (tok.raw !== tok.lo) {
      variants.push(`%c LIKE :tokRaw${i} ESCAPE '\\'`);
      params[`tokRaw${i}`] = `%${escapeLike(tok.raw)}%`;
    }
    const clause = cols
      .flatMap((col) => variants.map((v) => v.replaceAll("%c", col)))
      .join(" OR ");
    qb = qb.andWhere(`(${clause})`, params);
  });
  return qb;
}

/**
 * `getRawMany` bypasses TypeORM's hydration, and on sqlite datetime columns
 * come back as UTC strings without a timezone marker ("2026-07-17 10:00:00")
 * that `new Date()` would misread as *local* time. Re-attach the T/Z the
 * same way the driver's own hydration does. Postgres hands us Date objects
 * either way.
 */
function rawDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" && !v.includes("T")) {
    return new Date(v.replace(" ", "T") + "Z");
  }
  return new Date(v as string);
}

/**
 * Fetch-window ordering: prefix matches on the primary column first, so a
 * table with more than `FETCH_WINDOW` substring hits can't starve the rows
 * the ranker would put on top anyway. Recency (or name) breaks ties.
 */
function orderByPrefixFirst<T extends object>(
  qb: SelectQueryBuilder<T>,
  col: string,
  q: string,
  recencyCol: string | null,
): SelectQueryBuilder<T> {
  qb = qb
    .setParameter("prefix", `${escapeLike(q)}%`)
    .orderBy(`CASE WHEN LOWER(${col}) LIKE :prefix ESCAPE '\\' THEN 0 ELSE 1 END`, "ASC");
  // NULLS LAST: postgres sorts NULL as largest (first under DESC), sqlite
  // as smallest — without this, never-touched rows would hog the window on
  // postgres only. Matters for the one nullable recency column
  // (Channel.lastMessageAt); harmless on the NOT NULL updatedAt columns.
  if (recencyCol) qb = qb.addOrderBy(recencyCol, "DESC", "NULLS LAST");
  return qb.addOrderBy(col, "ASC").limit(FETCH_WINDOW);
}

// ─────────────────────────── ranking ───────────────────────────

type Scored = CompanySearchResult & {
  score: number;
  updatedAt: Date | null;
};

/**
 * Rank a label against the query. Mirrors the tiers the palette uses for
 * sections (exact > prefix > word boundary > substring) so a section hit
 * and an entity hit for the same text sort the same way everywhere.
 */
function scoreLabel(label: string, q: string, tokens: Token[]): number {
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 90;
  const at = l.indexOf(q);
  if (at > 0 && !/[a-z0-9]/.test(l[at - 1])) return 80;
  if (at > 0) return 65;
  // The full query missed but every token hit (SQL guarantees each token
  // matched *some* searched column — this bonus is for all-in-the-label).
  if (tokens.length > 1 && tokens.every((t) => l.includes(t.lo))) return 55;
  return 40; // matched via a secondary column (email, topic, role, …)
}

// ─────────────────────────── per-kind queries ───────────────────────────

type Ctx = { companyId: string; q: string; tokens: Token[] };

/**
 * The bulk of the catalog: entities with a direct `companyId` column whose
 * result is `name/title` + `slug`. The joined kinds (skills, routines,
 * notes, todos, channels) get bespoke queries below.
 */
type SimpleSpec = {
  kind: SearchResultKind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entity: new () => any;
  nameCol: "name" | "title";
  /** Extra columns the tokens may match (never displayed as the label). */
  secondaryCols?: string[];
  /** Rows are excluded when `archivedAt` is set. */
  softDeletes?: boolean;
  hasUpdatedAt?: boolean;
  path: (r: Record<string, string>) => string;
  sublabel: (r: Record<string, string>) => string | null;
};

const SIMPLE_SPECS: SimpleSpec[] = [
  {
    kind: "employee",
    entity: AIEmployee,
    nameCol: "name",
    secondaryCols: ["t.role"],
    path: (r) => `/employees/${r.slug}`,
    sublabel: (r) => r.role || null,
  },
  {
    kind: "base",
    entity: Base,
    nameCol: "name",
    path: (r) => `/bases/${r.slug}`,
    sublabel: (r) => r.description || null,
  },
  {
    kind: "notebook",
    entity: Notebook,
    nameCol: "title",
    hasUpdatedAt: true,
    path: (r) => `/notes/${r.slug}`,
    sublabel: () => null,
  },
  {
    kind: "resource",
    entity: Resource,
    nameCol: "title",
    hasUpdatedAt: true,
    path: (r) => `/resources/${r.slug}`,
    sublabel: (r) => r.sourceKind || null,
  },
  {
    kind: "chart",
    entity: Chart,
    nameCol: "title",
    hasUpdatedAt: true,
    path: (r) => `/explore/charts/${r.slug}`,
    sublabel: (r) => r.description || null,
  },
  {
    kind: "dashboard",
    entity: Dashboard,
    nameCol: "title",
    hasUpdatedAt: true,
    path: (r) => `/explore/dashboards/${r.slug}`,
    sublabel: (r) => r.description || null,
  },
  {
    kind: "customer",
    entity: Customer,
    nameCol: "name",
    secondaryCols: ["t.email"],
    softDeletes: true,
    hasUpdatedAt: true,
    path: (r) => `/customers/${r.slug}`,
    sublabel: (r) => r.email || null,
  },
  {
    kind: "repo",
    entity: CodeRepository,
    nameCol: "name",
    hasUpdatedAt: true,
    path: (r) => `/code/${r.slug}`,
    sublabel: (r) => r.gitUrl || null,
  },
  {
    kind: "pipeline",
    entity: Pipeline,
    nameCol: "name",
    hasUpdatedAt: true,
    path: (r) => `/pipelines/${r.slug}`,
    sublabel: (r) => r.description || null,
  },
];

async function searchSimple(ctx: Ctx, spec: SimpleSpec): Promise<Scored[]> {
  let qb = AppDataSource.getRepository(spec.entity)
    .createQueryBuilder("t")
    .where("t.companyId = :cid", { cid: ctx.companyId });
  if (spec.softDeletes) qb = qb.andWhere("t.archivedAt IS NULL");
  qb = andWhereTokens(
    qb,
    [`t.${spec.nameCol}`, ...(spec.secondaryCols ?? [])],
    ctx.tokens,
  );
  qb = orderByPrefixFirst(
    qb,
    `t.${spec.nameCol}`,
    ctx.q,
    spec.hasUpdatedAt ? "t.updatedAt" : null,
  );
  const rows: Record<string, string>[] = await qb.getMany();
  return rows.map((r) => ({
    kind: spec.kind,
    id: r.id,
    label: r[spec.nameCol],
    sublabel: spec.sublabel(r),
    path: spec.path(r),
    score: scoreLabel(r[spec.nameCol], ctx.q, ctx.tokens),
    updatedAt: spec.hasUpdatedAt
      ? (r as Record<string, unknown>).updatedAt as Date
      : null,
  }));
}

/** Projects, filtered to the ones this member may read. */
async function searchProjects(
  ctx: Ctx,
  accessibleIds: Set<string>,
): Promise<Scored[]> {
  if (accessibleIds.size === 0) return [];
  let qb = AppDataSource.getRepository(Project)
    .createQueryBuilder("p")
    .where("p.companyId = :cid", { cid: ctx.companyId })
    .andWhere("p.id IN (:...pids)", { pids: [...accessibleIds] });
  qb = andWhereTokens(qb, ["p.name", "p.key"], ctx.tokens);
  qb = orderByPrefixFirst(qb, "p.name", ctx.q, null);
  const rows = await qb.getMany();
  return rows.map((p) => ({
    kind: "project" as const,
    id: p.id,
    label: p.name,
    sublabel: p.key || null,
    path: `/tasks/p/${p.slug}`,
    score: scoreLabel(p.name, ctx.q, ctx.tokens),
    updatedAt: null,
  }));
}

/**
 * Todos land on their project's board — a todo has no URL of its own, so
 * ↵ takes you to the board and the sublabel carries the ticket number to
 * find it by. Cancelled todos stay out: nobody types ⌘K to reach work
 * that was called off.
 */
async function searchTodos(
  ctx: Ctx,
  accessibleIds: Set<string>,
): Promise<Scored[]> {
  if (accessibleIds.size === 0) return [];
  let qb = AppDataSource.getRepository(Todo)
    .createQueryBuilder("t")
    .innerJoin(Project, "p", "p.id = t.projectId")
    .where("p.companyId = :cid", { cid: ctx.companyId })
    .andWhere("t.projectId IN (:...pids)", { pids: [...accessibleIds] })
    .andWhere("t.status != 'cancelled'");
  qb = andWhereTokens(qb, ["t.title"], ctx.tokens);
  qb = orderByPrefixFirst(qb, "t.title", ctx.q, "t.updatedAt")
    .select("t.id", "id")
    .addSelect("t.title", "label")
    .addSelect("t.number", "number")
    .addSelect("t.updatedAt", "updatedAt")
    .addSelect("p.key", "projectKey")
    .addSelect("p.name", "projectName")
    .addSelect("p.slug", "projectSlug");
  const rows = await qb.getRawMany();
  return rows.map((r) => ({
    kind: "todo" as const,
    id: r.id,
    label: r.label,
    sublabel: `${r.projectKey}-${r.number} · ${r.projectName}`,
    path: `/tasks/p/${r.projectSlug}`,
    score: scoreLabel(r.label, ctx.q, ctx.tokens),
    updatedAt: rawDate(r.updatedAt),
  }));
}

/** Skills and Routines scope to the company through their employee. */
async function searchEmployeeChildren(
  ctx: Ctx,
  kind: "skill" | "routine",
): Promise<Scored[]> {
  let qb = AppDataSource.getRepository(kind === "skill" ? Skill : Routine)
    .createQueryBuilder("s")
    .innerJoin(AIEmployee, "e", "e.id = s.employeeId")
    .where("e.companyId = :cid", { cid: ctx.companyId });
  qb = andWhereTokens(qb, ["s.name"], ctx.tokens);
  qb = orderByPrefixFirst(qb, "s.name", ctx.q, null)
    .select("s.id", "id")
    .addSelect("s.name", "label")
    .addSelect("s.slug", "slug")
    .addSelect("e.slug", "empSlug")
    .addSelect("e.name", "empName");
  const rows = await qb.getRawMany();
  return rows.map((r) => ({
    kind,
    id: r.id,
    label: r.label,
    sublabel: r.empName || null,
    path: `/${kind === "skill" ? "skills" : "routines"}/${r.empSlug}/${r.slug}`,
    score: scoreLabel(r.label, ctx.q, ctx.tokens),
    updatedAt: null,
  }));
}

/** Notes link through their notebook (the URL carries both slugs). */
async function searchNotes(ctx: Ctx): Promise<Scored[]> {
  let qb = AppDataSource.getRepository(Note)
    .createQueryBuilder("n")
    .innerJoin(Notebook, "nb", "nb.id = n.notebookId")
    .where("n.companyId = :cid", { cid: ctx.companyId })
    .andWhere("n.archivedAt IS NULL");
  qb = andWhereTokens(qb, ["n.title"], ctx.tokens);
  qb = orderByPrefixFirst(qb, "n.title", ctx.q, "n.updatedAt")
    .select("n.id", "id")
    .addSelect("n.title", "label")
    .addSelect("n.slug", "slug")
    .addSelect("n.updatedAt", "updatedAt")
    .addSelect("nb.slug", "nbSlug")
    .addSelect("nb.title", "nbTitle");
  const rows = await qb.getRawMany();
  return rows.map((r) => ({
    kind: "note" as const,
    id: r.id,
    label: r.label,
    sublabel: r.nbTitle || null,
    path: `/notes/${r.nbSlug}/${r.slug}`,
    score: scoreLabel(r.label, ctx.q, ctx.tokens),
    updatedAt: rawDate(r.updatedAt),
  }));
}

/**
 * Channels a member may see: public ones, plus private ones they belong
 * to — the same rule `listChannelsForUser` applies, folded into SQL. DMs
 * are skipped (their `name` is null; they're people, not destinations).
 */
async function searchChannels(ctx: Ctx, userId: string): Promise<Scored[]> {
  let qb = AppDataSource.getRepository(Channel)
    .createQueryBuilder("c")
    .leftJoin(
      ChannelMember,
      "cm",
      "cm.channelId = c.id AND cm.userId = :uid",
      { uid: userId },
    )
    .where("c.companyId = :cid", { cid: ctx.companyId })
    .andWhere("c.archivedAt IS NULL")
    .andWhere("c.kind != 'dm'")
    .andWhere("(c.kind = 'public' OR cm.id IS NOT NULL)");
  qb = andWhereTokens(qb, ["c.name", "c.topic"], ctx.tokens);
  qb = orderByPrefixFirst(qb, "c.name", ctx.q, "c.lastMessageAt")
    .select("c.id", "id")
    .addSelect("c.name", "label")
    .addSelect("c.topic", "topic")
    .addSelect("c.lastMessageAt", "lastMessageAt");
  const rows = await qb.getRawMany();
  return rows.map((r) => ({
    kind: "channel" as const,
    id: r.id,
    label: `#${r.label}`,
    sublabel: r.topic || null,
    path: `/workspace/${r.id}`,
    // Score against the bare name — the query won't carry our # prefix.
    score: scoreLabel(r.label, ctx.q, ctx.tokens),
    updatedAt: rawDate(r.lastMessageAt),
  }));
}

// ─────────────────────────── entry point ───────────────────────────

export async function searchCompany(opts: {
  companyId: string;
  userId: string;
  role: Role;
  query: string;
}): Promise<CompanySearchResult[]> {
  const qRaw = opts.query.trim();
  const q = qRaw.toLowerCase();
  // One character matches half the database; the palette gates the same way.
  if (q.length < 2) return [];
  const tokens: Token[] = qRaw
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map((raw) => ({ raw, lo: raw.toLowerCase() }));
  const ctx: Ctx = { companyId: opts.companyId, q, tokens };

  const accessibleProjects = await listAccessibleProjectIds(opts.companyId, {
    kind: "user",
    id: opts.userId,
    role: opts.role,
  });

  const perKind = await Promise.all([
    ...SIMPLE_SPECS.map((spec) => searchSimple(ctx, spec)),
    searchEmployeeChildren(ctx, "skill"),
    searchEmployeeChildren(ctx, "routine"),
    searchNotes(ctx),
    searchProjects(ctx, accessibleProjects),
    searchTodos(ctx, accessibleProjects),
    searchChannels(ctx, opts.userId),
  ]);

  const merged: Scored[] = [];
  for (const results of perKind) {
    merged.push(
      ...results
        .sort(byRank)
        .slice(0, PER_KIND_CAP),
    );
  }
  return merged
    .sort(byRank)
    .slice(0, TOTAL_CAP)
    .map(({ kind, id, label, sublabel, path }) => ({
      kind,
      id,
      label,
      sublabel,
      path,
    }));
}

function byRank(a: Scored, b: Scored): number {
  if (a.score !== b.score) return b.score - a.score;
  const at = a.updatedAt?.getTime() ?? 0;
  const bt = b.updatedAt?.getTime() ?? 0;
  if (at !== bt) return bt - at;
  return a.label.localeCompare(b.label);
}
