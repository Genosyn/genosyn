import type { RequestListener } from "node:http";
import { In, type EntityTarget, type ObjectLiteral } from "typeorm";
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
import { VaultItem } from "../../db/entities/VaultItem.js";
import { InProcessRequestError, requestInProcess } from "../companyMcp/dispatch.js";
import { effectiveResourceLibraryAccess } from "../resourceLibraryAccess.js";
import { effectiveRoutineAccess } from "../routineAccess.js";
import {
  ACCESS_BULK_OUTCOMES,
  ACCESS_KIND_META,
  accessItemKey,
  accessLevelLabel,
  type AccessBulkAction,
  type AccessBulkItem,
  type AccessBulkOutcome,
  type AccessBulkResponse,
  type AccessBulkResult,
  type AccessKind,
} from "../../../shared/employeeAccess.js";
import {
  kindChangeReason,
  kindUnavailableReason,
  memberBrowserChangeReason,
  vaultChangeReason,
  type AccessViewer,
} from "./rules.js";

/**
 * Many Grants at once, for one AI Employee, each through its kind's own route.
 *
 * The Access page can tick a mailbox, three notes, a Vault item and Finance,
 * and ask for them all at once. Every one of those already has a route on its
 * own side — `POST /mail/accounts/:aid/grants`, `PUT /finance/...`,
 * `DELETE /member-browsers/:id/grants/:eid` — and those routes are the rules:
 * the router's role gate, the browser-session gate, a Vault item's manager
 * check, a Member browser's owner check, the level each kind accepts, the audit
 * row each writes, the event it broadcasts. Rather than restate any of that,
 * each change here is the HTTP request the kind's own panel would send,
 * handed to the very same Express app in memory (`companyMcp/dispatch.ts`,
 * which the Genosyn MCP server replays its operations through) and carrying
 * the very credential the bulk request came with. A change the kind's own
 * route refuses is refused here, with that route's answer, and one it accepts
 * leaves exactly the rows it always leaves.
 *
 * What this file decides on its own is only what needs no authority: which of
 * the asked-for changes are already true (granting what is held, revoking what
 * is not), so a repeated request changes nothing and audits nothing; and, for
 * a row the viewer may not see the Grants of, nothing at all — that one goes
 * straight to its route, so an outcome never reveals what the viewer could not
 * read. Items run one after another and each reports its own outcome, so one
 * refusal never undoes the rest.
 */

/** How the replayed requests authenticate, and whom they come from. */
export type ReplayContext = {
  app: RequestListener;
  /** The bulk request's own credential (its session cookie or its API key) and forwarded headers. */
  headers: Record<string, string>;
  remote: { address?: string; port?: number; family?: string; encrypted?: boolean };
};

export type ApplyAccessBulkArgs = {
  companyId: string;
  employee: Pick<AIEmployee, "id" | "name">;
  viewer: AccessViewer;
  action: AccessBulkAction;
  items: AccessBulkItem[];
  replay: ReplayContext;
};

/** Long enough for one Grant on a busy instance; a replay never holds a model turn. */
const REPLAY_TIMEOUT_MS = 30_000;
/** Grant routes answer with a row or `{ ok: true }`; anything longer is not needed. */
const REPLAY_MAX_RESPONSE_BYTES = 64 * 1024;
/** Stands in for a Grant id the viewer may not look up, so the route itself refuses. */
const UNSEEN_ID = "00000000-0000-0000-0000-000000000000";

export type ResourceInfo = {
  id: string;
  slug: string | null;
  /** Vault: who added it (the Vault's own manager rule). Member browser: its owner. */
  ownerUserId: string | null;
  ownerName: string | null;
};

type GrantInfo = { id: string; level: string | null };

type KindState = {
  resources: Map<string, ResourceInfo>;
  /** By resource id; a section's one row under the empty key. */
  grants: Map<string, GrantInfo>;
};

export type Operation = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
};

export type OperationContext = {
  employeeId: string;
  resource: ResourceInfo | null;
  grantId: string;
  level: string | null;
};

