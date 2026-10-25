import { In, type EntityTarget, type ObjectLiteral, type SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import type { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Base } from "../../db/entities/Base.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Chart } from "../../db/entities/Chart.js";
import { Dashboard } from "../../db/entities/Dashboard.js";
import { EmployeeBaseGrant } from "../../db/entities/EmployeeBaseGrant.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { EmployeeChartGrant } from "../../db/entities/EmployeeChartGrant.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { EmployeeDashboardGrant } from "../../db/entities/EmployeeDashboardGrant.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeMarketingGrant } from "../../db/entities/EmployeeMarketingGrant.js";
import { EmployeeMemberBrowserGrant } from "../../db/entities/EmployeeMemberBrowserGrant.js";
import { EmployeeNoteGrant } from "../../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../../db/entities/EmployeeNotebookGrant.js";
import { EmployeeRecruitingGrant } from "../../db/entities/EmployeeRecruitingGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeResourceGrant } from "../../db/entities/EmployeeResourceGrant.js";
import { EmployeeResourceLibraryGrant } from "../../db/entities/EmployeeResourceLibraryGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { EmployeeRoutineGrant } from "../../db/entities/EmployeeRoutineGrant.js";
import { EmployeeSigningGrant } from "../../db/entities/EmployeeSigningGrant.js";
import { EmployeeDataRoomGrant } from "../../db/entities/EmployeeDataRoomGrant.js";
import { EmployeeVaultGrant } from "../../db/entities/EmployeeVaultGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MemberBrowser } from "../../db/entities/MemberBrowser.js";
import { Note } from "../../db/entities/Note.js";
import { Notebook } from "../../db/entities/Notebook.js";
import { Repository } from "../../db/entities/Repository.js";
import { Resource } from "../../db/entities/Resource.js";
import { User } from "../../db/entities/User.js";
import { getProvider, getRetiredProvider } from "../../integrations/index.js";
import { andWhereTokens, tokenizeQuery, type Token } from "../likeSearch.js";
import { effectiveResourceLibraryAccess } from "../resourceLibraryAccess.js";
import { effectiveRoutineAccess } from "../routineAccess.js";
import { listVaultItems } from "../vault.js";
import {
  ACCESS_KINDS,
  ACCESS_KIND_META,
  ACCESS_LIST_LIMIT,
  accessItemKey,
  accessLevelValues,
  type AccessGrantState,
  type AccessInherited,
  type AccessItem,
  type AccessKind,
  type AccessKindStatus,
  type EmployeeAccessListing,
} from "../../../shared/employeeAccess.js";
import {
  kindChangeReason,
  kindGrantHidden,
  kindUnavailableReason,
  memberBrowserChangeReason,
  vaultChangeReason,
  type AccessViewer,
} from "./rules.js";

/**
 * Everything the company has that can be granted, and what one AI Employee
 * holds of it — the Access page's one read.
 *
 * Each kind reads its own table, scoped to the company, and the employee's
 * Grants of that kind by `employeeId` (every Grant table is indexed on it).
 * The reads stay bounded on a large company (AGENTS.md §7): a kind lists at
 * most {@link ACCESS_LIST_LIMIT} rows, walked in the order of an index that
 * starts with `companyId` so the limit stops the walk rather than a sort over
 * every row, and a search reaches the rest. Rows the employee holds a Grant on
 * are always listed, read by primary key, whether or not they fall inside the
 * limit. `listingQueryPlans.test.ts` explains every statement this sends.
 *
 * Notes keep their body before `archivedAt`, so "not in the trash" cannot be
 * filtered in the walk without reading every page's text. The walk reads only
 * the columns before the body, and the trash check reads `archivedAt` for the
 * rows that walk returned, by primary key — never for the whole company.
 *
 * Who may see and change each row follows the kind's own rules (`rules.ts`);
 * the listing only reports them. Nothing here writes.
 */

export type ListEmployeeAccessArgs = {
  companyId: string;
  employee: Pick<AIEmployee, "id" | "name" | "slug">;
  viewer: AccessViewer;
  /** Words every listed row's name (or second line) contains. */
  query?: string;
  /** Rows per kind; {@link ACCESS_LIST_LIMIT} unless a test needs fewer. */
  limit?: number;
};

type KindListing = { items: AccessItem[]; truncated: boolean };

type Context = {
  companyId: string;
  employeeId: string;
  viewer: AccessViewer;
  tokens: Token[];
  limit: number;
};

/** How many index pages the notes walk may read to fill one page of live notes. */
const NOTE_WALK_PAGES = 4;
/** Deepest sub-page a note Grant is followed down to. */
const NOTE_INHERIT_DEPTH = 32;
/** The most sub-pages followed down from note Grants in one listing. */
const NOTE_INHERIT_BUDGET = 20_000;
/** Ids per `IN (…)` list: held rows, the trash check, a page's sub-pages. */
const IN_CHUNK = 400;

export async function listEmployeeAccess(
  args: ListEmployeeAccessArgs,
): Promise<EmployeeAccessListing> {
  const ctx: Context = {
    companyId: args.companyId,
    employeeId: args.employee.id,
    viewer: args.viewer,
    tokens: tokenizeQuery(args.query ?? ""),
    limit: Math.max(1, args.limit ?? ACCESS_LIST_LIMIT),
  };

  const items: AccessItem[] = [];
  const kinds: AccessKindStatus[] = [];
  // One kind at a time: SQLite answers on the event loop, so running them side
  // by side would only interleave the same work.
  for (const kind of ACCESS_KINDS) {
    const unavailable = kindUnavailableReason(kind, ctx.viewer);
    if (unavailable) {
      kinds.push({ kind, truncated: false, unavailable });
      continue;
    }
    const listing = await LOADERS[kind](ctx);
    items.push(...listing.items);
    kinds.push({ kind, truncated: listing.truncated, unavailable: null });
  }

  return {
    employee: { id: args.employee.id, name: args.employee.name, slug: args.employee.slug },
    items,
    kinds,
    limit: ctx.limit,
  };
}

// ─────────────────────────────── row building ───────────────────────────────

function item(
  ctx: Context,
  kind: AccessKind,
  fields: {
    resourceId: string | null;
    label: string;
    detail?: string | null;
    href: string | null;
    grant: AccessGrantState | null;
    inherited?: AccessInherited | null;
    hidden?: boolean;
    reason?: string | null;
  },
): AccessItem {
  const hidden = fields.hidden ?? kindGrantHidden(kind, ctx.viewer);
  const reason = fields.reason !== undefined ? fields.reason : kindChangeReason(kind, ctx.viewer);
  return {
    key: accessItemKey(kind, fields.resourceId),
    kind,
    resourceId: fields.resourceId,
    label: fields.label,
    detail: fields.detail ?? null,
    href: fields.href,
    grant: hidden ? null : fields.grant,
    inherited: hidden ? null : (fields.inherited ?? null),
    hidden,
    canChange: reason === null,
    reason,
  };
}

/** A level as the kind spells it, or null for one this build does not know. */
function knownLevel(kind: AccessKind, level: string | null | undefined): string | null {
  if (!level) return null;
  return accessLevelValues(kind).includes(level) ? level : null;
}

function granted(kind: AccessKind, level: string | null | undefined): AccessGrantState {
  const meta = ACCESS_KIND_META[kind];
  return {
    level: meta.levels.length ? (knownLevel(kind, level) ?? meta.levels[0].value) : null,
    byDefault: false,
  };
}

function slugPath(...segments: string[]): string {
  return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

/** Every token appears in one of the texts — the same rule the SQL search applies. */
function matchesTokens(tokens: Token[], ...texts: Array<string | null | undefined>): boolean {
  if (tokens.length === 0) return true;
  const haystack = texts
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token.lo));
}

