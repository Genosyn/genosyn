import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import { EmployeeCodeRepositoryGrant } from "../db/entities/EmployeeCodeRepositoryGrant.js";
import type { CodeRepoAccessLevel } from "../db/entities/EmployeeCodeRepositoryGrant.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import {
  credentialSummary,
  deleteGrantsForCodeRepo,
  encryptRepoSecret,
  listDirectCodeRepoGrants,
  testCodeRepoConnection,
  uniqueCodeRepoSlug,
  upsertCodeRepoGrant,
} from "../services/codeRepos.js";
import { deleteTagAssignments } from "../services/tags.js";

/**
 * Code Repositories — provider-agnostic git repos the company adds so its AI
 * employees can read, edit, commit, and push real code. Humans manage the
 * repo (clone URL, credentials, committer identity) and decide which
 * employees may access it and at what level (`read` / `write`) via the
 * grant sub-routes. Credentials are encrypted at rest and never returned to
 * the client in plaintext.
 */
export const codeRepositoriesRouter = Router({ mergeParams: true });
codeRepositoriesRouter.use(requireAuth);
codeRepositoriesRouter.use(requireCompanyMember);

const ACCESS_LEVELS: [CodeRepoAccessLevel, ...CodeRepoAccessLevel[]] = [
  "read",
  "write",
];

// A clone URL is one of: https://…, ssh://…, or scp-style git@host:path.
const gitUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((v) => /^(https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(v.trim()), {
    message:
      "Enter an https://, ssh://, or git@host:owner/repo.git clone URL.",
  });

type CreatedBy =
  | { kind: "human"; id: string; name: string; email: string | null }
  | null;

type HydratedRepo = Omit<
  CodeRepository,
  "encryptedToken" | "encryptedSshKey"
> & {
  hasToken: boolean;
  hasSshKey: boolean;
  grantCount: number;
  createdBy: CreatedBy;
};

async function hydrate(
  companyId: string,
  rows: CodeRepository[],
): Promise<HydratedRepo[]> {
  if (rows.length === 0) return [];
  const userIds = [
    ...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x)),
  ];
  const [users, grants] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    AppDataSource.getRepository(EmployeeCodeRepositoryGrant).find({
      where: { codeRepositoryId: In(rows.map((r) => r.id)) },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const grantCountByRepo = new Map<string, number>();
  for (const g of grants) {
    grantCountByRepo.set(
      g.codeRepositoryId,
      (grantCountByRepo.get(g.codeRepositoryId) ?? 0) + 1,
    );
  }
  return rows.map((r) => {
    const { encryptedToken, encryptedSshKey, ...rest } = r;
    void encryptedToken;
    void encryptedSshKey;
    const u = r.createdById ? userById.get(r.createdById) : undefined;
    return {
      ...rest,
      ...credentialSummary(r),
      grantCount: grantCountByRepo.get(r.id) ?? 0,
      createdBy: u
        ? { kind: "human" as const, id: u.id, name: u.name, email: u.email ?? null }
        : null,
    };
  });
}

async function loadRepo(
  companyId: string,
  slug: string,
): Promise<CodeRepository | null> {
  return AppDataSource.getRepository(CodeRepository).findOneBy({
    companyId,
    slug,
  });
}

// ───────────────────────────── LIST ─────────────────────────────────────

codeRepositoriesRouter.get("/code-repositories", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const rows = await AppDataSource.getRepository(CodeRepository).find({
    where: { companyId: cid },
    order: { updatedAt: "DESC" },
  });
  res.json(await hydrate(cid, rows));
});

// ──────────────────────────── CREATE ────────────────────────────────────

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    gitUrl: gitUrlSchema,
    defaultBranch: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    authMode: z.enum(["none", "https", "ssh"]),
    httpsUsername: z.string().max(200).optional(),
    token: z.string().max(20000).optional(),
    sshKey: z.string().max(50000).optional(),
    committerName: z.string().max(200).optional(),
    committerEmail: z.string().email().max(320).optional().or(z.literal("")),
  })
  .refine((b) => b.authMode !== "https" || (b.token && b.token.length > 0), {
    message: "HTTPS auth needs a token / password.",
    path: ["token"],
  })
  .refine((b) => b.authMode !== "ssh" || (b.sshKey && b.sshKey.length > 0), {
    message: "SSH auth needs a private key.",
    path: ["sshKey"],
  });