export type KindRoutes = {
  grant: (c: OperationContext) => Operation;
  setLevel?: (c: OperationContext) => Operation;
  revoke?: (c: OperationContext) => Operation;
};

const SECTION_KEY = "";

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function resourceId(c: OperationContext): string {
  return c.resource!.id;
}

function slug(c: OperationContext): string {
  return enc(c.resource!.slug ?? "");
}

/** `/<base>/grants` with `{ employeeId, accessLevel }`, PATCH/DELETE `/<base>/grants/:grantId`. */
function grantsCollection(base: (c: OperationContext) => string): KindRoutes {
  return {
    grant: (c) => ({
      method: "POST",
      path: `${base(c)}/grants`,
      body: { employeeId: c.employeeId, accessLevel: c.level },
    }),
    setLevel: (c) => ({
      method: "PATCH",
      path: `${base(c)}/grants/${enc(c.grantId)}`,
      body: { accessLevel: c.level },
    }),
    revoke: (c) => ({ method: "DELETE", path: `${base(c)}/grants/${enc(c.grantId)}` }),
  };
}

/**
 * The request each kind's own panel sends, by kind. Paths are relative to
 * `/api/companies/:cid`; the routes they name are the ones in `routes/` that
 * each surface has always used.
 */
export const ACCESS_ROUTES: Record<AccessKind, KindRoutes> = {
  connection: {
    grant: (c) => ({
      method: "POST",
      path: `/integrations/employees/${enc(c.employeeId)}/grants`,
      body: { connectionId: resourceId(c) },
    }),
    revoke: (c) => ({
      method: "DELETE",
      path: `/integrations/employees/${enc(c.employeeId)}/grants/${enc(resourceId(c))}`,
    }),
  },
  mail_account: grantsCollection((c) => `/mail/accounts/${enc(resourceId(c))}`),
  calendar: {
    grant: (c) => ({
      method: "PUT",
      path: "/meetings/ai-access",
      body: { employeeId: c.employeeId, accountId: resourceId(c), accessLevel: c.level },
    }),
    setLevel: (c) => ({
      method: "PUT",
      path: "/meetings/ai-access",
      body: { employeeId: c.employeeId, accountId: resourceId(c), accessLevel: c.level },
    }),
    revoke: (c) => ({
      method: "POST",
      path: "/meetings/ai-access/revoke",
      body: { employeeId: c.employeeId, accountId: resourceId(c) },
    }),
  },
  repository: grantsCollection((c) => `/repositories/${slug(c)}`),
  notebook: grantsCollection((c) => `/notebooks/${slug(c)}`),
  note: grantsCollection((c) => `/notes/${slug(c)}`),
  base: {
    grant: (c) => ({
      method: "POST",
      path: `/bases/${slug(c)}/grants`,
      body: { employeeId: c.employeeId },
    }),
    revoke: (c) => ({
      method: "DELETE",
      path: `/bases/${slug(c)}/grants/${enc(c.employeeId)}`,
    }),
  },
  chart: grantsCollection((c) => `/explore/charts/${slug(c)}`),
  dashboard: grantsCollection((c) => `/explore/dashboards/${slug(c)}`),
  resource_library: {
    grant: (c) => ({
      method: "PUT",
      path: `/resources/ai-access/${enc(c.employeeId)}`,
      body: { accessLevel: c.level },
    }),
    setLevel: (c) => ({
      method: "PUT",
      path: `/resources/ai-access/${enc(c.employeeId)}`,
      body: { accessLevel: c.level },
    }),
  },
  resource: grantsCollection((c) => `/resources/${slug(c)}`),
  vault_item: {
    grant: (c) => ({
      method: "POST",
      path: `/vault/items/${enc(resourceId(c))}/employee-grants`,
      body: { employeeId: c.employeeId, accessLevel: c.level },
    }),
    setLevel: (c) => ({
      method: "PATCH",
      path: `/vault/items/${enc(resourceId(c))}/employee-grants/${enc(c.grantId)}`,
      body: { accessLevel: c.level },
    }),
    revoke: (c) => ({
      method: "DELETE",
      path: `/vault/items/${enc(resourceId(c))}/employee-grants/${enc(c.grantId)}`,
    }),
  },
  member_browser: {
    grant: (c) => ({
      method: "POST",
      path: `/member-browsers/${enc(resourceId(c))}/grants`,
      body: { employeeId: c.employeeId },
    }),
    revoke: (c) => ({
      method: "DELETE",
      path: `/member-browsers/${enc(resourceId(c))}/grants/${enc(c.employeeId)}`,
    }),
  },
  routines: {
    grant: (c) => ({
      method: "PUT",
      path: `/routines/ai-access/${enc(c.employeeId)}`,
      body: { accessLevel: c.level },
    }),
    setLevel: (c) => ({
      method: "PUT",
      path: `/routines/ai-access/${enc(c.employeeId)}`,
      body: { accessLevel: c.level },
    }),
  },
  finance: {
    grant: (c) => ({
      method: "POST",
      path: "/finance/grants",
      body: { employeeId: c.employeeId, accessLevel: c.level },
    }),
    setLevel: (c) => ({
      method: "PATCH",
      path: `/finance/grants/${enc(c.grantId)}`,
      body: { accessLevel: c.level },
    }),
    revoke: (c) => ({ method: "DELETE", path: `/finance/grants/${enc(c.grantId)}` }),
  },
  revenue: upsertByEmployee("/revenue/ai-access", "grant"),
  marketing: upsertByEmployee("/marketing/ai-access", "grant"),
  recruiting: upsertByEmployee("/recruiting/ai-access", "grant"),
  signing: upsertByEmployee("/signatures/ai-access", "employee"),
  data_room: upsertByEmployee("/data-rooms/ai-access", "employee"),
};

