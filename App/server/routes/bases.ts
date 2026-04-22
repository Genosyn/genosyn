import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseField, BaseFieldType } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { chatWithEmployee } from "../services/chat.js";
import {
  buildLinkOptionsFor,
  deleteGrantsForBase,
  grantBaseAccess,
  hydrateField,
  hydrateRecord,
  listBaseGrants,
  listTemplates,
  revokeBaseAccess,
  seedBaseFromTemplate,
  uniqueBaseSlug,
  uniqueTableSlug,
} from "../services/bases.js";
import { findBaseTemplate } from "../services/baseTemplates.js";
import { recordAudit } from "../services/audit.js";

export const basesRouter = Router({ mergeParams: true });
basesRouter.use(requireAuth);
basesRouter.use(requireCompanyMember);

const FIELD_TYPES: BaseFieldType[] = [
  "text",
  "longtext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "email",
  "url",
  "select",
  "multiselect",
  "link",
];
const COLORS = [
  "indigo",
  "emerald",
  "amber",
  "rose",
  "sky",
  "violet",
  "slate",
] as const;

// ─────────────────────────── helpers ─────────────────────────────────────────

async function loadBaseBySlug(cid: string, baseSlug: string) {
  return AppDataSource.getRepository(Base).findOneBy({
    companyId: cid,
    slug: baseSlug,
  });
}

async function loadTable(baseId: string, tableId: string) {
  return AppDataSource.getRepository(BaseTable).findOneBy({ id: tableId, baseId });
}

async function hydrateTables(baseId: string) {
  const tables = await AppDataSource.getRepository(BaseTable).find({
    where: { baseId },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  return tables;
}

// ─────────────────────────── templates ───────────────────────────────────────

basesRouter.get("/base-templates", (_req, res) => {
  res.json(listTemplates());
});

// ─────────────────────────── bases CRUD ──────────────────────────────────────

basesRouter.get("/bases", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const bases = await AppDataSource.getRepository(Base).find({
    where: { companyId: cid },
    order: { createdAt: "ASC" },
  });
  const counts = bases.length
    ? await AppDataSource.getRepository(BaseTable)
        .createQueryBuilder("t")
        .select("t.baseId", "baseId")
        .addSelect("COUNT(t.id)", "count")
        .where("t.baseId IN (:...ids)", { ids: bases.map((b) => b.id) })
        .groupBy("t.baseId")
        .getRawMany()
    : [];
  const byBase = new Map<string, number>(
    counts.map((c) => [String(c.baseId), Number(c.count)]),
  );
  res.json(bases.map((b) => ({ ...b, tableCount: byBase.get(b.id) ?? 0 })));
});

const createBaseSchema = z.object({
  name: z.string().min(1).max(80),
  templateId: z.string().optional(),
  icon: z.string().max(40).optional(),
  color: z.enum(COLORS).optional(),
  description: z.string().max(500).optional(),
});

basesRouter.post("/bases", validateBody(createBaseSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof createBaseSchema>;
  const template = body.templateId ? findBaseTemplate(body.templateId) : null;
  if (body.templateId && !template) {
    return res.status(400).json({ error: "Unknown template" });
  }

  const slug = await uniqueBaseSlug(cid, toSlug(body.name));
  const repo = AppDataSource.getRepository(Base);
  const b = await repo.save(
    repo.create({
      companyId: cid,
      name: body.name,
      slug,
      description: body.description ?? template?.description ?? "",
      icon: body.icon ?? template?.icon ?? "Database",
      color: body.color ?? template?.color ?? "indigo",
      createdById: req.userId ?? null,
    }),
  );
  if (template) await seedBaseFromTemplate(b.id, template);
  res.json(b);
});

basesRouter.get("/bases/:baseSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBaseBySlug(cid, req.params.baseSlug);
  if (!b) return res.status(404).json({ error: "Base not found" });
  const tables = await hydrateTables(b.id);
  res.json({ base: b, tables });
});

const patchBaseSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  icon: z.string().max(40).optional(),
  color: z.enum(COLORS).optional(),
});