/**
 * A company's rows of one table, walked through an index that begins with
 * `companyId` and ends with `orderColumn`, so `LIMIT` ends the walk.
 */
function companyRows<T extends ObjectLiteral>(
  ctx: Context,
  entity: EntityTarget<T>,
  columns: readonly string[],
  options: {
    orderColumn: string;
    searchColumns: readonly string[];
    after?: string;
    take: number;
  },
): Promise<T[]> {
  let qb = AppDataSource.getRepository(entity)
    .createQueryBuilder("r")
    .select(columns.map((column) => `r.${column}`))
    .where("r.companyId = :companyId", { companyId: ctx.companyId });
  if (options.after !== undefined) {
    qb = qb.andWhere(`r.${options.orderColumn} > :after`, { after: options.after });
  }
  qb = searched(qb, ctx, options.searchColumns);
  return qb.orderBy(`r.${options.orderColumn}`, "ASC").limit(options.take).getMany();
}

/** The search applied in SQL, to the columns a kind is searched by (none: filtered after). */
function searched<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  ctx: Context,
  columns: readonly string[],
): SelectQueryBuilder<T> {
  if (!ctx.tokens.length || !columns.length) return qb;
  return andWhereTokens(
    qb,
    columns.map((column) => `r.${column}`),
    ctx.tokens,
  );
}

