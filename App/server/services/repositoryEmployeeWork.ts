import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { assertIntegrationAllowed, getProvider } from "../integrations/index.js";
import { getGrantWithConnection } from "./integrations.js";
import { hasRepositoryAccess } from "./repositories.js";
import { resolveForgeRemote } from "./repositoryForge.js";
import {
  openRepositoryWorkSessionPullRequest,
  pushRepositoryWorkSession,
  resolveRepositoryForge,
  sessionBranchName,
  type ResolvedRepositoryForge,
  type WorkSessionPullRequestDeps,
  type WorkSessionPushDeps,
} from "./repositoryWorkSessions.js";
import { workBlocked } from "./standdowns.js";
import { createPrivilegedMemberToolAuthorizer } from "./memberTurnAuthority.js";
import { policyForbiddingTool } from "./companyPolicies.js";

/** An employee may follow up only its own work, including after it has finished. */
export async function employeeRepositoryWorkSession(args: {
  companyId: string;
  employeeId: string;
  sessionId: string;
  access?: "read" | "write";
}): Promise<{
  session: RepositoryWorkSession;
  repo: Repository;
  employee: AIEmployee;
  latestTurn: RepositoryWorkSessionTurn | null;
}> {
  const session = await AppDataSource.getRepository(RepositoryWorkSession).findOneBy({
    id: args.sessionId,
    companyId: args.companyId,
    employeeId: args.employeeId,
  });
  if (!session) throw new Error("Work session not found.");
  const [repo, employee] = await Promise.all([
    AppDataSource.getRepository(Repository).findOneBy({
      id: session.repositoryId,
      companyId: args.companyId,
    }),
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: args.employeeId,
      companyId: args.companyId,
    }),
  ]);
  if (!repo || !employee) throw new Error("Work session not found.");
  if (!(await hasRepositoryAccess(employee.id, repo.id, args.access ?? "read"))) {
    throw new Error(`This work needs a ${args.access ?? "read"} Grant to the Repository.`);
  }
  const latestTurn = await AppDataSource.getRepository(RepositoryWorkSessionTurn).findOne({
    where: { companyId: args.companyId, sessionId: session.id },
    order: { ordinal: "DESC" },
  });
  return { session, repo, employee, latestTurn };
}

const publishingSessions = new Set<string>();

type EmployeeDeliveryArgs = {
  companyId: string;
  employeeId: string;
  sessionId: string;
  requester?: { userId: string; sessionVersion: number };
};

/** Credentials remain server-owned; a write Grant authorizes only this completed branch. */
export async function pushEmployeeRepositoryWorkSession(
  args: EmployeeDeliveryArgs & { deps?: Partial<WorkSessionPushDeps> },
): Promise<RepositoryWorkSession> {
  return withEmployeeDelivery(args, "push_repository_work_session", async (authorize) =>
    pushRepositoryWorkSession({ sessionId: args.sessionId, deps: args.deps, authorize }),
  );
}

/** HTTPS tokens can deliver directly; SSH needs a separately granted Connection for the PR API. */
export async function openEmployeeRepositoryWorkSessionPullRequest(
  args: EmployeeDeliveryArgs & {
    title?: string;
    body?: string;
    deps?: Partial<WorkSessionPullRequestDeps>;
  },
): Promise<RepositoryWorkSession> {
  return withEmployeeDelivery(
    args,
    "open_repository_work_session_pull_request",
    async (authorize) =>
      openRepositoryWorkSessionPullRequest({
        sessionId: args.sessionId,
        title: args.title,
        body: args.body,
        deps: {
          ...args.deps,
          // A Repository HTTPS token authorizes Git and the forge API. Other
          // modes must use the exact pinned, granted Connection for the API.
          resolveForge: (repo) =>
            (args.deps?.resolveForge ?? resolveRepositoryForge)(repo, {
              preferConnection: repo.authMode !== "https",
            }),
        },
        authorize,
      }),
  );
}