basesRouter.patch(
  "/bases/:baseSlug",
  validateBody(patchBaseSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const body = req.body as z.infer<typeof patchBaseSchema>;
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    if (body.icon !== undefined) b.icon = body.icon;
    if (body.color !== undefined) b.color = body.color;
    await AppDataSource.getRepository(Base).save(b);
    res.json(b);
  },
);

basesRouter.delete("/bases/:baseSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBaseBySlug(cid, req.params.baseSlug);
  if (!b) return res.status(404).json({ error: "Base not found" });
  // Cascade delete: tables → fields + records → base.
  const tables = await AppDataSource.getRepository(BaseTable).find({
    where: { baseId: b.id },
  });
  const tableIds = tables.map((t) => t.id);
  if (tableIds.length) {
    await AppDataSource.getRepository(BaseRecord).delete({ tableId: In(tableIds) });
    await AppDataSource.getRepository(BaseField).delete({ tableId: In(tableIds) });
    await AppDataSource.getRepository(BaseTable).delete({ id: In(tableIds) });
  }
  await deleteGrantsForBase(b.id);
  await AppDataSource.getRepository(Base).delete({ id: b.id });
  res.json({ ok: true });
});

// ─────────────────────────── AI employee grants ──────────────────────────────

basesRouter.get("/bases/:baseSlug/grants", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBaseBySlug(cid, req.params.baseSlug);
  if (!b) return res.status(404).json({ error: "Base not found" });
  const rows = await listBaseGrants(b.id);
  res.json(
    rows
      .filter((r) => r.employee && r.employee.companyId === cid)
      .map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        baseId: r.baseId,
        createdAt: r.createdAt.toISOString(),
        employee: {
          id: r.employee!.id,
          name: r.employee!.name,
          slug: r.employee!.slug,
          role: r.employee!.role,
        },
      })),
  );
});

const createBaseGrantSchema = z.object({
  employeeId: z.string().uuid(),
});

basesRouter.post(
  "/bases/:baseSlug/grants",
  validateBody(createBaseGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const body = req.body as z.infer<typeof createBaseGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const grant = await grantBaseAccess(emp.id, b.id);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "base_grant.create",
      targetType: "base",
      targetId: b.id,
      targetLabel: `${b.name} → ${emp.name}`,
      metadata: { employeeId: emp.id, baseId: b.id },
    });
    res.json({
      id: grant.id,
      employeeId: grant.employeeId,
      baseId: grant.baseId,
      createdAt: grant.createdAt.toISOString(),
      employee: { id: emp.id, name: emp.name, slug: emp.slug, role: emp.role },
    });
  },
);

basesRouter.delete(
  "/bases/:baseSlug/grants/:employeeId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: req.params.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const ok = await revokeBaseAccess(emp.id, b.id);
    if (!ok) return res.status(404).json({ error: "Grant not found" });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "base_grant.delete",
      targetType: "base",
      targetId: b.id,
      targetLabel: `${b.name} → ${emp.name}`,
      metadata: { employeeId: emp.id, baseId: b.id },
    });
    res.json({ ok: true });
  },
);

// ─────────────────────────── tables ──────────────────────────────────────────

const createTableSchema = z.object({
  name: z.string().min(1).max(80),
});