/** The listed rows plus every row the employee holds a Grant on, read by id. */
async function withGranted<T extends { id: string }>(
  ctx: Context,
  entity: EntityTarget<T>,
  columns: readonly string[],
  listed: T[],
  grantedIds: Iterable<string>,
  options: { searchColumns: readonly string[] },
): Promise<T[]> {
  const have = new Set(listed.map((row) => row.id));
  const missing = [...new Set(grantedIds)].filter((id) => !have.has(id));
  if (missing.length === 0) return listed;
  const extra: T[] = [];
  for (let i = 0; i < missing.length; i += IN_CHUNK) {
    let qb = AppDataSource.getRepository(entity)
      .createQueryBuilder("r")
      .select(columns.map((column) => `r.${column}`))
      .where("r.companyId = :companyId", { companyId: ctx.companyId })
      .andWhere("r.id IN (:...ids)", { ids: missing.slice(i, i + IN_CHUNK) });
    qb = searched(qb, ctx, options.searchColumns);
    extra.push(...(await qb.getMany()));
  }
  return [...listed, ...extra];
}

/**
 * The usual shape: a company table walked by `(companyId, slug)`, the
 * employee's Grants on it, one row each.
 */
async function slugKind<T extends { id: string }>(
  ctx: Context,
  kind: AccessKind,
  entity: EntityTarget<T>,
  columns: readonly string[],
  searchColumns: readonly string[],
  grants: Map<string, string | null>,
  toRow: (row: T) => { label: string; detail?: string | null; href: string | null },
): Promise<KindListing> {
  const page = await companyRows(ctx, entity, columns, {
    orderColumn: "slug",
    searchColumns,
    take: ctx.limit + 1,
  });
  const truncated = page.length > ctx.limit;
  const rows = await withGranted(ctx, entity, columns, page.slice(0, ctx.limit), grants.keys(), {
    searchColumns,
  });
  return {
    truncated,
    items: rows.map((row) => {
      const shape = toRow(row);
      return item(ctx, kind, {
        resourceId: row.id,
        label: shape.label,
        detail: shape.detail,
        href: shape.href,
        grant: grants.has(row.id) ? granted(kind, grants.get(row.id)) : null,
      });
    }),
  };
}

// ─────────────────────────────── the employee's Grants ───────────────────────────────

async function grantMap<T extends ObjectLiteral>(
  entity: EntityTarget<T>,
  employeeId: string,
  resourceColumn: string,
  levelColumn: string | null,
): Promise<Map<string, string | null>> {
  const rows = await AppDataSource.getRepository(entity).find({
    where: { employeeId } as never,
  });
  return new Map(
    rows.map((row) => [
      String((row as Record<string, unknown>)[resourceColumn]),
      levelColumn ? String((row as Record<string, unknown>)[levelColumn]) : null,
    ]),
  );
}

// ─────────────────────────────── one loader per kind ───────────────────────────────

const RESOURCE_SOURCE_LABEL: Record<string, string> = {
  url: "Web page",
  text: "Pasted text",
  pdf: "PDF",
  epub: "Ebook",
  video: "Video",
};

