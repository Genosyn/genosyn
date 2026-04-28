/**
 * Business logic for Bases: unique slugs, seeding from templates, and the
 * hydrator that joins records + fields + links into client-friendly rows.
 *
 * Keeps all Base-aware glue in one place so the router stays thin.
 */

import { AppDataSource } from "../db/datasource.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import { BaseView } from "../db/entities/BaseView.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import { toSlug } from "../lib/slug.js";
import { In } from "typeorm";
import {
  BASE_TEMPLATES,
  BaseTemplate,
  TemplateRow,
  TemplateRowCell,
} from "./baseTemplates.js";

export async function uniqueBaseSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Base);
  const seed = base || "base";
  let slug = seed;
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${seed}-${n}`;
  }
  return slug;
}

/**
 * Case-insensitive lookup of a base by display name within a company. Used to
 * reject duplicates at create/rename time so the sidebar stays unambiguous.
 * Pass `excludeId` when renaming to ignore the row being edited.
 */
export async function findBaseByName(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<Base | null> {
  const qb = AppDataSource.getRepository(Base)
    .createQueryBuilder("b")
    .where("b.companyId = :companyId", { companyId })
    .andWhere("LOWER(b.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("b.id != :excludeId", { excludeId });
  return qb.getOne();
}

/** Same shape as {@link findBaseByName}, scoped to a single base's tables. */
export async function findBaseTableByName(
  baseId: string,
  name: string,
  excludeId?: string,
): Promise<BaseTable | null> {
  const qb = AppDataSource.getRepository(BaseTable)
    .createQueryBuilder("t")
    .where("t.baseId = :baseId", { baseId })
    .andWhere("LOWER(t.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("t.id != :excludeId", { excludeId });
  return qb.getOne();
}

export async function uniqueTableSlug(baseId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(BaseTable);
  const seed = base || "table";
  let slug = seed;
  let n = 1;
  while (await repo.findOneBy({ baseId, slug })) {
    n += 1;
    slug = `${seed}-${n}`;
  }
  return slug;
}

function randOptionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Apply a template to an already-created Base. Creates tables, fields, and
 * seed rows (resolving link cells against the primary-field values of sibling
 * tables). Returns nothing — callers re-fetch.
 */
export async function seedBaseFromTemplate(
  baseId: string,
  template: BaseTemplate,
): Promise<void> {
  const tableRepo = AppDataSource.getRepository(BaseTable);
  const fieldRepo = AppDataSource.getRepository(BaseField);
  const recordRepo = AppDataSource.getRepository(BaseRecord);

  // 1. Tables.
  const tablesByKey = new Map<string, BaseTable>();
  for (let i = 0; i < template.tables.length; i += 1) {
    const tt = template.tables[i];
    const slug = await uniqueTableSlug(baseId, toSlug(tt.name));
    const saved = await tableRepo.save(
      tableRepo.create({
        baseId,
        name: tt.name,
        slug,
        sortOrder: (i + 1) * 1000,
      }),
    );
    tablesByKey.set(tt.key, saved);
  }

  // 2. Fields, keyed by (tableKey, fieldKey) for the row-insertion pass. Link
  //    fields need the *real* table id of the sibling, which we have now.
  const fieldsByKey = new Map<string, BaseField>();
  for (const tt of template.tables) {
    const table = tablesByKey.get(tt.key)!;
    for (let i = 0; i < tt.fields.length; i += 1) {
      const tf = tt.fields[i];
      let config: Record<string, unknown> = {};
      if (tf.type === "select" || tf.type === "multiselect") {
        config = {
          options: (tf.options ?? []).map((o) => ({
            id: randOptionId(),
            label: o.label,
            color: o.color,
          })),
        };
      } else if (tf.type === "link") {
        const target = tf.linkTableKey ? tablesByKey.get(tf.linkTableKey) : null;
        config = target ? { targetTableId: target.id } : {};
      }
      const saved = await fieldRepo.save(
        fieldRepo.create({
          tableId: table.id,
          name: tf.name,
          type: tf.type,
          configJson: JSON.stringify(config),
          isPrimary: !!tf.isPrimary,
          sortOrder: (i + 1) * 1000,
        }),
      );
      fieldsByKey.set(`${tt.key}.${tf.key}`, saved);
    }
  }

  // 3. Rows. First pass: build a lookup from (tableKey, primary-value) →
  //    record id, so link cells in later rows can resolve forward references.
  //    We do this in two passes per table so a row can point at another row
  //    in the same table (rare, but cheap to support).
  const primaryByKeyValue = new Map<string, string>();

  // Create rows (empty links for now).
  const createdRowsByKey = new Map<string, { row: BaseRecord; template: TemplateRow; tableKey: string }[]>();
  for (const tt of template.tables) {
    const table = tablesByKey.get(tt.key)!;
    const primaryField = tt.fields.find((f) => f.isPrimary);
    const primaryDbId = primaryField ? fieldsByKey.get(`${tt.key}.${primaryField.key}`)!.id : null;

    const created: { row: BaseRecord; template: TemplateRow; tableKey: string }[] = [];
    for (let i = 0; i < tt.rows.length; i += 1) {
      const tr = tt.rows[i];
      const data: Record<string, unknown> = {};
      for (const tf of tt.fields) {
        if (tf.type === "link") continue; // second pass
        const cell = tr[tf.key];
        const fieldId = fieldsByKey.get(`${tt.key}.${tf.key}`)!.id;
        data[fieldId] = encodeCell(tf.type, cell, fieldsByKey.get(`${tt.key}.${tf.key}`)!);
      }
      const row = await recordRepo.save(
        recordRepo.create({
          tableId: table.id,
          dataJson: JSON.stringify(data),
          sortOrder: (i + 1) * 1000,
        }),
      );
      created.push({ row, template: tr, tableKey: tt.key });

      if (primaryField && primaryDbId) {
        const primVal = tr[primaryField.key];
        if (typeof primVal === "string") {
          primaryByKeyValue.set(`${tt.key}.${primVal}`, row.id);
        }
      }
    }
    createdRowsByKey.set(tt.key, created);
  }

  // Second pass — fill link cells now that sibling ids are known.
  for (const tt of template.tables) {
    const rows = createdRowsByKey.get(tt.key) ?? [];
    for (const { row, template: tr } of rows) {
      const current: Record<string, unknown> = JSON.parse(row.dataJson);
      let touched = false;
      for (const tf of tt.fields) {
        if (tf.type !== "link") continue;
        const cell = tr[tf.key];
        const fieldId = fieldsByKey.get(`${tt.key}.${tf.key}`)!.id;
        if (cell && typeof cell === "object" && !Array.isArray(cell) && "linkTo" in cell) {
          const ids: string[] = [];
          for (const label of cell.linkTo) {
            const id = primaryByKeyValue.get(`${tf.linkTableKey}.${label}`);
            if (id) ids.push(id);
          }
          current[fieldId] = ids;
          touched = true;
        }
      }
      if (touched) {
        row.dataJson = JSON.stringify(current);
        await recordRepo.save(row);
      }
    }
  }
}

function encodeCell(
  type: string,
  cell: TemplateRowCell | undefined,
  field: BaseField,
): unknown {
  if (cell === undefined || cell === null) return null;
  if (type === "number") return typeof cell === "number" ? cell : null;
  if (type === "checkbox") return !!cell;
  if (type === "select") {
    // Resolve label → option id.
    if (typeof cell !== "string") return null;
    const cfg = JSON.parse(field.configJson || "{}") as {
      options?: { id: string; label: string }[];
    };
    return cfg.options?.find((o) => o.label === cell)?.id ?? null;
  }
  if (type === "multiselect") {
    if (!Array.isArray(cell)) return [];
    const cfg = JSON.parse(field.configJson || "{}") as {
      options?: { id: string; label: string }[];
    };
    return cell
      .map((label) => cfg.options?.find((o) => o.label === label)?.id ?? null)
      .filter((x): x is string => !!x);
  }
  if (type === "link") return []; // handled in second pass
  return cell;
}

// ───── Hydrators: turn entities into the shape the client wants ──────────────

export type HydratedField = {
  id: string;
  tableId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isPrimary: boolean;
  sortOrder: number;
};

export type HydratedRecord = {
  id: string;
  tableId: string;
  data: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type LinkOption = { id: string; label: string; tableId: string };

export function hydrateField(f: BaseField): HydratedField {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(f.configJson || "{}");
  } catch {
    /* noop */
  }
  return {
    id: f.id,
    tableId: f.tableId,
    name: f.name,
    type: f.type,
    config,
    isPrimary: !!f.isPrimary,
    sortOrder: f.sortOrder,
  };
}

export function hydrateRecord(r: BaseRecord): HydratedRecord {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(r.dataJson || "{}");
  } catch {
    /* noop */
  }
  return {
    id: r.id,
    tableId: r.tableId,
    data,
    sortOrder: r.sortOrder,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Build the {id→primary label} map for the tables referenced by link fields
 * on a given set of fields. Used so a link cell in the UI can render the
 * target's primary text without a second request.
 */
export async function buildLinkOptionsFor(
  fields: BaseField[],
): Promise<Record<string, LinkOption[]>> {
  const targetIds = new Set<string>();
  for (const f of fields) {
    if (f.type !== "link") continue;
    try {
      const cfg = JSON.parse(f.configJson || "{}");
      if (typeof cfg.targetTableId === "string") targetIds.add(cfg.targetTableId);
    } catch {
      /* noop */
    }
  }
  if (targetIds.size === 0) return {};

  const tableIds = Array.from(targetIds);
  const [primaries, records] = await Promise.all([
    AppDataSource.getRepository(BaseField).find({
      where: { tableId: In(tableIds), isPrimary: true },
    }),
    AppDataSource.getRepository(BaseRecord).find({
      where: { tableId: In(tableIds) },
    }),
  ]);

  const primaryByTable = new Map<string, BaseField>();
  for (const p of primaries) primaryByTable.set(p.tableId, p);

  const byTable: Record<string, LinkOption[]> = {};
  for (const tid of tableIds) byTable[tid] = [];

  for (const r of records) {
    const primary = primaryByTable.get(r.tableId);
    let label = "(untitled)";
    if (primary) {
      const data = (() => {
        try {
          return JSON.parse(r.dataJson || "{}");
        } catch {
          return {};
        }
      })() as Record<string, unknown>;
      const v = data[primary.id];
      if (typeof v === "string" && v.trim()) label = v;
      else if (typeof v === "number") label = String(v);
    }
    byTable[r.tableId].push({ id: r.id, label, tableId: r.tableId });
  }
  return byTable;
}

// ───── Employee → Base access grants ────────────────────────────────────────

/**
 * Base grants mirror the IntegrationConnection grants: a simple join row
 * between an AIEmployee and a Base. One grant = full read/write on every
 * table in the base via MCP tools. Scope tightening is a future concern.
 */

export async function listBaseGrants(
  baseId: string,
): Promise<Array<EmployeeBaseGrant & { employee: AIEmployee | null }>> {
  const grants = await AppDataSource.getRepository(EmployeeBaseGrant).find({
    where: { baseId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return [];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(grants.map((g) => g.employeeId)) },
  });
  const byId = new Map(emps.map((e) => [e.id, e] as const));
  return grants.map((g) =>
    Object.assign(g, { employee: byId.get(g.employeeId) ?? null }),
  );
}

export async function listGrantedBasesForEmployee(
  employeeId: string,
): Promise<Base[]> {
  const grants = await AppDataSource.getRepository(EmployeeBaseGrant).find({
    where: { employeeId },
  });
  if (grants.length === 0) return [];
  return AppDataSource.getRepository(Base).find({
    where: { id: In(grants.map((g) => g.baseId)) },
    order: { createdAt: "ASC" },
  });
}

export async function grantBaseAccess(
  employeeId: string,
  baseId: string,
): Promise<EmployeeBaseGrant> {
  const repo = AppDataSource.getRepository(EmployeeBaseGrant);
  const existing = await repo.findOneBy({ employeeId, baseId });
  if (existing) return existing;
  const row = repo.create({ employeeId, baseId });
  await repo.save(row);
  return row;
}

export async function revokeBaseAccess(
  employeeId: string,
  baseId: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(EmployeeBaseGrant);
  const existing = await repo.findOneBy({ employeeId, baseId });
  if (!existing) return false;
  await repo.delete({ id: existing.id });
  return true;
}

export async function hasBaseGrant(
  employeeId: string,
  baseId: string,
): Promise<boolean> {
  const row = await AppDataSource.getRepository(EmployeeBaseGrant).findOneBy({
    employeeId,
    baseId,
  });
  return !!row;
}

/**
 * Clean up every grant targeting a base — called on base delete so the
 * join table doesn't accumulate orphan rows (SQLite FK enforcement is off
 * by default in our setup).
 */
export async function deleteGrantsForBase(baseId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeBaseGrant).delete({ baseId });
}

// ───── Record comments + attachments (hydrators shared by HTTP + MCP) ─────

export type RecordCommentAuthor =
  | { kind: "human"; id: string; name: string; email: string | null; avatarKey: string | null; handle: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string; avatarKey: string | null };

export type HydratedRecordComment = {
  id: string;
  recordId: string;
  body: string;
  authorUserId: string | null;
  authorEmployeeId: string | null;
  author: RecordCommentAuthor | null;
  createdAt: string;
  updatedAt: string;
};

export type RecordAttachmentUploader =
  | { kind: "human"; id: string; name: string }
  | { kind: "ai"; id: string; name: string; slug: string };

export type HydratedRecordAttachment = {
  id: string;
  recordId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  uploadedByUserId: string | null;
  uploadedByEmployeeId: string | null;
  uploader: RecordAttachmentUploader | null;
  createdAt: string;
};

/**
 * Attach author info (human Member or AI Employee) so the UI can render an
 * avatar + name without extra fetches. Mirrors {@link hydrateComments} for
 * todos but lives here so MCP tools can reuse it without pulling
 * projects.ts into the binary's dependency graph.
 */
export async function hydrateRecordComments(
  companyId: string,
  comments: BaseRecordComment[],
): Promise<HydratedRecordComment[]> {
  const userIds = [
    ...new Set(comments.map((c) => c.authorUserId).filter((x): x is string => !!x)),
  ];
  const empIds = [
    ...new Set(comments.map((c) => c.authorEmployeeId).filter((x): x is string => !!x)),
  ];
  const [users, emps] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    empIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds), companyId },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const empById = new Map(emps.map((e) => [e.id, e]));

  return comments.map((c) => {
    let author: RecordCommentAuthor | null = null;
    if (c.authorUserId) {
      const u = userById.get(c.authorUserId);
      if (u) {
        author = {
          kind: "human",
          id: u.id,
          name: u.name,
          email: u.email ?? null,
          avatarKey: u.avatarKey ?? null,
          handle: u.handle ?? null,
        };
      }
    } else if (c.authorEmployeeId) {
      const e = empById.get(c.authorEmployeeId);
      if (e) {
        author = {
          kind: "ai",
          id: e.id,
          name: e.name,
          slug: e.slug,
          role: e.role,
          avatarKey: e.avatarKey ?? null,
        };
      }
    }
    return {
      id: c.id,
      recordId: c.recordId,
      body: c.body,
      authorUserId: c.authorUserId,
      authorEmployeeId: c.authorEmployeeId,
      author,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  });
}

export async function hydrateRecordAttachments(
  companyId: string,
  attachments: BaseRecordAttachment[],
): Promise<HydratedRecordAttachment[]> {
  const userIds = [
    ...new Set(
      attachments.map((a) => a.uploadedByUserId).filter((x): x is string => !!x),
    ),
  ];
  const empIds = [
    ...new Set(
      attachments
        .map((a) => a.uploadedByEmployeeId)
        .filter((x): x is string => !!x),
    ),
  ];
  const [users, emps] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    empIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds), companyId },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const empById = new Map(emps.map((e) => [e.id, e]));

  return attachments.map((a) => {
    let uploader: RecordAttachmentUploader | null = null;
    if (a.uploadedByUserId) {
      const u = userById.get(a.uploadedByUserId);
      if (u) uploader = { kind: "human", id: u.id, name: u.name };
    } else if (a.uploadedByEmployeeId) {
      const e = empById.get(a.uploadedByEmployeeId);
      if (e) uploader = { kind: "ai", id: e.id, name: e.name, slug: e.slug };
    }
    return {
      id: a.id,
      recordId: a.recordId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: Number(a.sizeBytes),
      isImage: typeof a.mimeType === "string" && a.mimeType.startsWith("image/"),
      uploadedByUserId: a.uploadedByUserId,
      uploadedByEmployeeId: a.uploadedByEmployeeId,
      uploader,
      createdAt: a.createdAt.toISOString(),
    };
  });
}

/**
 * Walk a record up to its base + table for permission/audit logging. Returns
 * `null` if anything along the chain is missing — callers should respond with
 * 404 in that case.
 */
export async function loadRecordWithChain(
  recordId: string,
): Promise<{ record: BaseRecord; table: BaseTable; base: Base } | null> {
  const record = await AppDataSource.getRepository(BaseRecord).findOneBy({
    id: recordId,
  });
  if (!record) return null;
  const table = await AppDataSource.getRepository(BaseTable).findOneBy({
    id: record.tableId,
  });
  if (!table) return null;
  const base = await AppDataSource.getRepository(Base).findOneBy({
    id: table.baseId,
  });
  if (!base) return null;
  return { record, table, base };
}

// ───── Views (saved filter/sort/hidden-field configurations) ────────────────

export type HydratedBaseView = {
  id: string;
  tableId: string;
  name: string;
  slug: string;
  sortOrder: number;
  filters: unknown[];
  sorts: unknown[];
  hiddenFieldIds: string[];
  createdAt: string;
};

function safeParseArray(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function hydrateView(v: BaseView): HydratedBaseView {
  return {
    id: v.id,
    tableId: v.tableId,
    name: v.name,
    slug: v.slug,
    sortOrder: v.sortOrder,
    filters: safeParseArray(v.filtersJson),
    sorts: safeParseArray(v.sortsJson),
    hiddenFieldIds: safeParseArray(v.hiddenFieldsJson).filter(
      (x): x is string => typeof x === "string",
    ),
    createdAt: v.createdAt.toISOString(),
  };
}

export async function uniqueViewSlug(tableId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(BaseView);
  const seed = base || "view";
  let slug = seed;
  let n = 1;
  while (await repo.findOneBy({ tableId, slug })) {
    n += 1;
    slug = `${seed}-${n}`;
  }
  return slug;
}

/**
 * Make sure the given table has at least one view. Tables created before
 * BaseView existed don't have any rows, so we lazily seed a default "Grid view"
 * the first time the views endpoint is hit.
 */
export async function ensureDefaultView(tableId: string): Promise<BaseView> {
  const repo = AppDataSource.getRepository(BaseView);
  const existing = await repo.find({
    where: { tableId },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  if (existing.length > 0) return existing[0];
  const slug = await uniqueViewSlug(tableId, "grid-view");
  const saved = await repo.save(
    repo.create({
      tableId,
      name: "Grid view",
      slug,
      sortOrder: 1000,
      filtersJson: "[]",
      sortsJson: "[]",
      hiddenFieldsJson: "[]",
    }),
  );
  return saved;
}

export async function listViewsForTable(
  tableId: string,
): Promise<HydratedBaseView[]> {
  await ensureDefaultView(tableId);
  const rows = await AppDataSource.getRepository(BaseView).find({
    where: { tableId },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  return rows.map(hydrateView);
}

/** Used by the /new page to preview templates before the user commits. */
export function listTemplates() {
  return BASE_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    icon: t.icon,
    color: t.color,
    description: t.description,
    tableCount: t.tables.length,
    tableNames: t.tables.map((tt) => tt.name),
  }));
}
