import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Resource } from "../db/entities/Resource.js";
import type { ResourceSourceKind } from "../db/entities/Resource.js";
import { Company } from "../db/entities/Company.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import {
  EmployeeResourceGrant,
} from "../db/entities/EmployeeResourceGrant.js";
import type { ResourceAccessLevel } from "../db/entities/EmployeeResourceGrant.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { recordAudit } from "../services/audit.js";
import {
  RESOURCE_BODY_TEXT_CAP,
  RESOURCE_MAX_BYTES,
  deleteGrantsForResource,
  deleteResourceBytes,
  epubFileToText,
  fetchUrlAsText,
  grantResourceToAllEmployees,
  htmlToText,
  inferSourceKindFromFilename,
  resourceUploadMiddleware,
  listDirectResourceGrants,
  pdfBufferToText,
  resolveResourceFile,
  summarize,
  trimBodyText,
  uniqueResourceSlug,
  upsertResourceGrant,
} from "../services/resources.js";
import {
  EXPORT_FORMATS,
  exportResource,
  isExportFormat,
} from "../services/resourceExport.js";
import fs from "node:fs";
import { Tag } from "../db/entities/Tag.js";
import {
  deleteTagAssignments,
  replaceResourceTagNames,
  replaceResourceTags,
  tagsByResourceIds,
  validateCompanyTagIds,
} from "../services/tags.js";

/**
 * Resources — knowledge ingestion. Humans create rows by pasting a URL,
 * uploading a file (PDF / EPUB / TXT / MD / HTML), or pasting raw text.
 * The server extracts plain text on the spot, stores it on `bodyText`,
 * and surfaces the resulting Resource to AI employees through the MCP
 * tool surface (`list_resources` / `search_resources` / `get_resource`
 * for reading; `create_resource` / `update_resource` / `delete_resource`
 * for curating). The AI surface uses three escalating grants:
 * `read` < `edit` < `delete`. Humans bypass the grant table.
 */
export const resourcesRouter = Router({ mergeParams: true });
resourcesRouter.use(requireAuth);
resourcesRouter.use(requireCompanyMember);

const ACCESS_LEVELS: [ResourceAccessLevel, ...ResourceAccessLevel[]] = [
  "read",
  "edit",
  "delete",
];

type AuthorRef =
  | { kind: "human"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | null;

type HydratedResource = Omit<Resource, "bodyText" | "tags"> & {
  bodyText?: string;
  bodyLength: number;
  tags: Tag[];
  tagList: string[];
  createdBy: AuthorRef;
};

/**
 * Most list views don't need the full extracted body, only its length.
 * `includeBody` flips it on for the detail page.
 */
async function hydrate(
  companyId: string,
  rows: Resource[],
  opts: { includeBody?: boolean } = {},
): Promise<HydratedResource[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x)),
  ];
  const empIds = [
    ...new Set(
      rows
        .map((r) => r.createdByEmployeeId)
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
  const resourceTags = await tagsByResourceIds(
    companyId,
    "resource",
    rows.map((row) => row.id),
  );
  return rows.map((r) => {
    let createdBy: AuthorRef = null;
    if (r.createdById) {
      const u = userById.get(r.createdById);
      if (u) {
        createdBy = {
          kind: "human",
          id: u.id,
          name: u.name,
          email: u.email ?? null,
        };
      }
    } else if (r.createdByEmployeeId) {
      const e = empById.get(r.createdByEmployeeId);
      if (e) {
        createdBy = {
          kind: "ai",
          id: e.id,
          name: e.name,
          slug: e.slug,
          role: e.role,
        };
      }
    }
    const bodyLength = r.bodyText?.length ?? 0;
    const tags = resourceTags.get(r.id) ?? [];
    const tagList = tags.map((tag) => tag.name);
    const { tags: _legacyTags, ...resource } = r;
    const out: HydratedResource = {
      ...resource,
      bodyLength,
      tags,
      tagList,
      createdBy,
    };
    if (!opts.includeBody) delete out.bodyText;
    return out;
  });
}

// ----- LIST -----

resourcesRouter.get("/resources", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const rows = await AppDataSource.getRepository(Resource).find({
    where: { companyId: cid },
    order: { updatedAt: "DESC" },
  });
  res.json(await hydrate(cid, rows));
});

// ----- CREATE: URL or paste -----

const createUrlSchema = z.object({
  sourceKind: z.literal("url"),
  url: z.string().url().max(2000),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2000).optional(),
  tags: z.string().max(500).optional(),
  tagIds: z.array(z.string().uuid()).max(20).optional(),
});

const createTextSchema = z.object({
  sourceKind: z.literal("text"),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  summary: z.string().max(2000).optional(),
  tags: z.string().max(500).optional(),
  tagIds: z.array(z.string().uuid()).max(20).optional(),
});