const VAULT_TYPE_LABEL: Record<string, string> = {
  login: "Login",
  api_key: "API key",
  secure_note: "Secure note",
};

async function loadConnections(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeConnectionGrant, ctx.employeeId, "connectionId", null);
  const columns = ["id", "provider", "label", "accountHint", "status", "createdAt"] as const;
  // A small table indexed on `companyId` alone; a company has a handful.
  const rows = await AppDataSource.getRepository(IntegrationConnection)
    .createQueryBuilder("r")
    .select(columns.map((column) => `r.${column}`))
    .where("r.companyId = :companyId", { companyId: ctx.companyId })
    .orderBy("r.createdAt", "ASC")
    .limit(ctx.limit + 1)
    .getMany();
  const truncated = rows.length > ctx.limit;
  const all = await withGranted(ctx, IntegrationConnection, columns, rows.slice(0, ctx.limit), grants.keys(), {
    searchColumns: [],
  });
  const items: AccessItem[] = [];
  for (const row of all) {
    const retired = getRetiredProvider(row.provider);
    const provider = retired?.name ?? getProvider(row.provider)?.catalog.name ?? row.provider;
    const status =
      row.status === "connected" ? null : row.status === "expired" ? "Expired" : "Needs attention";
    const detail = [provider, row.accountHint || null, status, retired ? "Retired" : null]
      .filter(Boolean)
      .join(" · ");
    if (!matchesTokens(ctx.tokens, row.label, detail)) continue;
    items.push(
      item(ctx, "connection", {
        resourceId: row.id,
        label: row.label || provider,
        detail,
        href: "/settings/integrations",
        grant: grants.has(row.id) ? granted("connection", null) : null,
      }),
    );
  }
  return { items, truncated };
}

async function loadMailAccounts(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeMailAccountGrant, ctx.employeeId, "accountId", "accessLevel");
  const columns = ["id", "provider", "address", "status", "createdAt"] as const;
  const rows = await AppDataSource.getRepository(MailAccount)
    .createQueryBuilder("r")
    .select(columns.map((column) => `r.${column}`))
    .where("r.companyId = :companyId", { companyId: ctx.companyId })
    .orderBy("r.createdAt", "ASC")
    .limit(ctx.limit + 1)
    .getMany();
  const truncated = rows.length > ctx.limit;
  const all = await withGranted(ctx, MailAccount, columns, rows.slice(0, ctx.limit), grants.keys(), {
    searchColumns: [],
  });
  const items: AccessItem[] = [];
  for (const row of all) {
    const detail = [
      row.provider === "imap" ? "IMAP mailbox" : "Gmail",
      row.status === "paused" ? "Sync paused" : row.status === "error" ? "Needs attention" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (!matchesTokens(ctx.tokens, row.address, detail)) continue;
    items.push(
      item(ctx, "mail_account", {
        resourceId: row.id,
        label: row.address,
        detail,
        href: "/mail/settings",
        grant: grants.has(row.id) ? granted("mail_account", grants.get(row.id)) : null,
      }),
    );
  }
  return { items, truncated };
}

async function loadCalendars(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeCalendarGrant, ctx.employeeId, "accountId", "accessLevel");
  const columns = ["id", "calendarId", "address", "displayName", "createdAt"] as const;
  const rows = await AppDataSource.getRepository(CalendarAccount)
    .createQueryBuilder("r")
    .select(columns.map((column) => `r.${column}`))
    .where("r.companyId = :companyId", { companyId: ctx.companyId })
    .orderBy("r.createdAt", "ASC")
    .limit(ctx.limit + 1)
    .getMany();
  const truncated = rows.length > ctx.limit;
  const all = await withGranted(ctx, CalendarAccount, columns, rows.slice(0, ctx.limit), grants.keys(), {
    searchColumns: [],
  });
  const items: AccessItem[] = [];
  for (const row of all) {
    const label = row.displayName || row.address || row.calendarId;
    const detail = row.displayName && row.address ? row.address : null;
    if (!matchesTokens(ctx.tokens, label, detail)) continue;
    items.push(
      item(ctx, "calendar", {
        resourceId: row.id,
        label,
        detail,
        href: "/meetings/calendars",
        grant: grants.has(row.id) ? granted("calendar", grants.get(row.id)) : null,
      }),
    );
  }
  return { items, truncated };
}

