import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Repository } from "../db/entities/Repository.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import type { RepositoryAccessLevel } from "../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import { validateBody } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRoleForMutations,
  onRoutePaths,
} from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import {
  credentialSummary,
  deleteGrantsForRepository,
  encryptRepoSecret,
  listDirectRepositoryGrants,
  testRepositoryConnection,
  uniqueRepositorySlug,
  upsertRepositoryGrant,
} from "../services/repositories.js";
import {
  repositoryCredentialError,
  repositoryCreateSchema,
  repositoryPatchSchema,
  gitRemoteUrlForResponse,
  isPlainHttpsCredentialUrl,
} from "../services/repositoryValidation.js";
import { normalizeAllowedCommands } from "../services/repositoryCommandPolicy.js";
import {
  describeRepositoryForge,
  loadForgeCandidates,
  matchForgeRemote,
  type RepositoryForgeInfo,
} from "../services/repositoryForge.js";
import {
  assertSafeGitRemoteUrl,
  SAFE_GIT_REMOTE_URL_MESSAGE,
} from "../services/gitCredentialHelper.js";
import { assertSafeBranchName } from "../services/repositoryWorkspace.js";
import { deleteTagAssignments } from "../services/tags.js";
import { removeRepositoryWorkspace } from "../services/repositoryWorkspace.js";
import { config } from "../../config.js";

/**
 * Repositories — provider-agnostic git repos the company adds so its AI
 * employees can read, edit, commit, and push real code. Humans manage the
 * repo (clone URL, credentials, committer identity) and decide which
 * employees may access it and at what level (`read` / `write`) via the
 * grant sub-routes. Credentials are encrypted at rest and never returned to
 * the client in plaintext.
 */
export const repositoriesRouter = Router({ mergeParams: true });
repositoriesRouter.use(requireAuth);
repositoriesRouter.use(requireCompanyMember);
repositoriesRouter.use(onRoutePaths(["/repositories"], requireBrowserSession));
repositoriesRouter.use(
  onRoutePaths(["/repositories"], requireCompanyRoleForMutations("admin")),
);
repositoriesRouter.use(
  onRoutePaths(["/repositories"], (req, res, next) => {
    if (
      config.security.multiTenant &&
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS"
    ) {
      return res.status(403).json({
        error:
          "Repositories are read-only in shared SaaS mode until git runs in a dedicated egress worker",
      });
    }
    next();
  }),
);

const ACCESS_LEVELS: [RepositoryAccessLevel, ...RepositoryAccessLevel[]] = ["read", "write"];

type CreatedBy = { kind: "human"; id: string; name: string; email: string | null } | null;

type HydratedRepo = Omit<Repository, "encryptedToken" | "encryptedSshKey"> & {
  hasToken: boolean;
  hasSshKey: boolean;
  grantCount: number;
  createdBy: CreatedBy;
  /**
   * The forge this remote lives on, or null when nothing here can speak to it.
   * Null is what hides the "Open pull request" button — a repository can still
   * be cloned, worked in, and pushed without one.
   */
  forge: RepositoryForgeInfo | null;
};

async function hydrate(companyId: string, rows: Repository[]): Promise<HydratedRepo[]> {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
  const [users, grants] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    AppDataSource.getRepository(EmployeeRepositoryGrant).find({
      where: { repositoryId: In(rows.map((r) => r.id)) },
    }),
  ]);
  // Decrypted once for the whole page rather than per row.
  const forgeCandidates = await loadForgeCandidates(companyId);
  const userById = new Map(users.map((u) => [u.id, u]));
  const grantCountByRepo = new Map<string, number>();
  for (const g of grants) {
    grantCountByRepo.set(g.repositoryId, (grantCountByRepo.get(g.repositoryId) ?? 0) + 1);
  }
  return rows.map((r) => {
    const { encryptedToken, encryptedSshKey, ...rest } = r;
    void encryptedToken;
    void encryptedSshKey;
    const u = r.createdById ? userById.get(r.createdById) : undefined;
    return {
      ...rest,
      gitUrl: gitRemoteUrlForResponse(rest.gitUrl),
      ...credentialSummary(r),
      grantCount: grantCountByRepo.get(r.id) ?? 0,
      forge: describeRepositoryForge(r, forgeCandidates),
      createdBy: u
        ? { kind: "human" as const, id: u.id, name: u.name, email: u.email ?? null }
        : null,
    };
  });
}