/**
 * `PUT <base>/:employeeId` states the level; revoking deletes by the Grant's
 * own id, or (Document signing, Data rooms) by the employee's.
 */
function upsertByEmployee(base: string, revokeBy: "grant" | "employee"): KindRoutes {
  const put = (c: OperationContext): Operation => ({
    method: "PUT",
    path: `${base}/${enc(c.employeeId)}`,
    body: { accessLevel: c.level },
  });
  return {
    grant: put,
    setLevel: put,
    revoke: (c) => ({
      method: "DELETE",
      path: `${base}/${enc(revokeBy === "grant" ? c.grantId : c.employeeId)}`,
    }),
  };
}

// ─────────────────────────────── state ───────────────────────────────

type ResourceSource = {
  entity: EntityTarget<ObjectLiteral>;
  /** Column holding the slug its route is addressed by, if any. */
  slugColumn?: string;
  /** Column naming who decides about it, if the kind has an owner rule. */
  ownerColumn?: string;
  /** Rows that exist but no longer count (a revoked Member browser). */
  excludeRevoked?: boolean;
};

const RESOURCE_SOURCES: Partial<Record<AccessKind, ResourceSource>> = {
  connection: { entity: IntegrationConnection },
  mail_account: { entity: MailAccount },
  calendar: { entity: CalendarAccount },
  repository: { entity: Repository, slugColumn: "slug" },
  notebook: { entity: Notebook, slugColumn: "slug" },
  note: { entity: Note, slugColumn: "slug" },
  base: { entity: Base, slugColumn: "slug" },
  chart: { entity: Chart, slugColumn: "slug" },
  dashboard: { entity: Dashboard, slugColumn: "slug" },
  resource: { entity: Resource, slugColumn: "slug" },
  vault_item: { entity: VaultItem, ownerColumn: "createdByUserId" },
  member_browser: { entity: MemberBrowser, ownerColumn: "ownerUserId", excludeRevoked: true },
};

export type GrantSource = {
  entity: EntityTarget<ObjectLiteral>;
  /** The column naming the resource; absent for a section's one row per employee. */
  resourceColumn?: string;
  levelColumn?: string;
};