async function loadRepositories(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeRepositoryGrant, ctx.employeeId, "repositoryId", "accessLevel");
  return slugKind(
    ctx,
    "repository",
    Repository,
    ["id", "name", "slug", "kind"],
    ["name"],
    grants,
    (row) => ({
      label: row.name,
      detail: row.kind === "documents" ? "Documents" : "Code",
      href: slugPath("repositories", row.slug),
    }),
  );
}

async function notebooksOf(ctx: Context): Promise<Map<string, Pick<Notebook, "id" | "title" | "slug">>> {
  const rows = await AppDataSource.getRepository(Notebook)
    .createQueryBuilder("r")
    .select(["r.id", "r.title", "r.slug"])
    .where("r.companyId = :companyId", { companyId: ctx.companyId })
    .orderBy("r.slug", "ASC")
    .getMany();
  return new Map(rows.map((row) => [row.id, row]));
}

async function loadNotebooks(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeNotebookGrant, ctx.employeeId, "notebookId", "accessLevel");
  return slugKind(
    ctx,
    "notebook",
    Notebook,
    ["id", "title", "slug"],
    ["title"],
    grants,
    (row) => ({
      label: row.title || "Untitled notebook",
      detail: "Notebook · covers every page inside",
      href: slugPath("notes", row.slug),
    }),
  );
}

type NoteRow = Pick<Note, "id" | "title" | "slug" | "notebookId">;
const NOTE_COLUMNS = ["id", "title", "slug", "notebookId"] as const;

/** Of these note ids, the ones in the trash — `archivedAt` read for these rows alone. */
async function archivedNoteIds(ctx: Context, ids: string[]): Promise<Set<string>> {
  const archived = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const rows = await AppDataSource.getRepository(Note)
      .createQueryBuilder("r")
      .select(["r.id"])
      .where("r.companyId = :companyId", { companyId: ctx.companyId })
      .andWhere("r.id IN (:...ids)", { ids: ids.slice(i, i + IN_CHUNK) })
      .andWhere("r.archivedAt IS NOT NULL")
      .getMany();
    for (const row of rows) archived.add(row.id);
  }
  return archived;
}

/**
 * Up to `limit` live notes, walked by `(companyId, slug)` a page at a time with
 * the trash filtered out per page. Bounded at {@link NOTE_WALK_PAGES} pages, so
 * a trash full of pages costs a few more reads, never a walk of the company.
 */
async function liveNotesPage(ctx: Context): Promise<{ rows: NoteRow[]; truncated: boolean }> {
  const live: NoteRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < NOTE_WALK_PAGES; page += 1) {
    const rows = await companyRows(ctx, Note, NOTE_COLUMNS, {
      orderColumn: "slug",
      searchColumns: ["title"],
      after,
      take: ctx.limit + 1,
    });
    if (rows.length === 0) return { rows: live, truncated: false };
    const archived = await archivedNoteIds(
      ctx,
      rows.map((row) => row.id),
    );
    for (const row of rows) if (!archived.has(row.id)) live.push(row);
    if (live.length > ctx.limit) return { rows: live.slice(0, ctx.limit), truncated: true };
    if (rows.length <= ctx.limit) return { rows: live, truncated: false };
    after = rows[rows.length - 1].slug;
  }
  return { rows: live, truncated: true };
}

/**
 * Which notes a note Grant reaches: its sub-pages at every depth. Walked down
 * from each granted page through `(notebookId, parentId)` — a sub-page always
 * shares its parent's notebook — one level per statement, reading only the
 * columns stored before a page's body. The work is the size of the granted
 * trees, never of the company, and {@link NOTE_INHERIT_BUDGET} caps even that.
 * A page reached by several Grants keeps the highest level.
 */
