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
import type { NoteAccessLevel } from "../db/entities/EmployeeNoteGrant.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { recordAudit } from "../services/audit.js";
import {
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
import fs from "node:fs";

/**
 * Resources — knowledge ingestion. Humans create rows by pasting a URL,
 * uploading a file (PDF / EPUB / TXT / MD / HTML), or pasting raw text.
 * The server extracts plain text on the spot, stores it on `bodyText`,
 * and surfaces the resulting Resource to AI employees through the MCP
 * tool surface (read-only) and to humans through the React UI.
 *
 * Access for AI is gated by `EmployeeResourceGrant`; humans bypass.
 */
export const resourcesRouter = Router({ mergeParams: true });
resourcesRouter.use(requireAuth);
resourcesRouter.use(requireCompanyMember);

const ACCESS_LEVELS: [NoteAccessLevel, ...NoteAccessLevel[]] = ["read", "write"];

type AuthorRef =
  | { kind: "human"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | null;

type HydratedResource = Omit<Resource, "bodyText"> & {
  bodyText?: string;
  bodyLength: number;
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
    const tagList = r.tags
      ? r.tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      : [];
    const out: HydratedResource = {
      ...r,
      bodyLength,
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
});

const createTextSchema = z.object({
  sourceKind: z.literal("text"),
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  summary: z.string().max(2000).optional(),
  tags: z.string().max(500).optional(),
});

const createBodySchema = z.discriminatedUnion("sourceKind", [
  createUrlSchema,
  createTextSchema,
]);

resourcesRouter.post(
  "/resources",
  validateBody(createBodySchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof createBodySchema>;
    const repo = AppDataSource.getRepository(Resource);

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
  },
);

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
  res.download(abs, row.sourceFilename ?? path.basename(abs));
});

// ----- PATCH -----

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2000).optional(),
  tags: z.string().max(500).optional(),
});

resourcesRouter.patch(
  "/resources/:slug",
  validateBody(patchSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadResource(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Resource not found" });
    const body = req.body as z.infer<typeof patchSchema>;
    if (body.title !== undefined) row.title = body.title;
    if (body.summary !== undefined) row.summary = body.summary.trim();
    if (body.tags !== undefined) row.tags = body.tags.trim();
    await AppDataSource.getRepository(Resource).save(row);
    const [hydrated] = await hydrate(cid, [row], { includeBody: true });
    res.json(hydrated);
  },
);

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