export const GRANT_SOURCES: Record<AccessKind, GrantSource> = {
  connection: { entity: EmployeeConnectionGrant, resourceColumn: "connectionId" },
  mail_account: {
    entity: EmployeeMailAccountGrant,
    resourceColumn: "accountId",
    levelColumn: "accessLevel",
  },
  calendar: { entity: EmployeeCalendarGrant, resourceColumn: "accountId", levelColumn: "accessLevel" },
  repository: {
    entity: EmployeeRepositoryGrant,
    resourceColumn: "repositoryId",
    levelColumn: "accessLevel",
  },
  notebook: { entity: EmployeeNotebookGrant, resourceColumn: "notebookId", levelColumn: "accessLevel" },
  note: { entity: EmployeeNoteGrant, resourceColumn: "noteId", levelColumn: "accessLevel" },
  base: { entity: EmployeeBaseGrant, resourceColumn: "baseId" },
  chart: { entity: EmployeeChartGrant, resourceColumn: "chartId", levelColumn: "accessLevel" },
  dashboard: {
    entity: EmployeeDashboardGrant,
    resourceColumn: "dashboardId",
    levelColumn: "accessLevel",
  },
  resource_library: { entity: EmployeeResourceLibraryGrant, levelColumn: "accessLevel" },
  resource: { entity: EmployeeResourceGrant, resourceColumn: "resourceId", levelColumn: "accessLevel" },
  vault_item: { entity: EmployeeVaultGrant, resourceColumn: "vaultItemId", levelColumn: "accessLevel" },
  member_browser: { entity: EmployeeMemberBrowserGrant, resourceColumn: "memberBrowserId" },
  routines: { entity: EmployeeRoutineGrant, levelColumn: "accessLevel" },
  finance: { entity: EmployeeFinanceGrant, levelColumn: "accessLevel" },
  revenue: { entity: EmployeeRevenueGrant, levelColumn: "accessLevel" },
  marketing: { entity: EmployeeMarketingGrant, levelColumn: "accessLevel" },
  recruiting: { entity: EmployeeRecruitingGrant, levelColumn: "accessLevel" },
  signing: { entity: EmployeeSigningGrant, levelColumn: "accessLevel" },
  data_room: { entity: EmployeeDataRoomGrant, levelColumn: "accessLevel" },
};

async function loadKindState(
  companyId: string,
  employeeId: string,
  kind: AccessKind,
  ids: string[],
): Promise<KindState> {
  const resources = new Map<string, ResourceInfo>();
  const source = RESOURCE_SOURCES[kind];
  if (source && ids.length) {
    const columns = ["id", source.slugColumn, source.ownerColumn].filter(
      (column): column is string => Boolean(column),
    );
    let qb = AppDataSource.getRepository(source.entity)
      .createQueryBuilder("r")
      .select(columns.map((column) => `r.${column}`))
      .where("r.companyId = :companyId", { companyId })
      .andWhere("r.id IN (:...ids)", { ids });
    if (source.excludeRevoked) qb = qb.andWhere("r.revokedAt IS NULL");
    const rows = (await qb.getMany()) as Array<Record<string, string | null>>;
    const ownerIds = source.ownerColumn
      ? [
          ...new Set(
            rows
              .map((row) => row[source.ownerColumn!])
              .filter((id): id is string => Boolean(id)),
          ),
        ]
      : [];
    const owners = ownerIds.length
      ? await AppDataSource.getRepository(User).find({
          where: { id: In(ownerIds) },
          select: { id: true, name: true, email: true },
        })
      : [];
    const ownerName = new Map(owners.map((owner) => [owner.id, owner.name || owner.email]));
    for (const row of rows) {
      const ownerUserId = source.ownerColumn ? (row[source.ownerColumn] ?? null) : null;
      resources.set(String(row.id), {
        id: String(row.id),
        slug: source.slugColumn ? (row[source.slugColumn] ?? null) : null,
        ownerUserId,
        ownerName: ownerUserId ? (ownerName.get(ownerUserId) ?? null) : null,
      });
    }
  }

  const grants = new Map<string, GrantInfo>();
  const grantSource = GRANT_SOURCES[kind];
  const where: Record<string, unknown> = { employeeId };
  if (grantSource.resourceColumn) {
    if (ids.length === 0) return { resources, grants };
    where[grantSource.resourceColumn] = In(ids);
  }
  const rows = (await AppDataSource.getRepository(grantSource.entity).find({ where })) as Array<
    Record<string, unknown>
  >;
  for (const row of rows) {
    const key = grantSource.resourceColumn ? String(row[grantSource.resourceColumn]) : SECTION_KEY;
    grants.set(key, {
      id: String(row.id),
      level: grantSource.levelColumn ? String(row[grantSource.levelColumn]) : null,
    });
  }
  return { resources, grants };
}

