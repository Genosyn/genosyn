import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { browserAccessEnabledForSession } from "./browserAccess.js";
import { createBrowserSession } from "./browserSessions.js";
import { createPrivilegedMemberToolAuthorizer } from "./memberTurnAuthority.js";
import { resolveMemberBrowserForSpawn } from "./memberBrowsers.js";
import { resolveMcpToken } from "./mcpTokens.js";

export class BrowserSessionRecoveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A browser bearer cannot renew itself. Recovery also requires the live turn
 * credential and its original scope. Create a new recording/session identity;
 * never reopen a closed row or replay a click, form submission, or approval.
 */
export async function recoverBrowserSession(args: {
  sessionId: string;
  sessionToken: string;
  turnToken: string;
}): Promise<BrowserSession> {
  const turn = resolveMcpToken(args.turnToken);
  if (!turn || turn.authority === "untrusted") {
    throw new BrowserSessionRecoveryError(
      "Browser recovery requires a live authorized work turn.",
      401,
    );
  }
  if (
    turn.selfReviewOnly ||
    turn.proactiveReview ||
    turn.repositoryWorkSessionId ||
    turn.mailDeliveryMode
  ) {
    throw new BrowserSessionRecoveryError(
      "Browser recovery is unavailable in this work surface.",
      403,
    );
  }
  const previous = await AppDataSource.getRepository(BrowserSession).findOneBy({
    id: args.sessionId,
    mcpToken: args.sessionToken,
    companyId: turn.companyId,
    employeeId: turn.employeeId,
  });
  if (!previous || previous.mcpTokenExpiresAt.getTime() <= Date.now()) {
    throw new BrowserSessionRecoveryError(
      "The browser credential is unknown or expired. Start a fresh work turn.",
      401,
    );
  }
  if (
    previous.runId !== turn.runId ||
    (previous.conversationId !== turn.conversationId &&
      !(turn.delegated && previous.conversationId === null))
  ) {
    throw new BrowserSessionRecoveryError("This browser belongs to a different work turn.", 403);
  }
  if (previous.status !== "closed" || !["idle", "shutdown"].includes(previous.closeReason ?? "")) {
    throw new BrowserSessionRecoveryError(
      "This browser session cannot be recovered automatically. A manual close or revoked access requires a fresh work turn.",
      409,
    );
  }
  if (turn.authority === "member") {
    const denial = await createPrivilegedMemberToolAuthorizer({
      companyId: turn.companyId,
      userId: turn.requesterUserId!,
      sessionVersion: turn.requesterSessionVersion!,
    })();
    if (denial) throw new BrowserSessionRecoveryError(denial, 403);
  }
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: turn.employeeId,
    companyId: turn.companyId,
  });
  if (!employee || !(await browserAccessEnabledForSession(previous, employee))) {
    throw new BrowserSessionRecoveryError(
      "Browser access is no longer available for this work turn.",
      403,
    );
  }
  const selectedBrowser = await resolveMemberBrowserForSpawn({
    employeeId: turn.employeeId,
    companyId: turn.companyId,
    routineId: turn.routineId,
    conversationId: previous.conversationId,
  });
  if ((selectedBrowser?.id ?? null) !== previous.memberBrowserId) {
    throw new BrowserSessionRecoveryError(
      "The selected browser changed. Start a fresh work turn.",
      403,
    );
  }
  return createBrowserSession({
    companyId: previous.companyId,
    employeeId: previous.employeeId,
    conversationId: previous.conversationId,
    runId: previous.runId,
    memberBrowserId: previous.memberBrowserId,
    viewportWidth: previous.viewportWidth,
    viewportHeight: previous.viewportHeight,
  });
}