async function loadRepo(companyId: string, slug: string): Promise<Repository | null> {
  return AppDataSource.getRepository(Repository).findOneBy({
    companyId,
    slug,
  });
}

// ───────────────────────────── LIST ─────────────────────────────────────

repositoriesRouter.get("/repositories", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const rows = await AppDataSource.getRepository(Repository).find({
    where: { companyId: cid },
    order: { updatedAt: "DESC" },
  });
  res.json(await hydrate(cid, rows));
});

// ──────────────────────────── CREATE ────────────────────────────────────

repositoriesRouter.post(
  "/repositories",
  validateBody(repositoryCreateSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof repositoryCreateSchema>;
    const repo = AppDataSource.getRepository(Repository);

    const slug = await uniqueRepositorySlug(cid, body.name);
    const origin = body.origin ?? "remote";
    const row = repo.create({
      companyId: cid,
      name: body.name.trim(),
      slug,
      description: (body.description ?? "").trim(),
      origin,
      kind: body.kind ?? "code",
      gitUrl: origin === "local" ? "" : (body.gitUrl ?? "").trim(),
      defaultBranch: (body.defaultBranch ?? "main").trim() || "main",
      authMode: body.authMode,
      httpsUsername: body.authMode === "https" ? (body.httpsUsername ?? "").trim() || null : null,
      encryptedToken:
        body.authMode === "https" && body.token ? encryptRepoSecret(body.token, cid) : null,
      encryptedSshKey:
        body.authMode === "ssh" && body.sshKey ? encryptRepoSecret(body.sshKey, cid) : null,
      committerName: (body.committerName ?? "").trim() || null,
      committerEmail: (body.committerEmail ?? "").trim() || null,
      commandMode: body.commandMode ?? "allowlist",
      allowedCommands: normalizeAllowedCommands(body.allowedCommands ?? ""),
      lastSyncStatus: "unknown",
      lastSyncError: "",
      createdById: req.userId ?? null,
    });
    await repo.save(row);

    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "repository.create",
      targetType: "repository",
      targetId: row.id,
      targetLabel: row.name,
      metadata: {
        gitUrl: row.gitUrl,
        authMode: row.authMode,
        origin: row.origin,
        commandMode: row.commandMode,
      },
    });

    const [hydrated] = await hydrate(cid, [row]);
    res.status(201).json(hydrated);
  },
);

// ──────────────────────────── DETAIL ────────────────────────────────────

repositoriesRouter.get("/repositories/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });
  const [hydrated] = await hydrate(cid, [row]);
  res.json(hydrated);
});

// ───────────────────────────── PATCH ────────────────────────────────────