/**
 * Whether the viewer may read this row's Grants on the kind's own surface —
 * when not, nothing here looks at them, and the change goes straight to the
 * route (which refuses it before it reads them either).
 */
function stateVisible(kind: AccessKind, viewer: AccessViewer, resource: ResourceInfo | null): boolean {
  if (kindUnavailableReason(kind, viewer)) return false;
  if (kind === "finance" && viewer.financeAccess === "none") return false;
  const admin = viewer.role === "owner" || viewer.role === "admin";
  if (kind === "vault_item") return admin || resource?.ownerUserId === viewer.userId;
  if (kind === "member_browser") return resource?.ownerUserId === viewer.userId;
  return true;
}

/** The kind's own rule, in its own words, for explaining a refusal. */
function changeReason(kind: AccessKind, viewer: AccessViewer, resource: ResourceInfo | null): string | null {
  if (kind === "vault_item") {
    const admin = viewer.role === "owner" || viewer.role === "admin";
    return vaultChangeReason(viewer, admin || resource?.ownerUserId === viewer.userId);
  }
  if (kind === "member_browser" && resource) {
    return memberBrowserChangeReason(viewer, resource.ownerUserId ?? "", resource.ownerName);
  }
  return kindChangeReason(kind, viewer);
}

// ─────────────────────────────── replay ───────────────────────────────

type ReplayAnswer = { ok: boolean; status: number | null; message: string | null };

function routeMessage(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      error?: unknown;
      issues?: Array<{ message?: unknown; path?: unknown }>;
    };
    if (parsed.error === "ValidationError" && Array.isArray(parsed.issues) && parsed.issues[0]) {
      const issue = parsed.issues[0];
      return typeof issue.message === "string" ? issue.message : "The request was not valid.";
    }
    return typeof parsed.error === "string" && parsed.error ? parsed.error : null;
  } catch {
    return null;
  }
}

async function replay(
  companyId: string,
  operation: Operation,
  context: ReplayContext,
): Promise<ReplayAnswer> {
  const body =
    operation.body === undefined ? undefined : Buffer.from(JSON.stringify(operation.body), "utf8");
  const headers: Record<string, string> = {
    ...context.headers,
    accept: "application/json",
  };
  if (body) headers["content-type"] = "application/json";
  try {
    const response = await requestInProcess(context.app, {
      method: operation.method,
      path: `/api/companies/${enc(companyId)}${operation.path}`,
      headers,
      body,
      remote: context.remote,
      timeoutMs: REPLAY_TIMEOUT_MS,
      maxResponseBytes: REPLAY_MAX_RESPONSE_BYTES,
    });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, status: response.status, message: ok ? null : routeMessage(response.body) };
  } catch (error) {
    return {
      ok: false,
      status: null,
      message:
        error instanceof InProcessRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "The change could not be sent.",
    };
  }
}

// ─────────────────────────────── the bulk change ───────────────────────────────

function heldLevel(kind: AccessKind, grant: GrantInfo | undefined): string | null {
  if (kind === "routines") return effectiveRoutineAccess(grant?.level);
  if (kind === "resource_library") return effectiveResourceLibraryAccess(grant?.level);
  return grant?.level ?? null;
}

function describeHeld(kind: AccessKind, level: string | null): string {
  return level ? `Already holds ${accessLevelLabel(kind, level)}.` : "Already granted.";
}