basesRouter.post(
  "/bases/:baseSlug/tables",
  validateBody(createTableSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const body = req.body as z.infer<typeof createTableSchema>;
    const slug = await uniqueTableSlug(b.id, toSlug(body.name));
    const last = await AppDataSource.getRepository(BaseTable).findOne({
      where: { baseId: b.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await AppDataSource.getRepository(BaseTable).save(
      AppDataSource.getRepository(BaseTable).create({
        baseId: b.id,
        name: body.name,
        slug,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    // Seed with a primary "Name" field so the table is immediately usable.
    await AppDataSource.getRepository(BaseField).save(
      AppDataSource.getRepository(BaseField).create({
        tableId: saved.id,
        name: "Name",
        type: "text",
        configJson: "{}",
        isPrimary: true,
        sortOrder: 1000,
      }),
    );
    res.json(saved);
  },
);

const patchTableSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  sortOrder: z.number().optional(),
});

basesRouter.patch(
  "/bases/:baseSlug/tables/:tableId",
  validateBody(patchTableSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const body = req.body as z.infer<typeof patchTableSchema>;
    if (body.name !== undefined) t.name = body.name;
    if (body.sortOrder !== undefined) t.sortOrder = body.sortOrder;
    await AppDataSource.getRepository(BaseTable).save(t);
    res.json(t);
  },
);

basesRouter.delete("/bases/:baseSlug/tables/:tableId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const b = await loadBaseBySlug(cid, req.params.baseSlug);
  if (!b) return res.status(404).json({ error: "Base not found" });
  const t = await loadTable(b.id, req.params.tableId);
  if (!t) return res.status(404).json({ error: "Table not found" });
  await AppDataSource.getRepository(BaseRecord).delete({ tableId: t.id });
  await AppDataSource.getRepository(BaseField).delete({ tableId: t.id });
  await AppDataSource.getRepository(BaseTable).delete({ id: t.id });
  res.json({ ok: true });
});

// ─────────────────────────── table content ───────────────────────────────────

basesRouter.get(
  "/bases/:baseSlug/tables/:tableId/rows",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });

    const [fields, records] = await Promise.all([
      AppDataSource.getRepository(BaseField).find({
        where: { tableId: t.id },
        order: { sortOrder: "ASC", createdAt: "ASC" },
      }),
      AppDataSource.getRepository(BaseRecord).find({
        where: { tableId: t.id },
        order: { sortOrder: "ASC", createdAt: "ASC" },
      }),
    ]);

    const linkOptions = await buildLinkOptionsFor(fields);
    res.json({
      table: t,
      fields: fields.map(hydrateField),
      records: records.map(hydrateRecord),
      linkOptions,
    });
  },
);

// ─────────────────────────── fields ──────────────────────────────────────────

const createFieldSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(FIELD_TYPES as [BaseFieldType, ...BaseFieldType[]]),
  config: z.record(z.any()).optional(),
  isPrimary: z.boolean().optional(),
});