repositoriesRouter.patch(
  "/repositories/:slug",
  validateBody(repositoryPatchSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const body = req.body as z.infer<typeof repositoryPatchSchema>;

    const nextAuthMode = body.authMode ?? row.authMode;
    const nextGitUrl = (body.gitUrl ?? row.gitUrl).trim();
    // A local repository stays local until someone actually gives it a URL;
    // adding one promotes it, and that is the only way `origin` ever changes.
    const nextOrigin = nextGitUrl ? "remote" : "local";
    if (nextOrigin === "local" && nextAuthMode !== "none") {
      return res.status(400).json({
        error: "A local repository has no remote to authenticate to.",
      });
    }
    if (nextOrigin === "remote") {
      try {
        assertSafeGitRemoteUrl(nextGitUrl);
      } catch {
        return res.status(400).json({ error: SAFE_GIT_REMOTE_URL_MESSAGE });
      }
    }
    if (nextAuthMode === "https" && !isPlainHttpsCredentialUrl(nextGitUrl)) {
      return res.status(400).json({
        error:
          "HTTPS auth needs a plain https:// clone URL without embedded credentials or options.",
      });
    }
    const credentialError = repositoryCredentialError({
      authMode: nextAuthMode,
      hasStoredToken: !!row.encryptedToken,
      hasStoredSshKey: !!row.encryptedSshKey,
      token: body.token,
      sshKey: body.sshKey,
    });
    if (credentialError) {
      return res.status(400).json({ error: credentialError });
    }

    if (body.name !== undefined) row.name = body.name.trim();
    if (body.kind !== undefined) row.kind = body.kind;
    if (body.gitUrl !== undefined) row.gitUrl = body.gitUrl.trim();
    row.origin = nextOrigin;
    if (body.defaultBranch !== undefined) row.defaultBranch = body.defaultBranch.trim() || "main";
    if (body.description !== undefined) row.description = body.description.trim();
    if (body.committerName !== undefined) row.committerName = body.committerName.trim() || null;
    if (body.committerEmail !== undefined) row.committerEmail = body.committerEmail.trim() || null;

    // What an AI employee may run is the one setting on this row that widens
    // what a model can do, so a change to it is recorded even though the rest
    // of this handler records nothing. "Who turned off the command check, and
    // when" is a question a company will eventually ask.
    const priorCommandMode = row.commandMode;
    const priorAllowedCommands = row.allowedCommands;
    if (body.commandMode !== undefined) row.commandMode = body.commandMode;
    if (body.allowedCommands !== undefined) {
      row.allowedCommands = normalizeAllowedCommands(body.allowedCommands);
    }
    const commandPolicyChanged =
      row.commandMode !== priorCommandMode || row.allowedCommands !== priorAllowedCommands;

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
    if (body.token) row.encryptedToken = encryptRepoSecret(body.token, cid);
    if (body.sshKey) row.encryptedSshKey = encryptRepoSecret(body.sshKey, cid);

    await AppDataSource.getRepository(Repository).save(row);
    if (commandPolicyChanged) {
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "repository.commands.update",
        targetType: "repository",
        targetId: row.id,
        targetLabel: row.name,
        metadata: {
          from: priorCommandMode,
          to: row.commandMode,
          allowedCommandCount: row.allowedCommands
            ? row.allowedCommands.split("\n").filter(Boolean).length
            : 0,
        },
      });
    }
    const [hydrated] = await hydrate(cid, [row]);
    res.json(hydrated);
  },
);

// ──────────────────────────── DELETE ────────────────────────────────────

repositoriesRouter.delete("/repositories/:slug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });

  await deleteGrantsForRepository(row.id);
  await deleteTagAssignments("repository", row.id);
  const sessionIds = (
    await AppDataSource.getRepository(RepositoryWorkSession).find({
      where: { repositoryId: row.id },
      select: { id: true },
    })
  ).map((session) => session.id);
  if (sessionIds.length > 0) {
    await AppDataSource.getRepository(RepositoryWorkSessionTurn).delete({
      sessionId: In(sessionIds),
    });
  }
  await AppDataSource.getRepository(RepositoryWorkSession).delete({ repositoryId: row.id });
  // The App-owned checkout is derived state; it goes with the row it mirrors.
  removeRepositoryWorkspace(row.companyId, row.id);
  await AppDataSource.getRepository(Repository).delete({ id: row.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "repository.delete",
    targetType: "repository",
    targetId: row.id,
    targetLabel: row.name,
  });
  res.json({ ok: true });
});

// ────────────────────────── TEST CONNECTION ─────────────────────────────