export async function applyEmployeeAccessBulk(
  args: ApplyAccessBulkArgs,
): Promise<AccessBulkResponse> {
  // One change per row, the first asked for.
  const seen = new Set<string>();
  const items: Array<AccessBulkItem & { key: string; id: string | null }> = [];
  for (const raw of args.items) {
    const id = ACCESS_KIND_META[raw.kind].scope === "resource" ? (raw.resourceId ?? null) : null;
    const key = accessItemKey(raw.kind, id);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...raw, key, id });
  }

  const states = new Map<AccessKind, KindState>();
  for (const kind of new Set(items.map((entry) => entry.kind))) {
    const ids = items
      .filter((entry) => entry.kind === kind && entry.id)
      .map((entry) => entry.id as string);
    states.set(kind, await loadKindState(args.companyId, args.employee.id, kind, ids));
  }

  const results: AccessBulkResult[] = [];
  for (const entry of items) {
    results.push(await applyOne(args, entry, states.get(entry.kind)!));
  }

  const summary = Object.fromEntries(ACCESS_BULK_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    AccessBulkOutcome,
    number
  >;
  for (const result of results) summary[result.outcome] += 1;
  return { action: args.action, results, summary };
}

async function applyOne(
  args: ApplyAccessBulkArgs,
  entry: AccessBulkItem & { key: string; id: string | null },
  state: KindState,
): Promise<AccessBulkResult> {
  const { kind } = entry;
  const meta = ACCESS_KIND_META[kind];
  const result = (
    outcome: AccessBulkOutcome,
    fields: { level?: string | null; message?: string | null; status?: number | null } = {},
  ): AccessBulkResult => ({
    key: entry.key,
    kind,
    resourceId: entry.id,
    outcome,
    level: fields.level ?? null,
    message: fields.message ?? null,
    status: fields.status ?? null,
  });

  const resource = entry.id ? (state.resources.get(entry.id) ?? null) : null;
  if (meta.scope === "resource" && !resource) {
    return result("failed", {
      status: 404,
      message: `That ${meta.singular.toLowerCase()} is not in this company.`,
    });
  }

  const visible = stateVisible(kind, args.viewer, resource);
  const grant = state.grants.get(entry.id ?? SECTION_KEY);
  const held = meta.heldByDefault !== null || grant !== undefined;
  const current = heldLevel(kind, grant);
  const level = meta.levels.length ? (entry.level ?? meta.defaultLevel) : null;
  const routes = ACCESS_ROUTES[kind];

  let operation: ((c: OperationContext) => Operation) | undefined;
  let success: AccessBulkOutcome;
  switch (args.action) {
    case "grant":
      if (visible && held) return result("unchanged", { level: current, message: describeHeld(kind, current) });
      operation = routes.grant;
      success = "granted";
      break;
    case "set_level":
      if (!meta.levels.length) {
        return result("skipped", { message: `${meta.plural} have no levels to change.` });
      }
      if (visible && !held) {
        return result("skipped", { message: "Not granted yet, so there is no level to change." });
      }
      if (visible && current === level) {
        return result("unchanged", { level: current, message: describeHeld(kind, current) });
      }
      operation = routes.setLevel;
      success = "updated";
      break;
    case "revoke":
      if (!routes.revoke || meta.heldByDefault) {
        return result("skipped", {
          level: visible ? current : null,
          message: `Every AI Employee holds a ${meta.singular} level, so it cannot be revoked; choose the narrower level instead.`,
        });
      }
      if (visible && !held) return result("unchanged", { message: "Not granted." });
      operation = routes.revoke;
      success = "revoked";
      break;
  }
  if (!operation) return result("skipped", { message: "This change does not apply here." });

  const answer = await replay(
    args.companyId,
    operation({
      employeeId: args.employee.id,
      resource,
      grantId: grant?.id ?? UNSEEN_ID,
      level,
    }),
    args.replay,
  );
  if (answer.ok) {
    return result(success, { level: success === "revoked" ? null : level });
  }
  const predicted = changeReason(kind, args.viewer, resource);
  const refused = answer.status === 403 || answer.status === 404;
  return result("failed", {
    status: answer.status,
    message:
      refused && predicted
        ? predicted
        : (answer.message ?? `The ${meta.singular.toLowerCase()} could not be changed.`),
  });
}
