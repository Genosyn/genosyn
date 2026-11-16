import path from "node:path";
import { In } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import type { RepositoryAccessLevel } from "../db/entities/EmployeeRepositoryGrant.js";
import { Repository } from "../db/entities/Repository.js";
import { shouldMaterializeRepositoriesForTurn } from "./codexSubscription.js";
import type { MailDeliveryMode } from "./mail/deliveryPolicy.js";
import { employeeDir, ensureDir } from "./paths.js";
import { listForgeCheckoutsForEmployee } from "./repoSync.js";
import {
  materializeEmployeeRepositoryContext,
  type RepositoryCheckoutTarget,
} from "./repositories.js";

/**
 * An AI Employee's own checkouts, fetched when it reads them.
 *
 * An employee granted a Repository (or a forge Connection with an allowlist)
 * keeps a checkout of it in its working directory for chat and Routine work.
 * Those checkouts used to be cloned or fetched before every chat turn and every
 * Run, so a question about a reseller's address waited minutes behind
 * `git fetch` on code nobody was going to open.
 *
 * Now a turn is only told which checkouts exist — read from Grants and
 * allowlists, with no remote contacted — and the employee calls
 * `sync_repositories` when it is about to read one. The contributor guide comes
 * back with the sync rather than in the system prompt, because a guide read
 * from a checkout that was never refreshed is exactly what the employee must not
 * be briefed from.
 *
 * Repository work sessions are untouched by this: each one fetches into its own
 * worktree when it starts (see `repositoryWorkSessions.ts`).
 */

export type EmployeeRepositoryCheckout =
  | {
      kind: "repository";
      repositoryId: string;
      name: string;
      slug: string;
      defaultBranch: string;
      accessLevel: RepositoryAccessLevel;
      /** No token or key of its own, so a granted Connection's may be used. */
      credentialFree: boolean;
      /** Relative to the employee's working directory, no trailing slash. */
      path: string;
    }
  | {
      kind: "connection";
      connectionId: string;
      owner: string;
      name: string;
      defaultBranch: string;
      path: string;
    };

/**
 * Every checkout this employee could sync, from its Grants alone.
 *
 * Local Repositories are left out: they have no remote to clone from, so there
 * is no employee checkout of one — a work session reaches them instead.
 */
export async function listEmployeeRepositoryCheckouts(
  employeeId: string,
): Promise<EmployeeRepositoryCheckout[]> {
  if (config.security.multiTenant) return [];
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
  if (!employee) return [];
  const grants = await AppDataSource.getRepository(EmployeeRepositoryGrant).find({
    where: { employeeId },
  });
  const accessById = new Map(grants.map((g) => [g.repositoryId, g.accessLevel]));
  const rows = accessById.size
    ? await AppDataSource.getRepository(Repository).find({
        where: { companyId: employee.companyId, id: In([...accessById.keys()]) },
        order: { slug: "ASC" },
      })
    : [];
  const checkouts: EmployeeRepositoryCheckout[] = [];
  const seenPaths = new Set<string>();
  for (const row of rows) {
    if (row.origin === "local") continue;
    const checkoutPath = `repositories/${row.slug}`;
    seenPaths.add(checkoutPath);
    checkouts.push({
      kind: "repository",
      repositoryId: row.id,
      name: row.name,
      slug: row.slug,
      defaultBranch: row.defaultBranch,
      accessLevel: accessById.get(row.id) ?? "read",
      credentialFree: row.authMode === "none",
      path: checkoutPath,
    });
  }
  for (const forge of await listForgeCheckoutsForEmployee(employeeId)) {
    const checkoutPath = `repos/${forge.owner}/${forge.name}`;
    // Two Connections allowlisting the same owner/name share one directory;
    // the first is the one a sync of "everything" would leave there.
    if (seenPaths.has(checkoutPath)) continue;
    seenPaths.add(checkoutPath);
    checkouts.push({ kind: "connection", ...forge, path: checkoutPath });
  }
  return checkouts;
}

/** How many checkouts a briefing names before it points at `list_repositories`. */
export const BRIEFED_CHECKOUTS_MAX = 40;

/**
 * The system prompt's `## Repositories` section: what is there and how to get
 * it, at no cost to a turn that never opens it. Built only from Grants, so it
 * stays the same from turn to turn while they do.
 */
export async function composeRepositoryCheckoutsBriefing(employeeId: string): Promise<string> {
  return formatRepositoryCheckoutsBriefing(await listEmployeeRepositoryCheckouts(employeeId));
}

