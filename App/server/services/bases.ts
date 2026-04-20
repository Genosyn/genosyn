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