const createBodySchema = z.discriminatedUnion("sourceKind", [createUrlSchema, createTextSchema]);

resourcesRouter.post("/resources", validateBody(createBodySchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof createBodySchema>;
  const repo = AppDataSource.getRepository(Resource);

  if (body.tagIds) {
    try {
      await validateCompanyTagIds(cid, body.tagIds);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: message });
    }
  }

  let title = "";
  let summary = "";
  let bodyText = "";
  let status: "ready" | "failed" = "ready";
  let errorMessage = "";
  let bytes = 0;
  let sourceUrl: string | null = null;

  if (body.sourceKind === "url") {
    sourceUrl = body.url;
    try {
      const fetched = await fetchUrlAsText(body.url);
      title = (body.title ?? fetched.title ?? body.url).slice(0, 200);
      bodyText = trimBodyText(fetched.text);
      bytes = bodyText.length;
      summary = summarize(bodyText, body.summary);
    } catch (err) {
      title = (body.title ?? body.url).slice(0, 200);
      status = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      summary = body.summary?.trim() ?? "";
    }
  } else {
    title = body.title;
    bodyText = trimBodyText(body.body);
    bytes = bodyText.length;
    summary = summarize(bodyText, body.summary);
  }

  const slug = await uniqueResourceSlug(cid, toSlug(title) || "resource");
  const row = repo.create({
    companyId: cid,
    title,
    slug,
    sourceKind: body.sourceKind,
    sourceUrl,
    sourceFilename: null,
    storageKey: null,
    summary,
    bodyText,
    tags: (body.tags ?? "").trim(),
    bytes,
    status,
    errorMessage,
    createdById: req.userId ?? null,
    createdByEmployeeId: null,
  });
  await repo.save(row);
  if (body.tagIds) {
    await replaceResourceTags(cid, "resource", row.id, body.tagIds);
  } else if (body.tags) {
    await replaceResourceTagNames(cid, "resource", row.id, body.tags);
  }

  const grantedCount = await grantResourceToAllEmployees(cid, row.id);

  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "resource.create",
    targetType: "resource",
    targetId: row.id,
    targetLabel: row.title,
    metadata: {
      sourceKind: row.sourceKind,
      bytes: Number(row.bytes),
      status: row.status,
      grantedToEmployees: grantedCount,
    },
  });

  const [hydrated] = await hydrate(cid, [row], { includeBody: false });
  res.status(201).json(hydrated);
});

// ----- CREATE: file upload -----

resourcesRouter.post(
  "/resources/upload",
  async (req, res, next) => {
    const cid = (req.params as Record<string, string>).cid;
    const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
    if (!co) return res.status(404).json({ error: "Company not found" });
    (req as unknown as { company: Company }).company = co;
    next();
  },
  resourceUploadMiddleware.single("file"),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const co = (req as unknown as { company?: Company }).company;
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!co) return res.status(404).json({ error: "Company not found" });
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    if (file.size > RESOURCE_MAX_BYTES) {
      return res.status(400).json({ error: "File exceeds the 25 MB cap" });
    }

    const sourceKind: ResourceSourceKind = inferSourceKindFromFilename(
      file.originalname,
    );
    const titleHint = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[-_]+/g, " ")
      .trim();
    const title = (
      (req.body as Record<string, string>)?.title ?? titleHint ?? "Untitled"
    ).slice(0, 200);

    let bodyText = "";
    let status: "ready" | "failed" = "ready";
    let errorMessage = "";

    try {
      if (sourceKind === "pdf") {
        const buf = await fs.promises.readFile(file.path);
        const text = await pdfBufferToText(buf);
        bodyText = trimBodyText(text);
      } else if (sourceKind === "epub") {
        const text = await epubFileToText(file.path);
        bodyText = trimBodyText(text);
      } else if (sourceKind === "video") {
        // Accept the upload but flag it — ASR is deliberately out of v1.
        status = "failed";
        errorMessage =
          "Video transcripts aren't supported yet. Upload a transcript as text or paste the URL of one.";
      } else {
        // text / .txt / .md / .html — read as utf8.
        const buf = await fs.promises.readFile(file.path);
        const ext = path.extname(file.originalname).toLowerCase();
        const raw = buf.toString("utf8");
        if (ext === ".html" || ext === ".htm") {
          bodyText = trimBodyText(htmlToText(raw).text);
        } else {
          bodyText = trimBodyText(raw);
        }
      }
    } catch (err) {
      status = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const summary = (req.body as Record<string, string>)?.summary;
    const tags = (req.body as Record<string, string>)?.tags ?? "";
    const tagIdsInput = (req.body as Record<string, string>)?.tagIds;
    let tagIdsToAssign: string[] | null = null;
    if (tagIdsInput) {
      let rawTagIds: unknown;
      try {
        rawTagIds = JSON.parse(tagIdsInput);
      } catch {
        return res.status(400).json({ error: "Invalid tag ids" });
      }
      const parsed = z.array(z.string().uuid()).max(20).safeParse(rawTagIds);
      if (!parsed.success) return res.status(400).json({ error: "Invalid tag ids" });
      tagIdsToAssign = parsed.data;
      try {
        await validateCompanyTagIds(cid, tagIdsToAssign);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: message });
      }
    }
    const slug = await uniqueResourceSlug(cid, toSlug(title) || "resource");

    const row = AppDataSource.getRepository(Resource).create({
      companyId: cid,
      title,
      slug,
      sourceKind,
      sourceUrl: null,
      sourceFilename: file.originalname,
      storageKey: path.basename(file.path),
      summary: summarize(bodyText, summary),
      bodyText,
      tags: tags.trim(),
      bytes: file.size,
      status,
      errorMessage,
      createdById: req.userId ?? null,
      createdByEmployeeId: null,
    });
    await AppDataSource.getRepository(Resource).save(row);
    if (tagIdsToAssign) {
      await replaceResourceTags(cid, "resource", row.id, tagIdsToAssign);
    } else if (tags) {
      await replaceResourceTagNames(cid, "resource", row.id, tags);
    }

    const grantedCount = await grantResourceToAllEmployees(cid, row.id);

    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "resource.create",
      targetType: "resource",
      targetId: row.id,
      targetLabel: row.title,
      metadata: {
        sourceKind: row.sourceKind,
        bytes: Number(row.bytes),
        status: row.status,
        filename: row.sourceFilename,
        grantedToEmployees: grantedCount,
      },
    });

    const [hydrated] = await hydrate(cid, [row], { includeBody: false });
    res.status(201).json(hydrated);
  },
);

