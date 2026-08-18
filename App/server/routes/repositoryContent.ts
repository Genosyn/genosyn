import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Repository } from "../db/entities/Repository.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { User } from "../db/entities/User.js";
import { validateBody } from "../middleware/validate.js";
import {
  requireAuth,
  requireBrowserSession,
  requireCompanyMember,
  requireCompanyRole,
} from "../middleware/auth.js";
import { recordAudit } from "../services/audit.js";
import { config } from "../../config.js";
import {
  MAX_EDITABLE_FILE_BYTES,
  checkoutRepositoryBranch,
  commitRepositoryChanges,
  createRepositoryBranch,
  createRepositoryDirectory,
  deleteRepositoryEntry,
  discardRepositoryChanges,
  ensureRepositoryWorkspace,
  listRepositoryTree,
  moveRepositoryEntry,
  pullRepositoryBranch,
  pushRepositoryBranch,
  readRepositoryFile,
  repositoryBranches,
  repositoryCheckoutExists,
  repositoryCommitDiff,
  repositoryLog,
  repositoryStatus,
  repositoryWorkingDiff,
  writeRepositoryFile,
} from "../services/repositoryWorkspace.js";
import {
  discardRepositoryWorkSession,
  publishRepositoryWorkSession,
  repositoryWorkSessionDiff,
  startRepositoryWorkSession,
} from "../services/repositoryWorkSessions.js";

/**
 * Working with a Repository's *contents* — the file tree, the editor, history,
 * diffs, branches, commits, and AI work sessions.
 *
 * Split from `routes/repositories.ts` on purpose. That router manages the
 * repository *record*: its clone URL, its credentials, and which AI Employees
 * may use it. All of that is owner/admin, and none of it is something you do
 * more than once. This router is what people use day to day, and it is open to
 * any company Member — editing a file and committing it is the same class of
 * act as writing a Note, and locking it to admins would make a repository of
 * strategy documents useless to the people who write them.
 *
 * The two exceptions, which do require admin, are the operations that reach
 * outside the company: pushing a branch to the remote and pulling from it. A
 * local commit can be undone by anyone; a push cannot be recalled.
 */
export const repositoryContentRouter = Router({ mergeParams: true });
repositoryContentRouter.use(requireAuth);
repositoryContentRouter.use(requireCompanyMember);
repositoryContentRouter.use(requireBrowserSession);
repositoryContentRouter.use((req, res, next) => {
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
});

const requireAdmin = requireCompanyRole("admin");

function isAdmin(req: Request): boolean {
  return req.companyRole === "owner" || req.companyRole === "admin";
}

/**
 * Resolve the repository named in the URL and guarantee its working copy is on
 * disk before the handler runs, so no handler below has to think about it.
 *
 * `refresh` forces a fetch from the remote. It is off by default because the
 * editor reads local state constantly and nobody wants a network round trip
 * behind every keystroke; the Refresh button is the explicit way to ask.
 *
 * Service errors become 400s with the service's own message. Those messages
 * are written for the person reading them ("This branch has diverged from the
 * remote…"), and flattening them into a generic failure would throw away the
 * only useful part.
 */
function withRepository(
  handler: (repo: Repository, req: Request, res: Response) => Promise<unknown>,
  options: { refresh?: boolean } = {},
): RequestHandler {
  return async (req, res) => {
    const repo = await AppDataSource.getRepository(Repository).findOneBy({
      companyId: req.params.cid,
      slug: req.params.slug,
    });
    if (!repo) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    try {
      if (options.refresh || !repositoryCheckoutExists(repo)) {
        await ensureRepositoryWorkspace(repo);
      }
      await handler(repo, req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) res.status(400).json({ error: message });
    }
  };
}

// ─────────────────────────────── browse ─────────────────────────────────

repositoryContentRouter.get(
  "/repositories/:slug/workspace/tree",
  withRepository(async (repo, req, res) => {
    const entries = await listRepositoryTree(repo, String(req.query.path ?? ""));
    res.json({ entries });
  }),
);

repositoryContentRouter.get(
  "/repositories/:slug/workspace/file",
  withRepository(async (repo, req, res) => {
    const filePath = req.query.path;
    if (typeof filePath !== "string" || !filePath) throw new Error("A file path is required.");
    const ref = typeof req.query.ref === "string" && req.query.ref ? req.query.ref : null;
    res.json(await readRepositoryFile(repo, filePath, ref));
  }),
);