codeRepositoriesRouter.post(
  "/code-repositories",
  validateBody(createSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof createSchema>;
    const repo = AppDataSource.getRepository(CodeRepository);

    const slug = await uniqueCodeRepoSlug(cid, body.name);
    const row = repo.create({
      companyId: cid,
      name: body.name.trim(),
      slug,
      description: (body.description ?? "").trim(),
      gitUrl: body.gitUrl.trim(),
      defaultBranch: (body.defaultBranch ?? "main").trim() || "main",
      authMode: body.authMode,
      httpsUsername:
        body.authMode === "https" ? (body.httpsUsername ?? "").trim() || null : null,
      encryptedToken:
        body.authMode === "https" && body.token
          ? encryptRepoSecret(body.token)
          : null,
      encryptedSshKey:
        body.authMode === "ssh" && body.sshKey
          ? encryptRepoSecret(body.sshKey)
          : null,
      committerName: (body.committerName ?? "").trim() || null,
      committerEmail: (body.committerEmail ?? "").trim() || null,
      lastSyncStatus: "unknown",
      lastSyncError: "",
      createdById: req.userId ?? null,
    });
    await repo.save(row);

    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "code_repository.create",
      targetType: "code_repository",
      targetId: row.id,
      targetLabel: row.name,
      metadata: { gitUrl: row.gitUrl, authMode: row.authMode },
    });

    const [hydrated] = await hydrate(cid, [row]);
    res.status(201).json(hydrated);
  },
);

// ──────────────────────────── DETAIL ────────────────────────────────────

codeRepositoriesRouter.get("/code-repositories/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });
  const [hydrated] = await hydrate(cid, [row]);
  res.json(hydrated);
});

// ───────────────────────────── PATCH ────────────────────────────────────

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  gitUrl: gitUrlSchema.optional(),
  defaultBranch: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  authMode: z.enum(["none", "https", "ssh"]).optional(),
  httpsUsername: z.string().max(200).optional(),
  /** New token/key. Empty string is ignored (leave existing in place). */
  token: z.string().max(20000).optional(),
  sshKey: z.string().max(50000).optional(),
  committerName: z.string().max(200).optional(),
  committerEmail: z.string().email().max(320).optional().or(z.literal("")),
});

codeRepositoriesRouter.patch(
  "/code-repositories/:slug",
  validateBody(patchSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const body = req.body as z.infer<typeof patchSchema>;

    if (body.name !== undefined) row.name = body.name.trim();
    if (body.gitUrl !== undefined) row.gitUrl = body.gitUrl.trim();
    if (body.defaultBranch !== undefined)
      row.defaultBranch = body.defaultBranch.trim() || "main";
    if (body.description !== undefined) row.description = body.description.trim();
    if (body.committerName !== undefined)
      row.committerName = body.committerName.trim() || null;
    if (body.committerEmail !== undefined)
      row.committerEmail = body.committerEmail.trim() || null;

    if (body.authMode !== undefined) {
      row.authMode = body.authMode;
      // Flipping to a mode wipes the now-irrelevant credential so a stale
      // secret can't linger and be silently reused.
      if (body.authMode !== "https") {
        row.encryptedToken = null;
        row.httpsUsername = null;
      }
      if (body.authMode !== "ssh") row.encryptedSshKey = null;
    }
    if (body.httpsUsername !== undefined) {
      row.httpsUsername = body.httpsUsername.trim() || null;
    }
    if (body.token) row.encryptedToken = encryptRepoSecret(body.token);
    if (body.sshKey) row.encryptedSshKey = encryptRepoSecret(body.sshKey);

    await AppDataSource.getRepository(CodeRepository).save(row);
    const [hydrated] = await hydrate(cid, [row]);
    res.json(hydrated);
  },
);

// ──────────────────────────── DELETE ────────────────────────────────────