async function inheritedFromNotes(
  ctx: Context,
  direct: Map<string, string | null>,
  roots: NoteRow[],
): Promise<Map<string, { level: string; from: NoteRow }>> {
  const reach = new Map<string, { level: string; from: NoteRow }>();
  const rank = (level: string) => accessLevelValues("note").indexOf(level);
  let budget = NOTE_INHERIT_BUDGET;
  for (const root of roots) {
    const level = knownLevel("note", direct.get(root.id)) ?? "read";
    const visited = new Set<string>([root.id]);
    let frontier = [root.id];
    for (let depth = 0; depth < NOTE_INHERIT_DEPTH && frontier.length && budget > 0; depth += 1) {
      const next: string[] = [];
      for (let i = 0; i < frontier.length; i += IN_CHUNK) {
        const children = await AppDataSource.getRepository(Note)
          .createQueryBuilder("r")
          .select(["r.id"])
          .where("r.notebookId = :notebookId", { notebookId: root.notebookId })
          .andWhere("r.parentId IN (:...parentIds)", {
            parentIds: frontier.slice(i, i + IN_CHUNK),
          })
          .getMany();
        for (const child of children) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          next.push(child.id);
          budget -= 1;
          const seen = reach.get(child.id);
          if (!seen || rank(level) > rank(seen.level)) reach.set(child.id, { level, from: root });
        }
      }
      frontier = next;
    }
  }
  return reach;
}

async function loadNotes(ctx: Context): Promise<KindListing> {
  const [direct, notebookGrants, notebooks] = await Promise.all([
    grantMap(EmployeeNoteGrant, ctx.employeeId, "noteId", "accessLevel"),
    grantMap(EmployeeNotebookGrant, ctx.employeeId, "notebookId", "accessLevel"),
    notebooksOf(ctx),
  ]);
  const page = await liveNotesPage(ctx);

  // Granted pages are always listed (and are where inherited access starts),
  // unless they are in the trash.
  const pageIds = new Set(page.rows.map((row) => row.id));
  const grantedIds = [...direct.keys()];
  const missing = grantedIds.filter((id) => !pageIds.has(id));
  const grantedRows: NoteRow[] = [];
  for (let i = 0; i < missing.length; i += IN_CHUNK) {
    grantedRows.push(
      ...(await AppDataSource.getRepository(Note)
        .createQueryBuilder("r")
        .select(NOTE_COLUMNS.map((column) => `r.${column}`))
        .where("r.companyId = :companyId", { companyId: ctx.companyId })
        .andWhere("r.id IN (:...ids)", { ids: missing.slice(i, i + IN_CHUNK) })
        .getMany()),
    );
  }
  const trashedGranted = await archivedNoteIds(
    ctx,
    grantedRows.map((row) => row.id),
  );
  const liveGranted = grantedRows.filter((row) => !trashedGranted.has(row.id));
  const roots = [
    ...page.rows.filter((row) => direct.has(row.id)),
    ...liveGranted,
  ];
  const fromNotes = await inheritedFromNotes(ctx, direct, roots);

  const rows = [
    ...page.rows,
    ...liveGranted.filter((row) => matchesTokens(ctx.tokens, row.title)),
  ];
  const rank = (level: string) => accessLevelValues("note").indexOf(level);
  return {
    truncated: page.truncated,
    items: rows.map((row) => {
      const notebook = notebooks.get(row.notebookId);
      const viaNote = fromNotes.get(row.id) ?? null;
      const notebookLevel = knownLevel("notebook", notebookGrants.get(row.notebookId));
      let inherited: AccessInherited | null = null;
      if (viaNote) {
        inherited = {
          level: viaNote.level,
          fromKind: "note",
          fromId: viaNote.from.id,
          fromLabel: viaNote.from.title || "Untitled",
        };
      }
      if (notebook && notebookLevel && (!inherited || rank(notebookLevel) > rank(inherited.level))) {
        inherited = {
          level: notebookLevel,
          fromKind: "notebook",
          fromId: notebook.id,
          fromLabel: notebook.title || "Untitled notebook",
        };
      }
      return item(ctx, "note", {
        resourceId: row.id,
        label: row.title || "Untitled",
        detail: notebook ? notebook.title || "Untitled notebook" : null,
        href: notebook ? slugPath("notes", notebook.slug, row.slug) : null,
        grant: direct.has(row.id) ? granted("note", direct.get(row.id)) : null,
        inherited,
      });
    }),
  };
}