export function formatRepositoryCheckoutsBriefing(
  checkouts: readonly EmployeeRepositoryCheckout[],
): string {
  if (!checkouts.length) return "";
  const lines = [
    "",
    "## Repositories",
    "You have checkouts of these repositories in your working directory. Genosyn does not fetch them before each turn, so one may be out of date or not cloned yet. When the work needs a repository's files, first call `sync_repositories` with its slug (with no repository it syncs them all): it clones or fetches the checkout and returns that repository's contributor guide, which you follow while working there. Skip it for work that does not involve them. To change a repository, use `start_repository_work_session`, which fetches the latest code itself.",
  ];
  for (const checkout of checkouts.slice(0, BRIEFED_CHECKOUTS_MAX)) {
    lines.push(
      checkout.kind === "repository"
        ? `- ${JSON.stringify(checkout.name)}: slug \`${checkout.slug}\`, checkout \`${checkout.path}/\`, default branch ${JSON.stringify(checkout.defaultBranch)}, ${checkout.accessLevel === "write" ? "write" : "read-only"} Grant.`
        : `- ${JSON.stringify(`${checkout.owner}/${checkout.name}`)}: Connection checkout \`${checkout.path}/\`, default branch ${JSON.stringify(checkout.defaultBranch)}.`,
    );
  }
  const unnamed = checkouts.length - BRIEFED_CHECKOUTS_MAX;
  if (unnamed > 0) {
    lines.push(
      `- …and ${unnamed} more. \`list_repositories\` lists every granted Repository, and \`sync_repositories\` takes any of their names.`,
    );
  }
  return lines.join("\n");
}

function checkoutLabel(checkout: EmployeeRepositoryCheckout): string {
  return checkout.kind === "repository"
    ? `${checkout.name} (${checkout.slug})`
    : `${checkout.owner}/${checkout.name}`;
}

/**
 * Find the checkout a model named: a Repository's slug or name, a Connection
 * checkout's `owner/name`, or either's path. A name two Repositories share is a
 * question to send back, never a choice to make for it.
 */
export function resolveEmployeeRepositoryCheckout(
  checkouts: readonly EmployeeRepositoryCheckout[],
  requested: string,
): { checkout: EmployeeRepositoryCheckout } | { error: string } {
  const exact = requested.trim().replace(/\/+$/, "");
  const wanted = exact.toLowerCase();
  const repositories = checkouts.filter(
    (c): c is Extract<EmployeeRepositoryCheckout, { kind: "repository" }> =>
      c.kind === "repository",
  );
  const bySlug =
    repositories.find((c) => c.slug === exact) ??
    repositories.find((c) => c.slug.toLowerCase() === wanted);
  if (bySlug) return { checkout: bySlug };
  const byName = repositories.filter((c) => c.name.toLowerCase() === wanted);
  if (byName.length > 1) {
    return {
      error: `More than one of your repositories is called "${requested}". Say which by its slug: ${byName
        .map((c) => c.slug)
        .join(", ")}.`,
    };
  }
  if (byName[0]) return { checkout: byName[0] };
  const other = checkouts.find(
    (c) =>
      c.path.toLowerCase() === wanted ||
      (c.kind === "connection" && `${c.owner}/${c.name}`.toLowerCase() === wanted),
  );
  if (other) return { checkout: other };
  const named = checkouts.slice(0, BRIEFED_CHECKOUTS_MAX).map(checkoutLabel).join(", ");
  const more = checkouts.length > BRIEFED_CHECKOUTS_MAX ? ", …" : "";
  return {
    error: `"${requested}" is not one of your repository checkouts. Yours: ${named}${more}.`,
  };
}

function syncTarget(checkout: EmployeeRepositoryCheckout): RepositoryCheckoutTarget {
  return checkout.kind === "repository"
    ? {
        kind: "repository",
        repositoryId: checkout.repositoryId,
        borrowsConnectionCredential: checkout.credentialFree,
      }
    : {
        kind: "connection",
        connectionId: checkout.connectionId,
        owner: checkout.owner,
        name: checkout.name,
      };
}

export type RepositoryCheckoutSyncReport = {
  synced: Array<{ repository: string; checkout: string; defaultBranch: string }>;
  failed: Array<{ repository: string; error: string }>;
  /** Working instructions and contributor guides for what synced. */
  instructions: string;
};

export type RepositoryCheckoutSyncOutcome =
  | { ok: true; report: RepositoryCheckoutSyncReport }
  | { ok: false; reason: "request" | "remote"; error: string };

/**
 * The tool result as the model reads it: what synced and what did not, then
 * the briefing for what synced. Text rather than JSON, so a contributor guide
 * arrives with real newlines instead of as one escaped string.
 */
export function formatRepositoryCheckoutSyncReport(report: RepositoryCheckoutSyncReport): string {
  const lines: string[] = [];
  if (report.synced.length) {
    lines.push(
      report.synced.length === 1
        ? "Synced 1 checkout:"
        : `Synced ${report.synced.length} checkouts:`,
    );
    for (const s of report.synced) {
      lines.push(
        `- ${s.repository}: \`${s.checkout}/\`, default branch ${JSON.stringify(s.defaultBranch)}`,
      );
    }
  } else if (!report.failed.length) {
    lines.push("Nothing was synced: that checkout is no longer among your Grants.");
  }
  if (report.failed.length) {
    lines.push(
      "",
      "Could not sync these, so do not rely on their files — they may be missing or out of date:",
      ...report.failed.map((f) => `- ${f.repository}: ${f.error}`),
    );
  }
  if (report.instructions) lines.push(report.instructions);
  return lines.join("\n");
}

