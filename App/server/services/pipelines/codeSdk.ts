import { IsNull } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Base } from "../../db/entities/Base.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { BaseField } from "../../db/entities/BaseField.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import {
  createBaseRecordRow,
  deleteBaseRecordWithContents,
  hydrateField,
  mergeBaseRecordData,
  UUID_RE,
} from "../bases.js";

/**
 * The `genosyn` SDK handed to `logic.code` steps: Base record CRUD scoped to
 * the company that owns the pipeline.
 *
 * Like every pipeline handler, this runs as the company — the authoring gate
 * is upstream (only company admins can edit pipelines), so there is no
 * per-employee grant to check. Cells in `BaseRecord.dataJson` are keyed by
 * field id; the SDK accepts field *names* too and resolves them against the
 * table's fields, which also gives code steps the key validation the raw
 * HTTP/MCP write paths skip. Write semantics match the rest of the app:
 * setting a cell to null / undefined / "" clears it.
 */

export const MAX_BASE_OPS_PER_STEP = 200;
export const MAX_QUERY_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 100;

export type CodeSdkRecord = {
  id: string;
  tableId: string;
  /** Cell values keyed by field id — the storage keys. */
  fields: Record<string, unknown>;
  /** Cell values keyed by field name (first field wins on duplicate names). */
  values: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CodeSdkQueryOptions = {
  /** Field id or name → value. Array cells match when they contain the value. */
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
};

export type CodeSdkContext = {
  companyId: string;
  /** Epoch ms after which the step is over budget. */
  deadlineAt: number;
  log: (line: string) => void;
};

type LoadedTable = { base: Base; table: BaseTable; fields: BaseField[] };

export function makeCodeSdk(ctx: CodeSdkContext) {
  let remainingOps = MAX_BASE_OPS_PER_STEP;

  function begin(): void {
    if (Date.now() >= ctx.deadlineAt) throw new Error("Code step timed out");
    if (remainingOps <= 0) {
      throw new Error(`Base operation limit reached (${MAX_BASE_OPS_PER_STEP} per code step)`);
    }
    remainingOps -= 1;
  }

  async function loadBase(baseSlug: string): Promise<Base> {
    const slug = String(baseSlug ?? "").trim();
    if (!slug) throw new Error("baseSlug is required");
    const base = await AppDataSource.getRepository(Base).findOneBy({
      companyId: ctx.companyId,
      slug,
    });
    if (!base) throw new Error(`Base "${slug}" not found`);
    return base;
  }

  async function loadTable(baseSlug: string, tableSlug: string): Promise<LoadedTable> {
    const base = await loadBase(baseSlug);
    const slug = String(tableSlug ?? "").trim();
    if (!slug) throw new Error("tableSlug is required");
    const repo = AppDataSource.getRepository(BaseTable);
    const table =
      (await repo.findOneBy({ baseId: base.id, slug, archivedAt: IsNull() })) ||
      (UUID_RE.test(slug)
        ? await repo.findOneBy({ baseId: base.id, id: slug, archivedAt: IsNull() })
        : null);
    if (!table) throw new Error(`Table "${slug}" not found in base "${base.slug}"`);
    const fields = await AppDataSource.getRepository(BaseField).find({
      where: { tableId: table.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    return { base, table, fields };
  }

  function resolveField(fields: BaseField[], key: string): BaseField {
    const wanted = String(key);
    const byId = fields.find((f) => f.id === wanted);
    if (byId) return byId;
    const byName = fields.find((f) => f.name === wanted);
    if (byName) return byName;
    const byLowerName = fields.find((f) => f.name.toLowerCase() === wanted.toLowerCase());
    if (byLowerName) return byLowerName;
    const available = fields.map((f) => f.name).join(", ");
    throw new Error(`Unknown field "${wanted}" — available fields: ${available || "(none)"}`);
  }

  function parseData(record: BaseRecord): Record<string, unknown> {
    try {
      const parsed = JSON.parse(record.dataJson || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
    return {};
  }

  function toSdkRecord(record: BaseRecord, fields: BaseField[]): CodeSdkRecord {
    const data = parseData(record);
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (!(field.name in values) && field.id in data) {
        values[field.name] = data[field.id];
      }
    }
    return {
      id: record.id,
      tableId: record.tableId,
      fields: data,
      values,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  function assertPlainObject(raw: unknown, what: string): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${what} must be an object of field → value`);
    }
    return raw as Record<string, unknown>;
  }

  async function findRecord(loaded: LoadedTable, recordId: string): Promise<BaseRecord | null> {
    const id = String(recordId ?? "").trim();
    if (!id) throw new Error("recordId is required");
    // The uuid guard keeps a non-uuid id reading as "not found" instead of a
    // Postgres type error.
    if (!UUID_RE.test(id)) return null;
    return AppDataSource.getRepository(BaseRecord).findOneBy({
      id,
      tableId: loaded.table.id,
    });
  }

  async function loadRecord(loaded: LoadedTable, recordId: string): Promise<BaseRecord> {
    const record = await findRecord(loaded, recordId);
    if (!record) {
      throw new Error(
        `Record "${String(recordId ?? "").trim()}" not found in ${loaded.base.slug}/${loaded.table.slug}`,
      );
    }
    return record;
  }

  const base = {
    async listBases() {
      begin();
      const rows = await AppDataSource.getRepository(Base).find({
        where: { companyId: ctx.companyId },
        order: { createdAt: "ASC" },
      });
      return rows.map((b) => ({ id: b.id, name: b.name, slug: b.slug, description: b.description }));
    },

    async listTables(baseSlug: string) {
      begin();
      const b = await loadBase(baseSlug);
      const rows = await AppDataSource.getRepository(BaseTable).find({
        where: { baseId: b.id, archivedAt: IsNull() },
        order: { sortOrder: "ASC", createdAt: "ASC" },
      });
      return rows.map((t) => ({ id: t.id, name: t.name, slug: t.slug }));
    },

    async getTable(baseSlug: string, tableSlug: string) {
      begin();
      const { table, fields } = await loadTable(baseSlug, tableSlug);
      return {
        id: table.id,
        name: table.name,
        slug: table.slug,
        fields: fields.map((f) => hydrateField(f)),
      };
    },

    async createRecord(baseSlug: string, tableSlug: string, values: Record<string, unknown>) {
      begin();
      const loaded = await loadTable(baseSlug, tableSlug);
      const input = assertPlainObject(values, "values");
      const data: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === null || value === undefined || value === "") continue;
        data[resolveField(loaded.fields, key).id] = value;
      }
      const saved = await createBaseRecordRow(loaded.table.id, data);
      ctx.log(`base: created record ${saved.id} in ${loaded.base.slug}/${loaded.table.slug}`);
      return toSdkRecord(saved, loaded.fields);
    },

    async getRecord(baseSlug: string, tableSlug: string, recordId: string) {
      begin();
      const loaded = await loadTable(baseSlug, tableSlug);
      const record = await findRecord(loaded, recordId);
      return record ? toSdkRecord(record, loaded.fields) : null;
    },

    async queryRecords(baseSlug: string, tableSlug: string, options: CodeSdkQueryOptions = {}) {
      begin();
      const loaded = await loadTable(baseSlug, tableSlug);
      const rawLimit = Number(options?.limit ?? DEFAULT_QUERY_LIMIT);
      const limit = Math.max(
        1,
        Math.min(MAX_QUERY_LIMIT, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_QUERY_LIMIT),
      );
      const rawOffset = Number(options?.offset ?? 0);
      const offset = Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0);
      const dir = options?.order === "desc" ? ("DESC" as const) : ("ASC" as const);
      const repo = AppDataSource.getRepository(BaseRecord);

      if (!options?.where || Object.keys(options.where).length === 0) {
        const rows = await repo.find({
          where: { tableId: loaded.table.id },
          order: { sortOrder: dir, createdAt: dir },
          skip: offset,
          take: limit,
        });
        return rows.map((r) => toSdkRecord(r, loaded.fields));
      }

      const where = assertPlainObject(options.where, "where");
      const matchers = Object.entries(where).map(
        ([key, value]) => [resolveField(loaded.fields, key).id, value] as const,
      );
      // Filtering happens on parsed dataJson, which SQL can't do portably —
      // scan in chunks so one call never holds a whole large table in memory
      // and a selective lookup can stop as soon as it has enough matches.
      const CHUNK = 500;
      const matched: BaseRecord[] = [];
      const wanted = offset + limit;
      for (let skip = 0; matched.length < wanted; skip += CHUNK) {
        if (Date.now() >= ctx.deadlineAt) throw new Error("Code step timed out");
        const chunk = await repo.find({
          where: { tableId: loaded.table.id },
          order: { sortOrder: dir, createdAt: dir },
          skip,
          take: CHUNK,
        });
        for (const row of chunk) {
          const data = parseData(row);
          const hit = matchers.every(([fieldId, expected]) => {
            const cell = data[fieldId];
            if (Array.isArray(cell)) return cell.includes(expected);
            return cell === expected;
          });
          if (hit) {
            matched.push(row);
            if (matched.length >= wanted) break;
          }
        }
        if (chunk.length < CHUNK) break;
      }
      return matched.slice(offset, offset + limit).map((r) => toSdkRecord(r, loaded.fields));
    },

    async countRecords(baseSlug: string, tableSlug: string) {
      begin();
      const loaded = await loadTable(baseSlug, tableSlug);
      return AppDataSource.getRepository(BaseRecord).countBy({ tableId: loaded.table.id });
    },

    async updateRecord(
      baseSlug: string,
      tableSlug: string,
      recordId: string,
      values: Record<string, unknown>,
    ) {
      begin();
      const loaded = await loadTable(baseSlug, tableSlug);
      const record = await loadRecord(loaded, recordId);
      const input = assertPlainObject(values, "values");
      // Resolve field names to storage ids before the shared merge applies the
      // null / undefined / "" clears-the-cell semantics.
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        updates[resolveField(loaded.fields, key).id] = value;
      }
      const data = mergeBaseRecordData(parseData(record), updates);
      record.dataJson = JSON.stringify(data);
      const saved = await AppDataSource.getRepository(BaseRecord).save(record);
      ctx.log(`base: updated record ${saved.id} in ${loaded.base.slug}/${loaded.table.slug}`);
      return toSdkRecord(saved, loaded.fields);
    },

    async deleteRecord(baseSlug: string, tableSlug: string, recordId: string) {
      begin();
      const loaded = await loadTable(baseSlug, tableSlug);
      const record = await loadRecord(loaded, recordId);
      await deleteBaseRecordWithContents(record, ctx.companyId);
      ctx.log(`base: deleted record ${record.id} from ${loaded.base.slug}/${loaded.table.slug}`);
      return true;
    },
  };

  return Object.freeze({ base: Object.freeze(base) });
}