async function loadBases(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeBaseGrant, ctx.employeeId, "baseId", null);
  return slugKind(ctx, "base", Base, ["id", "name", "slug"], ["name"], grants, (row) => ({
    label: row.name,
    href: slugPath("bases", row.slug),
  }));
}

async function loadCharts(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeChartGrant, ctx.employeeId, "chartId", "accessLevel");
  return slugKind(ctx, "chart", Chart, ["id", "title", "slug"], ["title"], grants, (row) => ({
    label: row.title,
    detail: "Chart",
    href: slugPath("explore", "charts", row.slug),
  }));
}

async function loadDashboards(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeDashboardGrant, ctx.employeeId, "dashboardId", "accessLevel");
  return slugKind(
    ctx,
    "dashboard",
    Dashboard,
    ["id", "title", "slug"],
    ["title"],
    grants,
    (row) => ({ label: row.title, detail: "Dashboard", href: slugPath("explore", "dashboards", row.slug) }),
  );
}

async function loadResources(ctx: Context): Promise<KindListing> {
  const grants = await grantMap(EmployeeResourceGrant, ctx.employeeId, "resourceId", "accessLevel");
  // Only the columns stored before `summary` and `bodyText`.
  return slugKind(
    ctx,
    "resource",
    Resource,
    ["id", "title", "slug", "sourceKind"],
    ["title"],
    grants,
    (row) => ({
      label: row.title,
      detail: RESOURCE_SOURCE_LABEL[row.sourceKind] ?? null,
      href: slugPath("resources", row.slug),
    }),
  );
}

async function loadVaultItems(ctx: Context): Promise<KindListing> {
  // The Vault's own read: only items this Member can see, titles decrypted the
  // way the Vault page decrypts them.
  const [visible, grants] = await Promise.all([
    listVaultItems(ctx.companyId, { userId: ctx.viewer.userId, role: ctx.viewer.role }),
    AppDataSource.getRepository(EmployeeVaultGrant).find({
      where: { companyId: ctx.companyId, employeeId: ctx.employeeId },
    }),
  ]);
  const levelByItem = new Map(grants.map((grant) => [grant.vaultItemId, grant.accessLevel]));
  const matching = visible
    .filter((view) => matchesTokens(ctx.tokens, view.title, view.username))
    .sort((a, b) => a.title.localeCompare(b.title));
  // Items it holds first, so the limit never hides a Grant.
  const ordered = [
    ...matching.filter((view) => levelByItem.has(view.id)),
    ...matching.filter((view) => !levelByItem.has(view.id)),
  ];
  return {
    truncated: ordered.length > ctx.limit,
    items: ordered.slice(0, Math.max(ctx.limit, levelByItem.size)).map((view) => {
      const reason = vaultChangeReason(ctx.viewer, view.canShare);
      // `listEmployeeVaultGrants` answers only to an item's managers.
      const hidden = !view.canShare;
      return item(ctx, "vault_item", {
        resourceId: view.id,
        label: view.title || "Untitled item",
        detail: [VAULT_TYPE_LABEL[view.type] ?? null, view.vaultSourceId ? "Mirrored" : null]
          .filter(Boolean)
          .join(" · "),
        href: "/vault",
        grant: levelByItem.has(view.id) ? granted("vault_item", levelByItem.get(view.id)) : null,
        hidden,
        reason,
      });
    }),
  };
}