basesRouter.post(
  "/bases/:baseSlug/tables/:tableId/fields",
  validateBody(createFieldSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const body = req.body as z.infer<typeof createFieldSchema>;

    // Validate link target belongs to the same base.
    if (body.type === "link") {
      const target = (body.config ?? {}).targetTableId;
      if (typeof target !== "string") {
        return res.status(400).json({ error: "link field requires targetTableId" });
      }
      const tt = await AppDataSource.getRepository(BaseTable).findOneBy({ id: target });
      if (!tt || tt.baseId !== b.id) {
        return res.status(400).json({ error: "Link target must be a table in this base" });
      }
    }

    const last = await AppDataSource.getRepository(BaseField).findOne({
      where: { tableId: t.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await AppDataSource.getRepository(BaseField).save(
      AppDataSource.getRepository(BaseField).create({
        tableId: t.id,
        name: body.name,
        type: body.type,
        configJson: JSON.stringify(body.config ?? {}),
        isPrimary: !!body.isPrimary,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    if (body.isPrimary) {
      // Demote prior primary.
      await AppDataSource.getRepository(BaseField).update(
        { tableId: t.id, isPrimary: true, id: saved.id },
        { isPrimary: true },
      );
      await AppDataSource.getRepository(BaseField)
        .createQueryBuilder()
        .update()
        .set({ isPrimary: false })
        .where("tableId = :tid AND id != :sid", { tid: t.id, sid: saved.id })
        .execute();
    }
    res.json(hydrateField(saved));
  },
);

const patchFieldSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  config: z.record(z.any()).optional(),
  isPrimary: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

basesRouter.patch(
  "/bases/:baseSlug/tables/:tableId/fields/:fieldId",
  validateBody(patchFieldSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const f = await AppDataSource.getRepository(BaseField).findOneBy({
      id: req.params.fieldId,
      tableId: t.id,
    });
    if (!f) return res.status(404).json({ error: "Field not found" });
    const body = req.body as z.infer<typeof patchFieldSchema>;
    if (body.name !== undefined) f.name = body.name;
    if (body.config !== undefined) f.configJson = JSON.stringify(body.config);
    if (body.sortOrder !== undefined) f.sortOrder = body.sortOrder;
    if (body.isPrimary === true) {
      f.isPrimary = true;
      await AppDataSource.getRepository(BaseField)
        .createQueryBuilder()
        .update()
        .set({ isPrimary: false })
        .where("tableId = :tid AND id != :fid", { tid: t.id, fid: f.id })
        .execute();
    }
    await AppDataSource.getRepository(BaseField).save(f);
    res.json(hydrateField(f));
  },
);

basesRouter.delete(
  "/bases/:baseSlug/tables/:tableId/fields/:fieldId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const f = await AppDataSource.getRepository(BaseField).findOneBy({
      id: req.params.fieldId,
      tableId: t.id,
    });
    if (!f) return res.status(404).json({ error: "Field not found" });
    if (f.isPrimary) {
      return res
        .status(400)
        .json({ error: "Promote another field to primary before deleting this one" });
    }
    await AppDataSource.getRepository(BaseField).delete({ id: f.id });
    // Strip this field from every row. Cheap: records are small JSON blobs.
    const records = await AppDataSource.getRepository(BaseRecord).find({
      where: { tableId: t.id },
    });
    for (const r of records) {
      const data = JSON.parse(r.dataJson || "{}");
      if (f.id in data) {
        delete data[f.id];
        r.dataJson = JSON.stringify(data);
        await AppDataSource.getRepository(BaseRecord).save(r);
      }
    }
    res.json({ ok: true });
  },
);

// ─────────────────────────── records ─────────────────────────────────────────

const createRowSchema = z.object({
  data: z.record(z.any()).optional(),
});

basesRouter.post(
  "/bases/:baseSlug/tables/:tableId/rows",
  validateBody(createRowSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const body = req.body as z.infer<typeof createRowSchema>;

    const last = await AppDataSource.getRepository(BaseRecord).findOne({
      where: { tableId: t.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await AppDataSource.getRepository(BaseRecord).save(
      AppDataSource.getRepository(BaseRecord).create({
        tableId: t.id,
        dataJson: JSON.stringify(body.data ?? {}),
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    res.json(hydrateRecord(saved));
  },
);

const patchRowSchema = z.object({
  data: z.record(z.any()).optional(),
  /** If provided, replace one cell keyed by field id. Shortcut for single-cell edits. */
  fieldId: z.string().optional(),
  value: z.any().optional(),
  sortOrder: z.number().optional(),
});

basesRouter.patch(
  "/bases/:baseSlug/tables/:tableId/rows/:rowId",
  validateBody(patchRowSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const r = await AppDataSource.getRepository(BaseRecord).findOneBy({
      id: req.params.rowId,
      tableId: t.id,
    });
    if (!r) return res.status(404).json({ error: "Row not found" });
    const body = req.body as z.infer<typeof patchRowSchema>;

    const data: Record<string, unknown> = JSON.parse(r.dataJson || "{}");
    if (body.data !== undefined) {
      for (const [k, v] of Object.entries(body.data)) {
        if (v === null || v === undefined || v === "") delete data[k];
        else data[k] = v;
      }
    }
    if (body.fieldId) {
      if (body.value === null || body.value === undefined || body.value === "") {
        delete data[body.fieldId];
      } else {
        data[body.fieldId] = body.value;
      }
    }
    r.dataJson = JSON.stringify(data);
    if (body.sortOrder !== undefined) r.sortOrder = body.sortOrder;
    await AppDataSource.getRepository(BaseRecord).save(r);
    res.json(hydrateRecord(r));
  },
);

basesRouter.delete(
  "/bases/:baseSlug/tables/:tableId/rows/:rowId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const t = await loadTable(b.id, req.params.tableId);
    if (!t) return res.status(404).json({ error: "Table not found" });
    const r = await AppDataSource.getRepository(BaseRecord).findOneBy({
      id: req.params.rowId,
      tableId: t.id,
    });
    if (!r) return res.status(404).json({ error: "Row not found" });
    await AppDataSource.getRepository(BaseRecord).delete({ id: r.id });
    res.json({ ok: true });
  },
);

// ─────────────────────────── AI assistant ────────────────────────────────────

/**
 * Natural-language assistant for a Base. Picks the first AI employee that has
 * a connected model, frames the base's schema + the user's instruction, and
 * expects the employee to reply with either prose or a fenced JSON block of
 * actions the client can apply. See the prompt in `composeAssistantPrompt` for
 * the contract.
 */
const aiSchema = z.object({
  prompt: z.string().min(1).max(2000),
  tableId: z.string().optional(),
});

basesRouter.post(
  "/bases/:baseSlug/ai",
  validateBody(aiSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const b = await loadBaseBySlug(cid, req.params.baseSlug);
    if (!b) return res.status(404).json({ error: "Base not found" });
    const body = req.body as z.infer<typeof aiSchema>;

    // Pick an AI employee for this company that has a model row. The chat
    // service will itself error if the model is incomplete; we prefer to ask
    // and report than to silently pick a different one.
    const employees = await AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: cid },
    });
    if (employees.length === 0) {
      return res.json({
        status: "skipped",
        reply:
          "No AI employees in this company yet — hire one from the Employees tab, then connect their model to use the assistant.",
      });
    }
    const models = await AppDataSource.getRepository(AIModel).find({
      where: { employeeId: In(employees.map((e) => e.id)) },
    });
    const firstConnected = employees.find((e) => models.some((m) => m.employeeId === e.id));
    if (!firstConnected) {
      return res.json({
        status: "skipped",
        reply:
          "None of your AI employees have a connected model yet. Connect one from Employees → Settings → Model to use the assistant.",
      });
    }

    // Build a schema snapshot for the prompt.
    const tables = await AppDataSource.getRepository(BaseTable).find({
      where: { baseId: b.id },
      order: { sortOrder: "ASC" },
    });
    const fields = tables.length
      ? await AppDataSource.getRepository(BaseField).find({
          where: { tableId: In(tables.map((t) => t.id)) },
          order: { sortOrder: "ASC" },
        })
      : [];

    const promptText = composeAssistantPrompt(b.name, tables, fields, body);
    const result = await chatWithEmployee(cid, firstConnected.id, promptText, []);
    res.json({
      status: result.status,
      reply: result.reply,
      employee: { id: firstConnected.id, name: firstConnected.name, slug: firstConnected.slug },
    });
  },
);

function composeAssistantPrompt(
  baseName: string,
  tables: BaseTable[],
  fields: BaseField[],
  body: z.infer<typeof aiSchema>,
): string {
  const fieldsByTable = new Map<string, BaseField[]>();
  for (const f of fields) {
    if (!fieldsByTable.has(f.tableId)) fieldsByTable.set(f.tableId, []);
    fieldsByTable.get(f.tableId)!.push(f);
  }
  const schemaLines: string[] = [];
  for (const t of tables) {
    schemaLines.push(`- **${t.name}** (id \`${t.id}\`)`);
    for (const f of fieldsByTable.get(t.id) ?? []) {
      const primary = f.isPrimary ? " [primary]" : "";
      let typeLabel: string = f.type;
      if (f.type === "link") {
        try {
          const cfg = JSON.parse(f.configJson || "{}") as { targetTableId?: string };
          const target = tables.find((x) => x.id === cfg.targetTableId);
          typeLabel = target ? `link → ${target.name}` : "link";
        } catch {
          /* noop */
        }
      }
      schemaLines.push(`    - ${f.name} (${typeLabel})${primary}`);
    }
  }

  const scope = body.tableId
    ? `The user is looking at the table with id \`${body.tableId}\`.`
    : "The user is viewing the base overview.";

  return [
    `You are the Base Assistant — helping a teammate shape and query an Airtable-style base called **${baseName}**.`,
    "",
    "## Current schema",
    schemaLines.length ? schemaLines.join("\n") : "(no tables yet)",
    "",
    scope,
    "",
    "## How to respond",
    "1. Answer in plain English first — be concise.",
    "2. If the user asks for a schema/data change, suggest it in prose and do NOT execute anything. This UI applies changes manually for now.",
    "3. Stay within the shape of this base; do not invent external integrations.",
    "",
    "## User request",
    body.prompt,
  ].join("\n");
}