type DeliveryTool = "push_repository_work_session" | "open_repository_work_session_pull_request";
type DeliveryAuthorizer = (
  session?: RepositoryWorkSession,
  repo?: Repository,
  forge?: ResolvedRepositoryForge,
) => Promise<void>;

async function withEmployeeDelivery(
  args: EmployeeDeliveryArgs,
  tool: DeliveryTool,
  deliver: (authorize: DeliveryAuthorizer) => Promise<RepositoryWorkSession>,
): Promise<RepositoryWorkSession> {
  const key = `${args.companyId}:${args.employeeId}:${args.sessionId}`;
  if (publishingSessions.has(key)) {
    throw new Error("This work session is already delivering work. Check its status shortly.");
  }
  publishingSessions.add(key);
  try {
    const authorize = employeeDeliveryAuthorizer(args, tool);
    await authorize();
    return await deliver(authorize);
  } finally {
    publishingSessions.delete(key);
  }
}

function employeeDeliveryAuthorizer(
  args: EmployeeDeliveryArgs,
  tool: DeliveryTool,
): DeliveryAuthorizer {
  const authorizeMember = args.requester
    ? createPrivilegedMemberToolAuthorizer({ companyId: args.companyId, ...args.requester })
    : undefined;
  const pullRequest = tool === "open_repository_work_session_pull_request";
  let initialWork: string | undefined;
  let initialConnection: string | undefined;
  let initialTokenForge: string | undefined;
  return async (expectedSession, expectedRepo, expectedForge) => {
    const memberDenial = await authorizeMember?.();
    if (memberDenial) throw new Error(memberDenial);
    const policy = await policyForbiddingTool(args.companyId, tool);
    if (policy)
      throw new Error(`The company policy "${policy.title}" forbids Repository delivery.`);
    if (config.security.multiTenant) {
      throw new Error("Repository delivery is unavailable in shared SaaS mode.");
    }
    const { session, repo, employee, latestTurn } = await employeeRepositoryWorkSession({
      ...args,
      access: "write",
    });
    if (session.status !== "ready" && session.status !== "proposed") {
      throw new Error("This session has no completed, committed work to deliver.");
    }
    if (!latestTurn || latestTurn.status !== "ok" || latestTurn.error) {
      throw new Error(
        "This session's last turn needs review before delivery: it did not finish cleanly.",
      );
    }
    if (
      session.branch !== sessionBranchName(employee.slug, session.id) ||
      session.branch === repo.defaultBranch ||
      !session.headCommit ||
      !session.baseCommit ||
      session.headCommit === session.baseCommit
    ) {
      throw new Error(
        "Only this work session's generated branch with committed changes may be delivered.",
      );
    }
    if (repo.origin !== "remote") {
      throw new Error("This Repository has no remote. Connect it in Repository settings first.");
    }
    // Compare encrypted values, never decrypt or export them to employee tools.
    // Capture the completed turn as well: a new revision must be delivered by a new call.
    const work = JSON.stringify([
      repo.id,
      repo.origin,
      repo.gitUrl,
      repo.authMode,
      repo.githubConnectionId,
      repo.encryptedSshKey,
      repo.encryptedToken,
      repo.httpsUsername,
      session.branch,
      session.baseCommit,
      session.headCommit,
      latestTurn.id,
    ]);
    if (
      (initialWork !== undefined && work !== initialWork) ||
      (expectedSession &&
        (session.repositoryId !== expectedSession.repositoryId ||
          session.branch !== expectedSession.branch ||
          session.baseCommit !== expectedSession.baseCommit ||
          session.headCommit !== expectedSession.headCommit)) ||
      (expectedRepo && repo.defaultBranch !== expectedRepo.defaultBranch)
    ) {
      throw new Error("The Repository or work session changed before delivery. Check it again.");
    }
    initialWork ??= work;

    // A Repository HTTPS token is scoped to this Repository by its write
    // Grant. Connection credentials still need their own live Grant: an absent
    // Git credential borrows one, and SSH needs one separately for the PR API.
    if (repo.authMode === "none" || (pullRequest && repo.authMode !== "https")) {
      if (!repo.githubConnectionId) {
        throw new Error(
          pullRequest
            ? "Automatic pull requests need a stored Repository HTTPS token or a Repository connected through a granted GitHub or Forgejo Connection. An SSH key can push the work-session branch without a Connection."
            : "Repository delivery without a stored SSH key or HTTPS token needs a Repository connected through a granted GitHub or Forgejo Connection.",
        );
      }
      const pair = await getGrantWithConnection(employee.id, repo.githubConnectionId);
      if (
        !pair ||
        pair.connection.companyId !== args.companyId ||
        pair.connection.status !== "connected"
      ) {
        throw new Error(
          "This AI Employee needs a Grant to the Repository's connected forge Connection.",
        );
      }
      assertIntegrationAllowed(pair.connection.provider);
      const provider = getProvider(pair.connection.provider);
      if (
        !provider?.tools.some((candidate) => candidate.name === "create_pull_request") ||
        (provider.supportsTool &&
          !provider.supportsTool("create_pull_request", pair.connection.authMode))
      ) {
        throw new Error("This Connection does not support Repository delivery.");
      }
      const forge = await resolveForgeRemote(repo);
      if (!forge || forge.connection?.id !== pair.connection.id) {
        throw new Error("The Repository's remote does not match its granted forge Connection.");
      }
      assertResolvedForgeUnchanged(forge, expectedForge);
      // Grants bind the Connection resource, so rotation within this bounded
      // call preserves its authority. Bind identity and trusted endpoint, not
      // ciphertext OAuth legitimately refreshes; no token reaches the model.
      const connection = JSON.stringify([
        pair.connection.id,
        pair.connection.provider,
        pair.connection.authMode,
        forge.endpoint,
      ]);
      if (
        (initialConnection !== undefined && connection !== initialConnection) ||
        forge.connection.encryptedConfig !== pair.connection.encryptedConfig ||
        forge.connection.authMode !== pair.connection.authMode
      ) {
        throw new Error(
          "The Repository's forge credential changed before delivery. Check it again.",
        );
      }
      initialConnection ??= connection;
    } else if (pullRequest) {
      // A configured Forgejo Connection may identify its server even though
      // its credential is not granted or used. Bind the resulting endpoint
      // and repository before resolving the PAT, then recheck before each use.
      const forge = await resolveForgeRemote(repo);
      if (!forge) {
        throw new Error(
          initialTokenForge === undefined
            ? "This Repository's host needs a configured GitHub or Forgejo Integration before opening pull requests."
            : "The Repository's forge endpoint changed before delivery. Check it again.",
        );
      }
      assertIntegrationAllowed(forge.provider);
      assertResolvedForgeUnchanged(forge, expectedForge);
      const tokenForge = JSON.stringify([forge.provider, forge.endpoint, forge.remote]);
      if (initialTokenForge !== undefined && initialTokenForge !== tokenForge) {
        throw new Error("The Repository's forge endpoint changed before delivery. Check it again.");
      }
      initialTokenForge ??= tokenForge;
    }
    const blocked = workBlocked(args.companyId, { employeeId: args.employeeId });
    if (blocked.blocked) throw new Error(`This AI Employee is stood down: ${blocked.reason}`);
  };
}

function assertResolvedForgeUnchanged(
  current: Pick<ResolvedRepositoryForge, "endpoint" | "remote">,
  resolved?: ResolvedRepositoryForge,
): void {
  if (
    resolved &&
    JSON.stringify([resolved.endpoint, resolved.remote]) !==
      JSON.stringify([current.endpoint, current.remote])
  ) {
    throw new Error("The Repository's forge endpoint changed before delivery. Check it again.");
  }
}
