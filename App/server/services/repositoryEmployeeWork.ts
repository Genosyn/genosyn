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
  sessionBranchName,
  type WorkSessionPullRequestDeps,
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

/**
 * Deliver one employee's completed branch through the forge Connection the
 * company explicitly chose for this Repository. A Repository write Grant only
 * permits local work; the separate Connection Grant authorizes remote delivery.
 * Repository-specific PATs and SSH keys never become employee credentials.
 */
export async function openEmployeeRepositoryWorkSessionPullRequest(args: {
  companyId: string;
  employeeId: string;
  sessionId: string;
  title?: string;
  body?: string;
  requester?: { userId: string; sessionVersion: number };
  deps?: Partial<WorkSessionPullRequestDeps>;
}): Promise<RepositoryWorkSession> {
  const key = `${args.companyId}:${args.employeeId}:${args.sessionId}`;
  if (publishingSessions.has(key)) {
    throw new Error(
      "This work session is already opening a pull request. Check its status shortly.",
    );
  }
  publishingSessions.add(key);
  const authorizeMember = args.requester
    ? createPrivilegedMemberToolAuthorizer({ companyId: args.companyId, ...args.requester })
    : undefined;
  try {
    const authorize = async (
      expectedSession?: RepositoryWorkSession,
      expectedRepo?: Repository,
    ) => {
      const memberDenial = await authorizeMember?.();
      if (memberDenial) throw new Error(memberDenial);
      const policy = await policyForbiddingTool(
        args.companyId,
        "open_repository_work_session_pull_request",
      );
      if (policy)
        throw new Error(`The company policy "${policy.title}" forbids pull-request delivery.`);
      if (config.security.multiTenant) {
        throw new Error("Repository delivery is unavailable in shared SaaS mode.");
      }
      const blocked = workBlocked(args.companyId, { employeeId: args.employeeId });
      if (blocked.blocked) throw new Error(`This AI Employee is stood down: ${blocked.reason}`);
      const { session, repo, employee, latestTurn } = await employeeRepositoryWorkSession({
        ...args,
        access: "write",
      });
      if (session.status !== "ready" && session.status !== "proposed") {
        throw new Error("This session has no completed, committed work to propose.");
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
          "Only this work session's generated branch with committed changes may be proposed.",
        );
      }
      if (repo.origin !== "remote" || repo.authMode !== "none" || !repo.githubConnectionId) {
        throw new Error(
          "Automatic pull requests need a remote Repository connected through a granted GitHub or Forgejo Connection. A Member can publish repositories using their own token or SSH key.",
        );
      }
      // Re-read before both external writes. A revoked Grant, changed remote,
      // discarded session or replacement Connection stops the next effect.
      if (
        expectedSession &&
        expectedRepo &&
        (session.branch !== expectedSession.branch ||
          session.headCommit !== expectedSession.headCommit ||
          repo.gitUrl !== expectedRepo.gitUrl ||
          repo.githubConnectionId !== expectedRepo.githubConnectionId)
      ) {
        throw new Error("The Repository or work session changed before delivery. Check it again.");
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
        !provider?.tools.some((tool) => tool.name === "create_pull_request") ||
        (provider.supportsTool &&
          !provider.supportsTool("create_pull_request", pair.connection.authMode))
      ) {
        throw new Error("This Connection does not support opening pull requests.");
      }
      const forge = await resolveForgeRemote(repo);
      if (!forge || forge.connection?.id !== pair.connection.id) {
        throw new Error("The Repository's remote does not match its granted forge Connection.");
      }
    };
    await authorize();
    return await openRepositoryWorkSessionPullRequest({
      sessionId: args.sessionId,
      title: args.title,
      body: args.body,
      deps: args.deps,
      authorize,
    });
  } finally {
    publishingSessions.delete(key);
  }
}
