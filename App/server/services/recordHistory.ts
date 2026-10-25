import { In, LessThan } from "typeorm";
import type { FindOptionsWhere } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent, type AuditActorKind } from "../db/entities/AuditEvent.js";
import type { FinanceAccess, Role } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { User } from "../db/entities/User.js";
import { financeAccessFor } from "../middleware/financeAccess.js";
import { findProjectAccess } from "./projects.js";

/**
 * A record's history: who changed one invoice, routine, deal, note… and when,
 * read from the audit rows the server wrote at each write seam.
 *
 * ## Why this is not `GET /audit`
 *
 * The audit log is the company's whole history, so reading it is admin-gated.
 * One record's own history is part of reading that record — a Member who can
 * open an invoice should be able to see that an AI Employee issued it and a
 * Member marked it paid. So this reads only rows targeting one record, only
 * after the caller has passed the same bar the record's own page sets
 * ({@link canReadRecordHistory}), and returns a reduced shape: actor, action,
 * time, and a metadata digest with ids and anything credential-shaped dropped.
 *
 * ## Which records
 *
 * An allowlist, not every `targetType` the log has ever seen. A type is here
 * only when its read bar is settled: any Member, Finance read, a Project's
 * own access, or owners and admins for records only they can open. Secrets, Vault items, API keys, Connections, mailboxes and
 * Member browsers stay out — their audit rows carry exactly what their own
 * pages take care not to show.
 */

export type RecordHistoryViewer = {
  userId: string;
  role: Role | undefined;
  financeAccess: FinanceAccess | undefined;
};

type AccessRule = "member" | "finance" | "admin" | "project" | "todo";

/**
 * Every record type with a History, and the bar a viewer must clear to read
 * it. Default deny: a type missing here answers 404.
 */
export const RECORD_HISTORY_TYPES: Record<string, AccessRule> = {
  // Finance — the bar every finance GET sets (`requireFinanceRead`).
  invoice: "finance",
  estimate: "finance",
  credit_note: "finance",
  vendor_credit: "finance",
  recurring_invoice: "finance",
  customer: "finance",
  bill: "finance",
  vendor: "finance",
  product: "finance",
  ledger_entry: "finance",
  finance_proposal: "finance",
  // Workforce.
  employee: "member",
  routine: "member",
  skill: "member",
  goal: "member",
  pipeline: "member",
  company_policy: "member",
  initiative: "member",
  workstream: "member",
  // Revenue.
  contact: "member",
  deal: "member",
  revenue_account: "member",
  partnership: "member",
  sequence: "member",
  signal: "member",
  // Workspace.
  note: "member",
  notebook: "member",
  base: "member",
  base_table: "member",
  base_record: "member",
  base_form: "member",
  chart: "member",
  dashboard: "member",
  resource: "member",
  meeting: "member",
  signature_envelope: "member",
  // Owners and admins only, like the data room itself.
  data_room: "admin",
  marketing_campaign: "member",
  repository: "member",
  // Tasks — a restricted Project is readable only by its own members.
  project: "project",
  todo: "todo",
};

/**
 * Types whose History also reads rows written under another name for the
 * same row. A Customer is a Revenue Account seen from Finance, so the Revenue
 * tools' `revenue_account` rows belong on it. One way only: a Revenue
 * Account's History is Member-readable and must not show finance rows.
 */
const RECORD_HISTORY_ALIASES: Record<string, string[]> = {
  customer: ["customer", "revenue_account"],
};

export function isRecordHistoryType(targetType: string): boolean {
  return Object.prototype.hasOwnProperty.call(RECORD_HISTORY_TYPES, targetType);
}

export async function canReadRecordHistory(
  companyId: string,
  targetType: string,
  targetId: string,
  viewer: RecordHistoryViewer,
): Promise<boolean> {
  const rule = isRecordHistoryType(targetType) ? RECORD_HISTORY_TYPES[targetType] : null;
  if (!rule) return false;
  if (rule === "member") return true;
  if (rule === "finance") return financeAccessFor(viewer.role, viewer.financeAccess) !== "none";
  if (rule === "admin") return viewer.role === "owner" || viewer.role === "admin";
  let projectId = targetId;
  if (rule === "todo") {
    const todo = await AppDataSource.getRepository(Todo).findOne({
      where: { id: targetId },
      select: { id: true, projectId: true },
    });
    if (!todo) return false;
    projectId = todo.projectId;
  }
  const project = await AppDataSource.getRepository(Project).findOneBy({
    id: projectId,
    companyId,
  });
  if (!project) return false;
  const level = await findProjectAccess(project, {
    kind: "user",
    id: viewer.userId,
    role: viewer.role ?? "member",
  });
  return !!level;
}

export type RecordHistoryValue = string | number | boolean | null;