repositoriesRouter.post("/repositories/:slug/test", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });
  const result = await testRepositoryConnection(row);
  row.lastSyncedAt = new Date();
  row.lastSyncStatus = result.ok ? "ok" : "error";
  row.lastSyncError = result.ok ? "" : result.message;
  // The probe asks the remote what its trunk is called, and the answer used to
  // be dropped on the floor. That is how `main` came to sit on repositories
  // whose trunk is `master` — invisible until something finally had to name
  // the branch to GitHub, at which point opening a pull request failed with a
  // validation error nobody could act on.
  if (result.ok && result.defaultBranch && result.defaultBranch !== row.defaultBranch) {
    // The name comes from the remote's own advertisement, so it is validated
    // before it is stored — an unusable one would otherwise sit on the row
    // until some later command refused it.
    try {
      assertSafeBranchName(result.defaultBranch);
      row.defaultBranch = result.defaultBranch;
    } catch {
      // Leave the row as it was; nothing here is worth failing the probe over.
    }
  }
  await AppDataSource.getRepository(Repository).save(row);
  res.json(result);
});

// ───────────────────────────── GRANTS ───────────────────────────────────

type GrantWithEmployee = EmployeeRepositoryGrant & {
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
    avatarKey: string | null;
    /**
     * A grant on a Connection that can speak for *this repository's* host
     * exposes the pull-request tool next run.
     *
     * Narrowed to the host on purpose. While GitHub was the only forge, "holds
     * a grant on any connected forge Connection" happened to be the same
     * question; with two it is not, and the loose version marked an employee
     * ready on a Forgejo repository because it had been granted the company's
     * GitHub account — a badge saying yes next to a tool that cannot resolve a
     * token for that server.
     */
    pullRequestReady: boolean;
  } | null;
};

async function hydrateGrants(
  companyId: string,
  repo: Repository,
  grants: EmployeeRepositoryGrant[],
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
  // Only the Connections that can authenticate THIS remote count. Everything
  // else is a credential for a different server.
  const match = matchForgeRemote(repo, await loadForgeCandidates(companyId));
  const forgeConnectionIds = new Set((match?.connections ?? []).map((connection) => connection.id));
  const prReadyEmployeeIds = new Set(
    connectionGrants
      .filter((grant) => forgeConnectionIds.has(grant.connectionId))
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

repositoriesRouter.get("/repositories/:slug/grants", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });
  const direct = await listDirectRepositoryGrants(row.id);
  res.json({ direct: await hydrateGrants(cid, row, direct) });
});

const createGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
});

repositoriesRouter.post(
  "/repositories/:slug/grants",
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
    const grant = await upsertRepositoryGrant(emp.id, row.id, body.accessLevel ?? "write");
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "repository.grant",
      targetType: "repository",
      targetId: row.id,
      targetLabel: row.name,
      metadata: { employeeId: emp.id, accessLevel: grant.accessLevel },
    });
    const [hydrated] = await hydrateGrants(cid, row, [grant]);
    res.json(hydrated);
  },
);

const patchGrantSchema = z.object({ accessLevel: z.enum(ACCESS_LEVELS) });

repositoriesRouter.patch(
  "/repositories/:slug/grants/:grantId",
  validateBody(patchGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const row = await loadRepo(cid, req.params.slug);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    const repo = AppDataSource.getRepository(EmployeeRepositoryGrant);
    const grant = await repo.findOneBy({
      id: req.params.grantId,
      repositoryId: row.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    grant.accessLevel = (req.body as z.infer<typeof patchGrantSchema>).accessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateGrants(cid, row, [grant]);
    res.json(hydrated);
  },
);

repositoriesRouter.delete("/repositories/:slug/grants/:grantId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });
  const repo = AppDataSource.getRepository(EmployeeRepositoryGrant);
  const grant = await repo.findOneBy({
    id: req.params.grantId,
    repositoryId: row.id,
  });
  if (!grant) return res.status(404).json({ error: "Grant not found" });
  await repo.delete({ id: grant.id });
  res.json({ ok: true });
});

repositoriesRouter.get("/repositories/:slug/grant-candidates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const row = await loadRepo(cid, req.params.slug);
  if (!row) return res.status(404).json({ error: "Repository not found" });
  const [emps, direct] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: cid },
      order: { createdAt: "ASC" },
    }),
    listDirectRepositoryGrants(row.id),
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
});