repositoryContentRouter.get(
  "/repositories/:slug/workspace/status",
  withRepository(async (repo, _req, res) => {
    res.json(await repositoryStatus(repo));
  }),
);

repositoryContentRouter.get(
  "/repositories/:slug/workspace/history",
  withRepository(async (repo, req, res) => {
    const commits = await repositoryLog(repo, {
      ref: typeof req.query.ref === "string" && req.query.ref ? req.query.ref : null,
      filePath: typeof req.query.path === "string" && req.query.path ? req.query.path : null,
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    });
    res.json({ commits });
  }),
);

repositoryContentRouter.get(
  "/repositories/:slug/workspace/commits/:sha",
  withRepository(async (repo, req, res) => {
    res.json(await repositoryCommitDiff(repo, req.params.sha));
  }),
);

repositoryContentRouter.get(
  "/repositories/:slug/workspace/diff",
  withRepository(async (repo, req, res) => {
    const filePath = typeof req.query.path === "string" && req.query.path ? req.query.path : null;
    res.json(await repositoryWorkingDiff(repo, filePath));
  }),
);

repositoryContentRouter.get(
  "/repositories/:slug/workspace/branches",
  withRepository(async (repo, _req, res) => {
    res.json({ branches: await repositoryBranches(repo) });
  }),
);

/** Explicit "go and talk to the remote" — the only read that costs a fetch. */
repositoryContentRouter.post(
  "/repositories/:slug/workspace/refresh",
  withRepository(
    async (repo, _req, res) => {
      res.json(await repositoryStatus(repo));
    },
    { refresh: true },
  ),
);

// ─────────────────────────────── editing ────────────────────────────────

const writeFileSchema = z
  .object({
    path: z.string().min(1).max(1000),
    content: z.string().max(MAX_EDITABLE_FILE_BYTES),
  })
  .strict();

repositoryContentRouter.put(
  "/repositories/:slug/workspace/file",
  validateBody(writeFileSchema),
  withRepository(async (repo, req, res) => {
    const body = req.body as z.infer<typeof writeFileSchema>;
    await writeRepositoryFile(repo, body.path, body.content);
    res.json({ ok: true });
  }),
);

const pathSchema = z.object({ path: z.string().min(1).max(1000) }).strict();

repositoryContentRouter.post(
  "/repositories/:slug/workspace/directory",
  validateBody(pathSchema),
  withRepository(async (repo, req, res) => {
    await createRepositoryDirectory(repo, (req.body as z.infer<typeof pathSchema>).path);
    res.json({ ok: true });
  }),
);

repositoryContentRouter.post(
  "/repositories/:slug/workspace/delete",
  validateBody(pathSchema),
  withRepository(async (repo, req, res) => {
    await deleteRepositoryEntry(repo, (req.body as z.infer<typeof pathSchema>).path);
    res.json({ ok: true });
  }),
);

const moveSchema = z
  .object({ from: z.string().min(1).max(1000), to: z.string().min(1).max(1000) })
  .strict();

repositoryContentRouter.post(
  "/repositories/:slug/workspace/move",
  validateBody(moveSchema),
  withRepository(async (repo, req, res) => {
    const body = req.body as z.infer<typeof moveSchema>;
    await moveRepositoryEntry(repo, body.from, body.to);
    res.json({ ok: true });
  }),
);

const discardSchema = z.object({ paths: z.array(z.string().min(1).max(1000)).min(1) }).strict();

repositoryContentRouter.post(
  "/repositories/:slug/workspace/discard",
  validateBody(discardSchema),
  withRepository(async (repo, req, res) => {
    await discardRepositoryChanges(repo, (req.body as z.infer<typeof discardSchema>).paths);
    res.json({ ok: true });
  }),
);

// ──────────────────────────── version control ───────────────────────────

const commitSchema = z
  .object({
    message: z.string().min(1).max(2000),
    paths: z.array(z.string().min(1).max(1000)).optional(),
  })
  .strict();