export type RecordHistoryEntry = {
  id: string;
  createdAt: Date;
  action: string;
  actorKind: AuditActorKind;
  actor: { id: string; name: string; avatarKey: string | null } | null;
  actorEmployee: {
    id: string;
    slug: string;
    name: string;
    role: string;
    avatarKey: string | null;
  } | null;
  runId: string | null;
  /** Field names an update touched, when the row says which. */
  changedFields: string[];
  /** Scalar context worth a line under the entry — amounts, statuses, addresses. */
  details: Record<string, RecordHistoryValue>;
};

const SENSITIVE_KEY = /secret|token|password|passphrase|credential|cookie|authorization|apikey|hash|cipher|private/i;
const MAX_DETAILS = 10;
const MAX_STRING = 240;
const MAX_FIELDS = 20;

/** Keys that name *which* fields changed rather than carry a value. */
const CHANGE_KEYS = new Set(["changes", "fields", "changedFields", "patch", "updates"]);

function isIdKey(key: string): boolean {
  return key === "id" || /Ids?$/.test(key);
}

/**
 * Reduce an audit row's free-form metadata to what a record's reader may see.
 * Ids are dropped (they mean nothing on screen and name other records), as is
 * anything credential-shaped and anything nested beyond a field list.
 */
export function digestMetadata(raw: unknown): {
  changedFields: string[];
  details: Record<string, RecordHistoryValue>;
} {
  const changedFields: string[] = [];
  const details: Record<string, RecordHistoryValue> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { changedFields, details };
  const meta = raw as Record<string, unknown>;

  const addFields = (names: unknown[]) => {
    for (const name of names) {
      if (typeof name !== "string" || SENSITIVE_KEY.test(name)) continue;
      if (!changedFields.includes(name) && changedFields.length < MAX_FIELDS) {
        changedFields.push(name);
      }
    }
  };

  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(key) || isIdKey(key)) continue;
    if (CHANGE_KEYS.has(key)) {
      if (Array.isArray(value)) addFields(value);
      else if (value && typeof value === "object") addFields(Object.keys(value));
      continue;
    }
    if (key === "before" || key === "after") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const other = meta[key === "before" ? "after" : "before"];
        const otherObj =
          other && typeof other === "object" && !Array.isArray(other)
            ? (other as Record<string, unknown>)
            : {};
        addFields(
          Object.keys(value).filter(
            (k) =>
              JSON.stringify((value as Record<string, unknown>)[k]) !== JSON.stringify(otherObj[k]),
          ),
        );
      }
      continue;
    }
    if (Object.keys(details).length >= MAX_DETAILS) continue;
    if (value === null || typeof value === "boolean") details[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) details[key] = value;
    else if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      details[key] = trimmed.length > MAX_STRING ? `${trimmed.slice(0, MAX_STRING - 1)}…` : trimmed;
    }
  }
  return { changedFields, details };
}

export async function listRecordHistory(params: {
  companyId: string;
  targetType: string;
  targetId: string;
  take: number;
  cursor?: string;
}): Promise<{ items: RecordHistoryEntry[]; nextCursor: string | null }> {
  // Served by the (companyId, targetType, targetId, createdAt) index, so a
  // record's page reads only its own rows however large the log has grown.
  const where: FindOptionsWhere<AuditEvent> = {
    companyId: params.companyId,
    targetType: RECORD_HISTORY_ALIASES[params.targetType]
      ? In(RECORD_HISTORY_ALIASES[params.targetType])
      : params.targetType,
    targetId: params.targetId,
  };
  if (params.cursor) where.createdAt = LessThan(new Date(params.cursor));
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where,
    order: { createdAt: "DESC", id: "DESC" },
    take: params.take,
  });

  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const employeeIds = [
    ...new Set(rows.map((r) => r.actorEmployeeId).filter((x): x is string => !!x)),
  ];
  const [users, employees] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({
          where: { id: In(userIds) },
          select: { id: true, name: true, email: true, avatarKey: true },
        })
      : Promise.resolve([]),
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          // Company-scoped, as in `GET /audit`: an id outside this company
          // hydrates to null rather than naming someone across the boundary.
          where: { id: In(employeeIds), companyId: params.companyId },
          select: { id: true, slug: true, name: true, role: true, avatarKey: true },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  const items = rows.map((r): RecordHistoryEntry => {
    const u = r.actorUserId ? userById.get(r.actorUserId) : undefined;
    const e = r.actorEmployeeId ? employeeById.get(r.actorEmployeeId) : undefined;
    let parsed: unknown = null;
    if (r.metadataJson) {
      try {
        parsed = JSON.parse(r.metadataJson);
      } catch {
        parsed = null;
      }
    }
    const { changedFields, details } = digestMetadata(parsed);
    return {
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      actorKind: r.actorKind,
      actor: u ? { id: u.id, name: u.name || u.email, avatarKey: u.avatarKey ?? null } : null,
      actorEmployee: e
        ? { id: e.id, slug: e.slug, name: e.name, role: e.role, avatarKey: e.avatarKey ?? null }
        : null,
      runId: r.runId,
      changedFields,
      details,
    };
  });

  return {
    items,
    nextCursor:
      items.length === params.take ? items[items.length - 1].createdAt.toISOString() : null,
  };
}