type SyncDependencies = {
  materializeEmployeeRepositoryContext: typeof materializeEmployeeRepositoryContext;
};

/** Paths in a report are the ones the employee's tools use, never the host's. */
function relativeToWorkspace(cwd: string, value: string): string {
  const relative = path.relative(cwd, value);
  return relative.split(path.sep).join("/");
}

function withoutWorkspacePath(cwd: string, message: string): string {
  return message.split(`${cwd}${path.sep}`).join("").split(cwd).join(".");
}

/**
 * `sync_repositories`: clone or fetch the named checkout, or every one, and
 * brief the employee from the files that sync produced.
 */
export async function syncEmployeeRepositoryCheckouts(
  args: { employeeId: string; cwd: string; repository?: string },
  dependencyOverrides: Partial<SyncDependencies> = {},
): Promise<RepositoryCheckoutSyncOutcome> {
  const dependencies = { materializeEmployeeRepositoryContext, ...dependencyOverrides };
  const checkouts = await listEmployeeRepositoryCheckouts(args.employeeId);
  if (!checkouts.length) {
    return {
      ok: false,
      reason: "request",
      error:
        "You have no repository checkouts to sync. An owner or admin grants Repositories to an AI Employee from its Access tab.",
    };
  }
  let only: RepositoryCheckoutTarget | undefined;
  if (args.repository !== undefined) {
    const resolved = resolveEmployeeRepositoryCheckout(checkouts, args.repository);
    if ("error" in resolved) return { ok: false, reason: "request", error: resolved.error };
    only = syncTarget(resolved.checkout);
  }

  const prepared = await dependencies.materializeEmployeeRepositoryContext({
    employeeId: args.employeeId,
    cwd: args.cwd,
    only,
  });

  const synced: RepositoryCheckoutSyncReport["synced"] = [
    ...prepared.repositorySync.repos.map((repo) => ({
      repository: `${repo.name} (${repo.slug})`,
      checkout: relativeToWorkspace(args.cwd, repo.path),
      defaultBranch: repo.defaultBranch,
    })),
    ...prepared.forgeSync.repos.map((repo) => ({
      repository: `${repo.owner}/${repo.name}`,
      checkout: relativeToWorkspace(args.cwd, repo.path),
      defaultBranch: repo.defaultBranch,
    })),
  ];
  const slugLabels = new Map(
    checkouts.flatMap((c) =>
      c.kind === "repository" ? [[c.slug, checkoutLabel(c)] as const] : [],
    ),
  );
  const connectionLabels = new Map<string, string[]>();
  for (const c of checkouts) {
    if (c.kind !== "connection") continue;
    connectionLabels.set(c.connectionId, [
      ...(connectionLabels.get(c.connectionId) ?? []),
      checkoutLabel(c),
    ]);
  }
  const failed: RepositoryCheckoutSyncReport["failed"] = [
    ...prepared.repositorySync.errors.map((e) => ({
      repository: slugLabels.get(e.scope) ?? e.scope,
      error: withoutWorkspacePath(args.cwd, e.message),
    })),
    ...prepared.forgeSync.errors.map((e) => {
      const connectionId = e.scope.startsWith("connection:")
        ? e.scope.slice("connection:".length)
        : null;
      return {
        repository: connectionId
          ? (connectionLabels.get(connectionId)?.join(", ") ?? "A granted Connection")
          : e.scope,
        error: withoutWorkspacePath(args.cwd, e.message),
      };
    }),
  ];

  if (!synced.length && failed.length) {
    // A tool error carries only its message, so the reasons travel inside it.
    return {
      ok: false,
      reason: "remote",
      error: [
        "Nothing could be synced, so do not rely on these checkouts' files — they may be missing or out of date:",
        ...failed.map((f) => `- ${f.repository}: ${f.error}`),
      ].join("\n"),
    };
  }
  return { ok: true, report: { synced, failed, instructions: prepared.context } };
}

/**
 * Why this turn may not sync checkouts, or null when it may. The same lines a
 * turn's briefing is drawn by (`chat.ts`, `runner.ts`); the MCP seam has
 * already refused the turns its allowlists leave out — talking turns,
 * reviews, Repository work sessions, and Members below owner or admin.
 */
export function repositoryCheckoutSyncRefusal(turn: {
  mailDeliveryMode?: MailDeliveryMode | null;
}): string | null {
  if (config.security.multiTenant) {
    return "Repository checkouts are not available on a multi-tenant Genosyn installation.";
  }
  if (!shouldMaterializeRepositoriesForTurn()) {
    return "Repository checkouts are off because coding tools are disabled on this Genosyn installation. Use start_repository_work_session to read or change a repository instead.";
  }
  if (turn.mailDeliveryMode) {
    return "Email work does not use repository checkouts. Note what needs the code in a Workstream for a Member or an approved Routine to pick up.";
  }
  return null;
}

/** The employee's working directory, where its checkouts live. */
export function employeeCheckoutRoot(companySlug: string, employeeSlug: string): string {
  const cwd = employeeDir(companySlug, employeeSlug);
  ensureDir(cwd);
  return cwd;
}