async function loadMemberBrowsers(ctx: Context): Promise<KindListing> {
  const [browsers, grants] = await Promise.all([
    AppDataSource.getRepository(MemberBrowser)
      .createQueryBuilder("r")
      .select(["r.id", "r.name", "r.ownerUserId", "r.createdAt"])
      .where("r.companyId = :companyId", { companyId: ctx.companyId })
      .andWhere("r.revokedAt IS NULL")
      .orderBy("r.createdAt", "ASC")
      .limit(ctx.limit + 1)
      .getMany(),
    grantMap(EmployeeMemberBrowserGrant, ctx.employeeId, "memberBrowserId", null),
  ]);
  const ownerIds = [...new Set(browsers.map((row) => row.ownerUserId))];
  const owners = ownerIds.length
    ? await AppDataSource.getRepository(User).find({
        where: { id: In(ownerIds) },
        select: { id: true, name: true, email: true },
      })
    : [];
  const ownerName = new Map(owners.map((owner) => [owner.id, owner.name || owner.email]));
  const items: AccessItem[] = [];
  for (const row of browsers.slice(0, ctx.limit)) {
    const own = row.ownerUserId === ctx.viewer.userId;
    const owner = ownerName.get(row.ownerUserId) ?? null;
    // Only the owner sees the browser's own name and who may drive it — the
    // Member browsers routes answer to nobody else, whatever their role.
    const label = own ? row.name : `${owner ?? "A Member"}'s browser`;
    const detail = own ? "Your browser" : null;
    if (!matchesTokens(ctx.tokens, label, detail, owner)) continue;
    items.push(
      item(ctx, "member_browser", {
        resourceId: row.id,
        label,
        detail,
        href: own ? "/settings/browsers" : null,
        grant: own && grants.has(row.id) ? granted("member_browser", null) : null,
        hidden: !own,
        reason: memberBrowserChangeReason(ctx.viewer, row.ownerUserId, owner),
      }),
    );
  }
  return { items, truncated: browsers.length > ctx.limit };
}

/** A section's one row per employee. */
async function sectionRow(
  ctx: Context,
  kind: AccessKind,
  entity: EntityTarget<ObjectLiteral>,
  href: string,
): Promise<KindListing> {
  const meta = ACCESS_KIND_META[kind];
  if (!matchesTokens(ctx.tokens, meta.singular)) return { items: [], truncated: false };
  const row = (await AppDataSource.getRepository(entity).findOne({
    where: { employeeId: ctx.employeeId },
  })) as { accessLevel?: string } | null;
  let grant: AccessGrantState | null;
  if (meta.heldByDefault) {
    // Absence means the default: the read path the MCP seam enforces.
    const level =
      kind === "routines"
        ? effectiveRoutineAccess(row?.accessLevel)
        : effectiveResourceLibraryAccess(row?.accessLevel);
    grant = { level, byDefault: !row };
  } else {
    grant = row ? granted(kind, row.accessLevel) : null;
  }
  return {
    truncated: false,
    items: [item(ctx, kind, { resourceId: null, label: meta.singular, href, grant })],
  };
}

const LOADERS: Record<AccessKind, (ctx: Context) => Promise<KindListing>> = {
  connection: loadConnections,
  mail_account: loadMailAccounts,
  calendar: loadCalendars,
  repository: loadRepositories,
  notebook: loadNotebooks,
  note: loadNotes,
  base: loadBases,
  chart: loadCharts,
  dashboard: loadDashboards,
  resource_library: (ctx) =>
    sectionRow(ctx, "resource_library", EmployeeResourceLibraryGrant, "/resources/ai-access"),
  resource: loadResources,
  vault_item: loadVaultItems,
  member_browser: loadMemberBrowsers,
  routines: (ctx) => sectionRow(ctx, "routines", EmployeeRoutineGrant, "/routines/ai-access"),
  finance: (ctx) => sectionRow(ctx, "finance", EmployeeFinanceGrant, "/finance/ai-access"),
  revenue: (ctx) => sectionRow(ctx, "revenue", EmployeeRevenueGrant, "/revenue/ai-access"),
  marketing: (ctx) => sectionRow(ctx, "marketing", EmployeeMarketingGrant, "/marketing/ai-access"),
  recruiting: (ctx) =>
    sectionRow(ctx, "recruiting", EmployeeRecruitingGrant, "/recruiting/ai-access"),
  signing: (ctx) => sectionRow(ctx, "signing", EmployeeSigningGrant, "/signatures/ai-access"),
  data_room: (ctx) => sectionRow(ctx, "data_room", EmployeeDataRoomGrant, "/data-rooms/ai-access"),
};