codeRepositoriesRouter.delete("/code-repositories/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });

  await deleteGrantsForCodeRepo(row.id);
  await deleteTagAssignments("code_repository", row.id);
  await AppDataSource.getRepository(CodeRepository).delete({ id: row.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "code_repository.delete",
    targetType: "code_repository",
    targetId: row.id,
    targetLabel: row.name,
  });
  res.json({ ok: true });
});

// ────────────────────────── TEST CONNECTION ─────────────────────────────

codeRepositoriesRouter.post(
  "/code-repositories/:slug/test",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const result = await testCodeRepoConnection(row);
    row.lastSyncedAt = new Date();
    row.lastSyncStatus = result.ok ? "ok" : "error";
    row.lastSyncError = result.ok ? "" : result.message;
    await AppDataSource.getRepository(CodeRepository).save(row);
    res.json(result);
  },
);

// ───────────────────────────── GRANTS ───────────────────────────────────

type GrantWithEmployee = EmployeeCodeRepositoryGrant & {
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
    /** A connected GitHub Connection grant exposes a PR tool next run. */
    pullRequestReady: boolean;
  } | null;
};

async function hydrateGrants(
  companyId: string,
  grants: EmployeeCodeRepositoryGrant[],
): Promise<GrantWithEmployee[]> {
  if (grants.length === 0) return [];
  const empIds = [...new Set(grants.map((g) => g.employeeId))];
  const [emps, connectionGrants] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { id: In(empIds), companyId },
    }),
    AppDataSource.getRepository(EmployeeConnectionGrant).find({
      where: { employeeId: In(empIds) },
    }),
  ]);
  const connectionIds = [
    ...new Set(connectionGrants.map((grant) => grant.connectionId)),
  ];
  const githubConnections = connectionIds.length
    ? await AppDataSource.getRepository(IntegrationConnection).find({
        where: {
          id: In(connectionIds),
          companyId,
          provider: "github",
          status: "connected",
        },
      })
    : [];
  const githubConnectionIds = new Set(
    githubConnections.map((connection) => connection.id),
  );
  const prReadyEmployeeIds = new Set(
    connectionGrants
      .filter((grant) => githubConnectionIds.has(grant.connectionId))
      .map((grant) => grant.employeeId),
  );
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
            pullRequestReady: prReadyEmployeeIds.has(e.id),
          }
        : null,
    });
  });
}

codeRepositoriesRouter.get(
  "/code-repositories/:slug/grants",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const direct = await listDirectCodeRepoGrants(row.id);
    res.json({ direct: await hydrateGrants(cid, direct) });
  },
);

const createGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
});

codeRepositoriesRouter.post(
  "/code-repositories/:slug/grants",
  validateBody(createGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const body = req.body as z.infer<typeof createGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Unknown employee" });
    const grant = await upsertCodeRepoGrant(
      emp.id,
      row.id,
      body.accessLevel ?? "write",
    );
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "code_repository.grant",
      targetType: "code_repository",
      targetId: row.id,
      targetLabel: row.name,
      metadata: { employeeId: emp.id, accessLevel: grant.accessLevel },
    });
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

const patchGrantSchema = z.object({ accessLevel: z.enum(ACCESS_LEVELS) });

codeRepositoriesRouter.patch(
  "/code-repositories/:slug/grants/:grantId",
  validateBody(patchGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const repo = AppDataSource.getRepository(EmployeeCodeRepositoryGrant);
    const grant = await repo.findOneBy({
      id: req.params.grantId,
      codeRepositoryId: row.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    grant.accessLevel = (req.body as z.infer<typeof patchGrantSchema>).accessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

codeRepositoriesRouter.delete(
  "/code-repositories/:slug/grants/:grantId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const repo = AppDataSource.getRepository(EmployeeCodeRepositoryGrant);
    const grant = await repo.findOneBy({
      id: req.params.grantId,
      codeRepositoryId: row.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    await repo.delete({ id: grant.id });
    res.json({ ok: true });
  },
);

codeRepositoriesRouter.get(
  "/code-repositories/:slug/grant-candidates",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const [emps, direct] = await Promise.all([
      AppDataSource.getRepository(AIEmployee).find({
        where: { companyId: cid },
        order: { createdAt: "ASC" },
      }),
      listDirectCodeRepoGrants(row.id),
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