repositoryContentRouter.post(
  "/repositories/:slug/workspace/commit",
  validateBody(commitSchema),
  withRepository(async (repo, req, res) => {
    const body = req.body as z.infer<typeof commitSchema>;
    // Stamp the commit with the Member who made it, so `git log` attributes
    // web-editor work to a person rather than to the server.
    const author = req.userId
      ? await AppDataSource.getRepository(User).findOneBy({ id: req.userId })
      : null;
    const result = await commitRepositoryChanges(repo, {
      message: body.message,
      paths: body.paths,
      authorName: author?.name ?? null,
      authorEmail: author?.email ?? null,
    });
    if (!result) {
      res.status(400).json({ error: "There is nothing to commit." });
      return;
    }
    await recordAudit({
      companyId: repo.companyId,
      actorUserId: req.userId ?? null,
      action: "repository.commit",
      targetType: "repository",
      targetId: repo.id,
      targetLabel: repo.name,
      metadata: { commit: result.sha, message: body.message },
    });
    res.json({ committed: true, ...result });
  }),
);

const branchSchema = z
  .object({ name: z.string().min(1).max(200), from: z.string().max(250).optional() })
  .strict();

repositoryContentRouter.post(
  "/repositories/:slug/workspace/branches",
  validateBody(branchSchema),
  withRepository(async (repo, req, res) => {
    const body = req.body as z.infer<typeof branchSchema>;
    await createRepositoryBranch(repo, body.name, body.from ?? null);
    res.json({ ok: true });
  }),
);

const branchNameSchema = z.object({ name: z.string().min(1).max(200) }).strict();

repositoryContentRouter.post(
  "/repositories/:slug/workspace/checkout",
  validateBody(branchNameSchema),
  withRepository(async (repo, req, res) => {
    await checkoutRepositoryBranch(repo, (req.body as z.infer<typeof branchNameSchema>).name);
    res.json({ ok: true });
  }),
);

repositoryContentRouter.post(
  "/repositories/:slug/workspace/push",
  requireAdmin,
  validateBody(branchNameSchema),
  withRepository(async (repo, req, res) => {
    const body = req.body as z.infer<typeof branchNameSchema>;
    const result = await pushRepositoryBranch(repo, body.name);
    await recordAudit({
      companyId: repo.companyId,
      actorUserId: req.userId ?? null,
      action: "repository.push",
      targetType: "repository",
      targetId: repo.id,
      targetLabel: repo.name,
      metadata: { branch: result.branch },
    });
    res.json(result);
  }),
);

repositoryContentRouter.post(
  "/repositories/:slug/workspace/pull",
  requireAdmin,
  validateBody(branchNameSchema),
  withRepository(async (repo, req, res) => {
    res.json(await pullRepositoryBranch(repo, (req.body as z.infer<typeof branchNameSchema>).name));
  }),
);

// ───────────────────────────── AI sessions ──────────────────────────────

type HydratedSession = RepositoryWorkSession & {
  employee: { id: string; name: string; slug: string; avatarKey: string | null } | null;
};

async function hydrateSessions(
  companyId: string,
  sessions: RepositoryWorkSession[],
): Promise<HydratedSession[]> {
  if (sessions.length === 0) return [];
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId, id: In([...new Set(sessions.map((s) => s.employeeId))]) },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));
  return sessions.map((session) => {
    const employee = byId.get(session.employeeId);
    return Object.assign(session, {
      employee: employee
        ? {
            id: employee.id,
            name: employee.name,
            slug: employee.slug,
            avatarKey: employee.avatarKey ?? null,
          }
        : null,
    });
  });
}

repositoryContentRouter.get(
  "/repositories/:slug/sessions",
  withRepository(async (repo, _req, res) => {
    const sessions = await AppDataSource.getRepository(RepositoryWorkSession).find({
      where: { repositoryId: repo.id },
      order: { createdAt: "DESC" },
      take: 50,
    });
    res.json({ sessions: await hydrateSessions(repo.companyId, sessions) });
  }),
);

/** The AI Employees a Member can send at this repository — those granted it. */
repositoryContentRouter.get(
  "/repositories/:slug/session-candidates",
  withRepository(async (repo, _req, res) => {
    const grants = await AppDataSource.getRepository(EmployeeRepositoryGrant).find({
      where: { repositoryId: repo.id },
    });
    const employees = grants.length
      ? await AppDataSource.getRepository(AIEmployee).find({
          where: { companyId: repo.companyId, id: In(grants.map((g) => g.employeeId)) },
          order: { createdAt: "ASC" },
        })
      : [];
    res.json({
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        role: e.role,
        avatarKey: e.avatarKey ?? null,
      })),
    });
  }),
);