// ----- DETAIL -----

async function loadResource(
  companyId: string,
  slug: string,
): Promise<Resource | null> {
  return AppDataSource.getRepository(Resource).findOneBy({ companyId, slug });
}

resourcesRouter.get("/resources/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadResource(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Resource not found" });
  const [hydrated] = await hydrate(cid, [row], { includeBody: true });
  res.json(hydrated);
});

resourcesRouter.get("/resources/:slug/file", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadResource(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Resource not found" });
  if (!row.storageKey) {
    return res.status(404).json({ error: "Original file unavailable" });
  }
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return res.status(404).json({ error: "Company not found" });
  const abs = resolveResourceFile(co.slug, row.storageKey);
  if (!abs) return res.status(404).json({ error: "File missing on disk" });
  // `disposition=attachment` forces a download; default is inline so the
  // browser can render PDFs and our EPUB viewer can fetch the bytes via
  // an in-page request without triggering the download dialog.
  const filename = row.sourceFilename ?? path.basename(abs);
  const disposition =
    (req.query.disposition as string | undefined) === "attachment"
      ? "attachment"
      : "inline";
  const contentType =
    row.sourceKind === "pdf"
      ? "application/pdf"
      : row.sourceKind === "epub"
        ? "application/epub+zip"
        : undefined;
  if (contentType) res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${filename.replace(/"/g, "")}"`,
  );
  res.sendFile(abs);
});

// ----- EXPORT -----

/**
 * Render a resource body in a downloadable format. Used by the human
 * Download menu and by the `export_resource` MCP tool. Markdown / plain
 * text are passed through; HTML is rendered via `marked`; PDF
 * round-trips that HTML through Chromium so the result honours the same
 * styling humans see in the browser.
 */
resourcesRouter.get("/resources/:slug/export", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const format = (req.query.format as string | undefined) ?? "pdf";
  if (!isExportFormat(format)) {
    return res.status(400).json({
      error: `Unsupported format. Use one of: ${EXPORT_FORMATS.join(", ")}.`,
    });
  }
  const row = await loadResource(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Resource not found" });
  if (!row.bodyText || row.bodyText.length === 0) {
    return res
      .status(400)
      .json({ error: "Resource has no body to export." });
  }
  try {
    const artifact = await exportResource(row, format);
    res.setHeader("Content-Type", artifact.mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${artifact.filename.replace(/"/g, "")}"`,
    );
    res.setHeader("Content-Length", String(artifact.buffer.length));
    res.end(artifact.buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Failed to export: ${message}` });
  }
});

// ----- PATCH -----

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2000).optional(),
  tags: z.string().max(500).optional(),
  body: z.string().max(RESOURCE_BODY_TEXT_CAP).optional(),
});

resourcesRouter.patch("/resources/:slug", validateBody(patchSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadResource(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Resource not found" });
  const body = req.body as z.infer<typeof patchSchema>;
  if (body.title !== undefined) row.title = body.title;
  if (body.summary !== undefined) row.summary = body.summary.trim();
  if (body.tags !== undefined) row.tags = body.tags.trim();
  if (body.body !== undefined) {
    // Only `text` resources are editable — for PDF/EPUB/URL the body is
    // an extracted preview that should match the original source, so
    // letting humans drift it would silently break search results.
    if (row.sourceKind !== "text") {
      return res.status(400).json({ error: "Only text resources can have their body edited" });
    }
    const trimmed = trimBodyText(body.body);
    row.bodyText = trimmed;
    row.bytes = trimmed.length;
    // Auto-regenerate the summary when the caller didn't pass one — the
    // detail page no longer surfaces the summary, but the index list
    // still uses it as preview text and a stale summary would be
    // misleading.
    if (body.summary === undefined) {
      row.summary = summarize(trimmed);
    }
    row.status = "ready";
    row.errorMessage = "";
  }
  await AppDataSource.getRepository(Resource).save(row);
  if (body.tags !== undefined) {
    await replaceResourceTagNames(cid, "resource", row.id, body.tags);
  }
  const [hydrated] = await hydrate(cid, [row], { includeBody: true });
  res.json(hydrated);
});

// ----- DELETE -----

resourcesRouter.delete("/resources/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadResource(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Resource not found" });
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: cid });
  if (!co) return res.status(404).json({ error: "Company not found" });

  await deleteGrantsForResource(row.id);
  if (row.storageKey) {
    await deleteResourceBytes(row.storageKey, co.slug);
  }
  await deleteTagAssignments("resource", row.id);
  await AppDataSource.getRepository(Resource).delete({ id: row.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "resource.delete",
    targetType: "resource",
    targetId: row.id,
    targetLabel: row.title,
  });
  res.json({ ok: true });
});

// ----- GRANTS -----

type GrantWithEmployee = EmployeeResourceGrant & {
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
  } | null;
};

async function hydrateGrants(
  companyId: string,
  grants: EmployeeResourceGrant[],
): Promise<GrantWithEmployee[]> {
  if (grants.length === 0) return [];
  const empIds = [...new Set(grants.map((g) => g.employeeId))];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(empIds), companyId },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return grants.map((g) => {
    const e = byId.get(g.employeeId);
    return Object.assign(g, {
      employee: e
        ? {
            id: e.id,
            name: e.name,
            slug: e.slug,
            role: e.role,
            avatarKey: e.avatarKey ?? null,
          }
        : null,
    });
  });
}

resourcesRouter.get("/resources/:slug/grants", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadResource(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Resource not found" });
  const direct = await listDirectResourceGrants(row.id);
  res.json({ direct: await hydrateGrants(cid, direct) });
});

const createGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
});

resourcesRouter.post(
  "/resources/:slug/grants",
  validateBody(createGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadResource(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Resource not found" });
    const body = req.body as z.infer<typeof createGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Unknown employee" });
    const grant = await upsertResourceGrant(
      emp.id,
      row.id,
      body.accessLevel ?? "read",
    );
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

const patchGrantSchema = z.object({
  accessLevel: z.enum(ACCESS_LEVELS),
});

resourcesRouter.patch(
  "/resources/:slug/grants/:grantId",
  validateBody(patchGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadResource(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Resource not found" });
    const repo = AppDataSource.getRepository(EmployeeResourceGrant);
    const grant = await repo.findOneBy({
      id: req.params.grantId,
      resourceId: row.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    const body = req.body as z.infer<typeof patchGrantSchema>;
    grant.accessLevel = body.accessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

resourcesRouter.delete(
  "/resources/:slug/grants/:grantId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadResource(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Resource not found" });
    const repo = AppDataSource.getRepository(EmployeeResourceGrant);
    const grant = await repo.findOneBy({
      id: req.params.grantId,
      resourceId: row.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    await repo.delete({ id: grant.id });
    res.json({ ok: true });
  },
);

resourcesRouter.get(
  "/resources/:slug/grant-candidates",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadResource(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Resource not found" });
    const [emps, direct] = await Promise.all([
      AppDataSource.getRepository(AIEmployee).find({
        where: { companyId: cid },
        order: { createdAt: "ASC" },
      }),
      listDirectResourceGrants(row.id),
    ]);
    const grantedSet = new Set(direct.map((g) => g.employeeId));
    res.json(
      emps.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        role: e.role,
        avatarKey: e.avatarKey ?? null,
        alreadyGranted: grantedSet.has(e.id),
      })),
    );
  },
);