const startSessionSchema = z
  .object({ employeeId: z.string().uuid(), instruction: z.string().min(1).max(20000) })
  .strict();

/**
 * Start a session and answer as soon as the row exists.
 *
 * The employee's turn can run for minutes, which is far longer than any
 * ordinary proxy will hold a request open. The client gets the `running` row
 * to render immediately and learns about the outcome from the resource-change
 * event the session's own writes emit.
 */
repositoryContentRouter.post(
  "/repositories/:slug/sessions",
  validateBody(startSessionSchema),
  withRepository(async (repo, req, res) => {
    const body = req.body as z.infer<typeof startSessionSchema>;
    if (!req.userId || !req.session?.sessionVersion) {
      throw new Error("Sign in again to start a work session.");
    }
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: repo.companyId,
    });
    if (!employee) throw new Error("Unknown employee.");

    await recordAudit({
      companyId: repo.companyId,
      actorUserId: req.userId,
      action: "repository.work_session",
      targetType: "repository",
      targetId: repo.id,
      targetLabel: repo.name,
      metadata: { employeeId: employee.id },
    });

    const running = startRepositoryWorkSession({
      companyId: repo.companyId,
      repositoryId: repo.id,
      employeeId: employee.id,
      instruction: body.instruction,
      requesterUserId: req.userId,
      requesterSessionVersion: req.session.sessionVersion,
    });
    running.catch((error) => {
      console.error("[repository-session] failed:", error);
    });

    // The row is written before the model turn starts, so a short wait is
    // enough to return it — and if the whole session finishes inside the wait,
    // even better, the client gets the finished row straight away.
    const finished = await Promise.race([
      running.catch(() => null),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 1500);
      }),
    ]);
    const row =
      finished ??
      (await AppDataSource.getRepository(RepositoryWorkSession).findOne({
        where: { repositoryId: repo.id, employeeId: employee.id },
        order: { createdAt: "DESC" },
      }));
    if (!row) throw new Error("The work session could not be started.");
    const [hydrated] = await hydrateSessions(repo.companyId, [row]);
    res.json(hydrated);
  }),
);

async function loadSession(
  repo: Repository,
  sessionId: string,
): Promise<RepositoryWorkSession | null> {
  return AppDataSource.getRepository(RepositoryWorkSession).findOneBy({
    id: sessionId,
    companyId: repo.companyId,
    repositoryId: repo.id,
  });
}

repositoryContentRouter.get(
  "/repositories/:slug/sessions/:sessionId/diff",
  withRepository(async (repo, req, res) => {
    const session = await loadSession(repo, req.params.sessionId);
    if (!session) throw new Error("Work session not found.");
    res.json(await repositoryWorkSessionDiff(session));
  }),
);

const publishSchema = z.object({ push: z.boolean().optional() }).strict();

repositoryContentRouter.post(
  "/repositories/:slug/sessions/:sessionId/publish",
  validateBody(publishSchema),
  withRepository(async (repo, req, res) => {
    const session = await loadSession(repo, req.params.sessionId);
    if (!session) throw new Error("Work session not found.");
    const push = (req.body as z.infer<typeof publishSchema>).push === true;
    // Merging is a Member action. Reaching the remote is not.
    if (push && !isAdmin(req)) {
      res.status(403).json({ error: "Only an owner or admin can push to the remote." });
      return;
    }
    const updated = await publishRepositoryWorkSession(session.id, { push });
    await recordAudit({
      companyId: repo.companyId,
      actorUserId: req.userId ?? null,
      action: "repository.publish_work_session",
      targetType: "repository",
      targetId: repo.id,
      targetLabel: repo.name,
      metadata: { sessionId: session.id, pushed: push },
    });
    const [hydrated] = await hydrateSessions(repo.companyId, [updated]);
    res.json(hydrated);
  }),
);

repositoryContentRouter.post(
  "/repositories/:slug/sessions/:sessionId/discard",
  withRepository(async (repo, req, res) => {
    const session = await loadSession(repo, req.params.sessionId);
    if (!session) throw new Error("Work session not found.");
    const updated = await discardRepositoryWorkSession(session.id);
    const [hydrated] = await hydrateSessions(repo.companyId, [updated]);
    res.json(hydrated);
  }),
);
