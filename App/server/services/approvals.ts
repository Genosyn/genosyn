import crypto from "node:crypto";
import { IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { Routine } from "../db/entities/Routine.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { runRoutine } from "./runner.js";
import { decryptConnectionConfig, persistConnectionConfigIfCurrent } from "./integrations.js";
import { getProvider } from "../integrations/index.js";
import type { IntegrationConfig, IntegrationRuntimeContext } from "../integrations/types.js";
import { notifyApprovalPending } from "./notifications.js";
import { McpServer } from "../db/entities/McpServer.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { connectMcpServer, nativeToolName } from "./agent/tools/mcpBridge.js";
import { specForMcpServerRow } from "./agent/tools/mcpSources.js";
import { makeAdSpendLedger } from "./adSpend.js";
import type { AdSpendApprovalRequest } from "../integrations/types.js";
import { recordAudit } from "./audit.js";
import {
  approvalArgsPreview,
  approvalPageUrlPreview,
  redactApprovalSummary,
} from "./approvalRedaction.js";

export { approvalArgsPreview, redactApprovalSummary } from "./approvalRedaction.js";

/**
 * Fire-and-forget notification fan-out for a freshly-created approval.
 * Owners/admins get a bell + websocket + web-push row; a notify failure
 * must never fail the tool call that queued the approval.
 */
function notifyPending(approval: Approval): void {
  void notifyApprovalPending(approval).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[approvals] notify pending failed:", err);
  });
}

/**
 * Approval dispatch. Each `ApprovalKind` has its own create-helper and
 * its own `execute…` function. Decision claiming also lives here so every
 * caller gets the same compare-and-set transition before a side effect runs.
 *
 * Lives in `services/` rather than `routes/` so the cron tick (routine
 * kind) and the lightning provider (payment kind) can both schedule
 * approvals without going through HTTP.
 */

// --------------------------------------------------------------------------
// Payment payload
// --------------------------------------------------------------------------

export type LightningPaymentPayload = {
  /** Connection that owns the wallet credentials. */
  connectionId: string;
  /** The provider tool to invoke once approved (`pay_invoice`, `pay_keysend`). */
  toolName: string;
  /** Original args, replayed verbatim. */
  args: Record<string, unknown>;
  amountSats: number;
  /** Optional human-readable description (memo, description tag, etc). */
  description?: string;
};

function parsePaymentPayload(json: string | null): LightningPaymentPayload {
  if (!json) throw new Error("Approval payload is empty");
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("Approval payload is not valid JSON");
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    typeof (obj as LightningPaymentPayload).connectionId !== "string" ||
    typeof (obj as LightningPaymentPayload).toolName !== "string"
  ) {
    throw new Error("Invalid Lightning payment payload");
  }
  return obj as LightningPaymentPayload;
}

// --------------------------------------------------------------------------
// Browser-action payload
// --------------------------------------------------------------------------

/**
 * Captured by `browser_submit` when the employee's `browserApprovalRequired`
 * flag is on. The MCP child holds the live page state — the server only
 * stores enough metadata for the approver to make an informed call. On
 * approve, the model retries via `browser_resume(approvalId)` and the MCP
 * re-executes the action against the still-live browser context.
 *
 * Server side never re-fires this. The execute path for `browser_action`
 * is a no-op because we don't have access to the browser session; the
 * model is the only thing that can drive it.
 */
export type BrowserActionPayload = {
  selector: string;
  /** Optional key to press (e.g. "Enter") — null when the action is a click. */
  key: string | null;
  /** Page URL captured at queue time. Surfaced to the approver. */
  pageUrl: string;
};

type BrowserExecutionState = {
  version: 1;
  state: "claimed" | "executed" | "failed";
  claimTokenHash: string;
  claimedAt: string;
  completedAt?: string;
};

function parseBrowserActionPayload(json: string | null): BrowserActionPayload {
  if (!json) throw new Error("Approval payload is empty");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Approval payload is not valid JSON");
  }
  const payload = value as Partial<BrowserActionPayload> | null;
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.selector !== "string" ||
    payload.selector.length === 0 ||
    (payload.key !== null && typeof payload.key !== "string") ||
    typeof payload.pageUrl !== "string"
  ) {
    throw new Error("Invalid browser action payload");
  }
  return {
    selector: payload.selector,
    key: payload.key,
    pageUrl: payload.pageUrl,
  };
}

function parseBrowserExecutionState(json: string | null): BrowserExecutionState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<BrowserExecutionState> | null;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !["claimed", "executed", "failed"].includes(parsed.state ?? "") ||
      typeof parsed.claimTokenHash !== "string" ||
      typeof parsed.claimedAt !== "string"
    ) {
      return null;
    }
    return parsed as BrowserExecutionState;
  } catch {
    return null;
  }
}

function browserClaimTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hasLegacyBrowserExecutionStamp(approval: Approval): boolean {
  try {
    const payload = JSON.parse(approval.payloadJson || "{}") as { executedAt?: unknown };
    return typeof payload.executedAt === "string";
  } catch {
    return false;
  }
}

export function browserApprovalWasExecuted(approval: Approval): boolean {
  return (
    hasLegacyBrowserExecutionStamp(approval) ||
    parseBrowserExecutionState(approval.resultJson)?.state === "executed"
  );
}

export type BrowserApprovalClaimResult =
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "invalid_payload"; approval: Approval }
  | { outcome: "conflict"; approval: Approval }
  | {
      outcome: "claimed";
      approval: Approval;
      claimToken: string;
      action: BrowserActionPayload;
    };

/**
 * Atomically consume an approved browser action before the browser can fire.
 *
 * The conditional `approved -> executing` update is the replay boundary. A
 * process crash, network loss, or browser timeout after this claim deliberately
 * leaves the row in `executing`: the outcome is ambiguous, so no later turn is
 * allowed to guess that it is safe to submit again.
 */
export async function claimApprovedBrowserAction(args: {
  companyId: string;
  employeeId: string;
  approvalId: string;
}): Promise<BrowserApprovalClaimResult> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = await repo.findOneBy({ id: args.approvalId, companyId: args.companyId });
  if (!approval || approval.kind !== "browser_action") return { outcome: "not_found" };
  if (approval.employeeId !== args.employeeId) return { outcome: "forbidden" };

  let action: BrowserActionPayload;
  try {
    action = parseBrowserActionPayload(approval.payloadJson);
  } catch {
    return { outcome: "invalid_payload", approval };
  }
  if (hasLegacyBrowserExecutionStamp(approval)) return { outcome: "conflict", approval };

  const claimToken = crypto.randomBytes(32).toString("base64url");
  const claimedAt = new Date().toISOString();
  const claimState: BrowserExecutionState = {
    version: 1,
    state: "claimed",
    claimTokenHash: browserClaimTokenHash(claimToken),
    claimedAt,
  };
  const updated = await repo.update(
    {
      id: approval.id,
      companyId: args.companyId,
      employeeId: args.employeeId,
      kind: "browser_action",
      status: "approved",
      resultJson: IsNull(),
    },
    {
      status: "executing",
      resultJson: JSON.stringify(claimState),
      errorMessage: null,
    },
  );
  const current = await repo.findOneByOrFail({ id: approval.id, companyId: args.companyId });
  if (updated.affected !== 1) return { outcome: "conflict", approval: current };
  return { outcome: "claimed", approval: current, claimToken, action };
}

export type BrowserApprovalCompletionResult =
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "conflict"; approval: Approval }
  | { outcome: "completed" | "already_completed"; approval: Approval };

/**
 * Finalize a claimed browser action. Completion is compare-and-set against the
 * exact claim receipt, so a different MCP child cannot finish another child's
 * claim. Failure is terminal; success returns to `approved` with an execution
 * receipt in `resultJson`, which prevents another claim.
 */
export async function completeClaimedBrowserAction(args: {
  companyId: string;
  employeeId: string;
  approvalId: string;
  claimToken: string;
  outcome: "executed" | "failed";
  errorMessage?: string;
}): Promise<BrowserApprovalCompletionResult> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = await repo.findOneBy({ id: args.approvalId, companyId: args.companyId });
  if (!approval || approval.kind !== "browser_action") return { outcome: "not_found" };
  if (approval.employeeId !== args.employeeId) return { outcome: "forbidden" };

  const claimedResultJson = approval.resultJson;
  const state = parseBrowserExecutionState(claimedResultJson);
  const claimTokenHash = browserClaimTokenHash(args.claimToken);
  if (!claimedResultJson || !state || state.claimTokenHash !== claimTokenHash) {
    return { outcome: "conflict", approval };
  }
  if (state.state !== "claimed") {
    return state.state === args.outcome
      ? { outcome: "already_completed", approval }
      : { outcome: "conflict", approval };
  }
  if (approval.status !== "executing") return { outcome: "conflict", approval };

  const completedState: BrowserExecutionState = {
    ...state,
    state: args.outcome,
    completedAt: new Date().toISOString(),
  };
  const updated = await repo.update(
    {
      id: approval.id,
      companyId: args.companyId,
      employeeId: args.employeeId,
      kind: "browser_action",
      status: "executing",
      resultJson: claimedResultJson,
    },
    {
      status: args.outcome === "executed" ? "approved" : "execution_failed",
      resultJson: JSON.stringify(completedState),
      errorMessage:
        args.outcome === "failed"
          ? (args.errorMessage || "The browser action failed after it was claimed.").slice(0, 2000)
          : null,
    },
  );
  const current = await repo.findOneByOrFail({ id: approval.id, companyId: args.companyId });
  if (updated.affected !== 1) {
    const currentState = parseBrowserExecutionState(current.resultJson);
    if (currentState?.claimTokenHash === claimTokenHash && currentState.state === args.outcome) {
      return { outcome: "already_completed", approval: current };
    }
    return { outcome: "conflict", approval: current };
  }
  return { outcome: "completed", approval: current };
}

// --------------------------------------------------------------------------
// Ad-spend payload
// --------------------------------------------------------------------------

/**
 * Captured when an ads provider throws `ApprovalRequiredError` with an
 * `ad_spend` request — a budget increase or campaign enable above the
 * Connection's approval threshold. The original tool call is replayed
 * verbatim on approve with `bypassApprovalGate` set; hard caps still run,
 * and `beforeState` rides along as `ctx.approvalSnapshot` so the provider
 * can re-read the live object and abort when it drifted since queueing.
 */
export type AdSpendPayload = {
  connectionId: string;
  toolName: string;
  /** Original args, replayed verbatim. */
  args: Record<string, unknown>;
  amountMinor: number;
  currency: string;
  platform: string;
  mutationKind: string;
  adAccountRef?: string;
  campaignRef?: string;
  beforeState?: Record<string, unknown>;
  description?: string;
};

function parseAdSpendPayload(json: string | null): AdSpendPayload {
  if (!json) throw new Error("Approval payload is empty");
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("Approval payload is not valid JSON");
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    typeof (obj as AdSpendPayload).connectionId !== "string" ||
    typeof (obj as AdSpendPayload).toolName !== "string"
  ) {
    throw new Error("Invalid ad-spend payload");
  }
  return obj as AdSpendPayload;
}

// --------------------------------------------------------------------------
// Guarded MCP tool payload
// --------------------------------------------------------------------------

/**
 * Captured when an AI employee calls a tool matched by its MCP server's
 * `guardedToolsJson` patterns. Unlike `browser_action`, the server CAN
 * replay this: on approve we reconnect to the same MCP server (stdio spawn
 * or HTTP) and fire the verbatim call.
 */
export type McpToolPayload = {
  mcpServerId: string;
  serverName: string;
  /** Native tool name as the MCP server exposes it. */
  toolName: string;
  /** Original args, replayed verbatim. */
  args: Record<string, unknown>;
};

function parseMcpToolPayload(json: string | null): McpToolPayload {
  if (!json) throw new Error("Approval payload is empty");
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new Error("Approval payload is not valid JSON");
  }
  if (
    !obj ||
    typeof obj !== "object" ||
    typeof (obj as McpToolPayload).mcpServerId !== "string" ||
    typeof (obj as McpToolPayload).toolName !== "string"
  ) {
    throw new Error("Invalid MCP tool payload");
  }
  return obj as McpToolPayload;
}

// --------------------------------------------------------------------------
// Create helpers
// --------------------------------------------------------------------------

export async function createAdSpendApproval(args: {
  companyId: string;
  employeeId: string;
  connectionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  title: string;
  summary?: string | null;
  request: AdSpendApprovalRequest;
}): Promise<Approval> {
  const repo = AppDataSource.getRepository(Approval);
  const safeTitle = redactApprovalSummary(args.title);
  const safeSummary = redactApprovalSummary(args.summary ?? null);
  const approval = repo.create({
    companyId: args.companyId,
    kind: "ad_spend",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title: safeTitle,
    summary: safeSummary,
    payloadJson: JSON.stringify({
      connectionId: args.connectionId,
      toolName: args.toolName,
      args: args.toolArgs,
      amountMinor: args.request.amountMinor,
      currency: args.request.currency,
      platform: args.request.platform,
      mutationKind: args.request.mutationKind,
      adAccountRef: args.request.adAccountRef,
      campaignRef: args.request.campaignRef,
      beforeState: args.request.beforeState,
      description: args.summary ?? undefined,
    } satisfies AdSpendPayload),
  });
  const saved = await repo.save(approval);
  notifyPending(saved);
  return saved;
}

export async function createMcpToolApproval(args: {
  companyId: string;
  employeeId: string;
  mcpServerId: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}): Promise<Approval> {
  const repo = AppDataSource.getRepository(Approval);
  const argsPreview = approvalArgsPreview(args.toolArgs);
  const safeTitle = redactApprovalSummary(`MCP tool · ${args.serverName} · ${args.toolName}`);
  const approval = repo.create({
    companyId: args.companyId,
    kind: "mcp_tool",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title: safeTitle,
    summary: argsPreview.length > 400 ? argsPreview.slice(0, 397) + "..." : argsPreview,
    payloadJson: JSON.stringify({
      mcpServerId: args.mcpServerId,
      serverName: args.serverName,
      toolName: args.toolName,
      args: args.toolArgs,
    } satisfies McpToolPayload),
  });
  const saved = await repo.save(approval);
  notifyPending(saved);
  return saved;
}

export async function createBrowserActionApproval(args: {
  companyId: string;
  employeeId: string;
  selector: string;
  key: string | null;
  pageUrl: string;
  summary: string;
}): Promise<Approval> {
  const repo = AppDataSource.getRepository(Approval);
  const safeSummary = redactApprovalSummary(args.summary) ?? "Browser action";
  const title = safeSummary.length > 80 ? safeSummary.slice(0, 77) + "..." : safeSummary;
  const approval = repo.create({
    companyId: args.companyId,
    kind: "browser_action",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title,
    summary: args.pageUrl
      ? `${safeSummary}  ·  ${approvalPageUrlPreview(args.pageUrl)}`
      : safeSummary,
    payloadJson: JSON.stringify({
      selector: args.selector,
      key: args.key,
      pageUrl: args.pageUrl,
    } satisfies BrowserActionPayload),
  });
  const saved = await repo.save(approval);
  notifyPending(saved);
  return saved;
}

export async function createPaymentApproval(args: {
  companyId: string;
  employeeId: string;
  connectionId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  amountSats: number;
  title: string;
  summary?: string | null;
}): Promise<Approval> {
  const repo = AppDataSource.getRepository(Approval);
  const safeTitle = redactApprovalSummary(args.title);
  const safeSummary = redactApprovalSummary(args.summary ?? null);
  const approval = repo.create({
    companyId: args.companyId,
    kind: "lightning_payment",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title: safeTitle,
    summary: safeSummary,
    payloadJson: JSON.stringify({
      connectionId: args.connectionId,
      toolName: args.toolName,
      args: args.toolArgs,
      amountSats: args.amountSats,
      description: args.summary ?? undefined,
    } satisfies LightningPaymentPayload),
  });
  const saved = await repo.save(approval);
  notifyPending(saved);
  return saved;
}

// --------------------------------------------------------------------------
// Execute (called from the route after a human approves)
// --------------------------------------------------------------------------

export type ApprovalDecisionResult =
  | { outcome: "not_found" }
  | { outcome: "conflict"; approval: Approval }
  | { outcome: "decided"; approval: Approval; sideEffectError?: string };

type ApprovalExecutor = (approval: Approval) => Promise<void>;
type ApprovalRejectionRecorder = (approval: Approval) => Promise<void>;

async function claimApprovalDecision(args: {
  companyId: string;
  approvalId: string;
  userId: string;
  status: "executing" | "rejected";
}): Promise<ApprovalDecisionResult> {
  const repo = AppDataSource.getRepository(Approval);
  const decidedAt = new Date();
  const update = await repo.update(
    {
      id: args.approvalId,
      companyId: args.companyId,
      status: "pending",
    },
    {
      status: args.status,
      decidedAt,
      decidedByUserId: args.userId,
      errorMessage: null,
    },
  );

  const approval = await repo.findOneBy({
    id: args.approvalId,
    companyId: args.companyId,
  });
  if (!approval) return { outcome: "not_found" };
  if (update.affected !== 1) return { outcome: "conflict", approval };
  return { outcome: "decided", approval };
}

async function recordDecisionAudit(
  approval: Approval,
  userId: string,
  action: "approval.approve" | "approval.reject",
): Promise<void> {
  await recordAudit({
    companyId: approval.companyId,
    actorUserId: userId,
    action,
    targetType: "approval",
    targetId: approval.id,
    targetLabel: redactApprovalSummary(approval.title) ?? "",
    metadata: {
      kind: approval.kind,
      routineId: approval.routineId || undefined,
    },
  });
}

/**
 * Claim and execute one pending approval.
 *
 * `pending -> executing` is a single conditional UPDATE. Only the request
 * whose UPDATE affects one row may run the downstream action; every duplicate,
 * concurrent approval, or concurrent rejection observes a conflict. A failed
 * action moves to `execution_failed` and remains non-retryable so an ambiguous
 * provider timeout cannot be turned into a duplicate payment or mutation.
 */
export async function approvePendingApproval(args: {
  companyId: string;
  approvalId: string;
  userId: string;
  execute?: ApprovalExecutor;
}): Promise<ApprovalDecisionResult> {
  const claimed = await claimApprovalDecision({
    companyId: args.companyId,
    approvalId: args.approvalId,
    userId: args.userId,
    status: "executing",
  });
  if (claimed.outcome !== "decided") return claimed;

  const approval = claimed.approval;
  await recordDecisionAudit(approval, args.userId, "approval.approve");

  try {
    await (args.execute ?? executeApproval)(approval);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[approvals] execution failed for ${approval.id}:`, err);
    await AppDataSource.getRepository(Approval).update(
      {
        id: approval.id,
        companyId: approval.companyId,
        status: "executing",
      },
      { status: "execution_failed", errorMessage },
    );
    await recordAudit({
      companyId: approval.companyId,
      actorUserId: args.userId,
      action: "approval.execute_failed",
      targetType: "approval",
      targetId: approval.id,
      targetLabel: redactApprovalSummary(approval.title) ?? "",
      metadata: { kind: approval.kind },
    });
    const failed = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
      companyId: approval.companyId,
    });
    return { outcome: "decided", approval: failed, sideEffectError: errorMessage };
  }

  const repo = AppDataSource.getRepository(Approval);
  const finalized = await repo.update(
    {
      id: approval.id,
      companyId: approval.companyId,
      status: "executing",
    },
    { status: "approved", errorMessage: null },
  );
  if (finalized.affected !== 1) {
    throw new Error(`Approval ${approval.id} changed state while it was executing`);
  }
  return {
    outcome: "decided",
    approval: await repo.findOneByOrFail({ id: approval.id, companyId: approval.companyId }),
  };
}

/** Atomically reject one pending approval and record its rejection hook once. */
export async function rejectPendingApproval(args: {
  companyId: string;
  approvalId: string;
  userId: string;
  recordRejection?: ApprovalRejectionRecorder;
}): Promise<ApprovalDecisionResult> {
  const claimed = await claimApprovalDecision({
    companyId: args.companyId,
    approvalId: args.approvalId,
    userId: args.userId,
    status: "rejected",
  });
  if (claimed.outcome !== "decided") return claimed;

  const approval = claimed.approval;
  await recordDecisionAudit(approval, args.userId, "approval.reject");
  try {
    await (args.recordRejection ?? recordApprovalRejection)(approval);
  } catch (err) {
    const sideEffectError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[approvals] rejection journal failed for ${approval.id}:`, err);
    await AppDataSource.getRepository(Approval).update(
      { id: approval.id, companyId: approval.companyId, status: "rejected" },
      { errorMessage: sideEffectError },
    );
    await recordAudit({
      companyId: approval.companyId,
      actorUserId: args.userId,
      action: "approval.rejection_record_failed",
      targetType: "approval",
      targetId: approval.id,
      targetLabel: redactApprovalSummary(approval.title) ?? "",
      metadata: { kind: approval.kind },
    });
    const rejected = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: approval.id,
      companyId: approval.companyId,
    });
    return { outcome: "decided", approval: rejected, sideEffectError };
  }
  return { outcome: "decided", approval };
}

/**
 * Run the side-effect of a claimed approval. Throws on failure; the decision
 * service persists the terminal `execution_failed` state.
 */
export async function executeApproval(approval: Approval): Promise<void> {
  switch (approval.kind) {
    case "routine":
      await executeRoutineApproval(approval);
      return;
    case "lightning_payment":
      await executeLightningPaymentApproval(approval);
      return;
    case "browser_action":
      // Server side has no browser. The model re-fires the held action
      // via `browser_resume(approvalId)` once the row flips to approved.
      return;
    case "mcp_tool":
      await executeMcpToolApproval(approval);
      return;
    case "ad_spend":
      await executeAdSpendApproval(approval);
      return;
    default:
      throw new Error(`Unknown approval kind: ${approval.kind}`);
  }
}

/**
 * Replay an approved ad-spend mutation. Mirrors the Lightning contract:
 * `bypassApprovalGate` skips only the approval gate — the provider's hard
 * caps (per-change, rolling daily/monthly, kill switch) run again on this
 * path, and the queued `beforeState` snapshot rides along as
 * `ctx.approvalSnapshot` so the provider aborts when the live object no
 * longer matches what the human looked at.
 */
async function executeAdSpendApproval(approval: Approval): Promise<void> {
  const payload = parseAdSpendPayload(approval.payloadJson);
  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: payload.connectionId,
  });
  if (!conn) throw new Error("Ads connection no longer exists");
  if (conn.companyId !== approval.companyId) {
    throw new Error("Connection belongs to a different company");
  }

  const provider = getProvider(conn.provider);
  if (!provider) throw new Error(`Unknown provider: ${conn.provider}`);

  const credentialSnapshot = conn.encryptedConfig;
  const cfg = decryptConnectionConfig(conn);
  let refreshed: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: conn.authMode,
    config: cfg,
    setConfig(next) {
      refreshed = next;
    },
    connectionId: conn.id,
    companyId: conn.companyId,
    employeeId: approval.employeeId || undefined,
    bypassApprovalGate: true,
    approvalSnapshot: payload.beforeState,
    adSpend: makeAdSpendLedger({
      connection: conn,
      employeeId: approval.employeeId || undefined,
      approvalId: approval.id,
    }),
  };

  const result = await provider.invokeTool(payload.toolName, payload.args, ctx);
  if (refreshed) {
    await persistConnectionConfigIfCurrent({
      connectionId: conn.id,
      companyId: conn.companyId,
      previousEncryptedConfig: credentialSnapshot,
      config: refreshed,
      healthy: true,
    });
  }
  approval.resultJson = JSON.stringify(result);
  await AppDataSource.getRepository(Approval).save(approval);
}

/**
 * Replay an approved guarded MCP tool call: reconnect to the server the
 * call was queued against and fire the verbatim tool + args. The tool's
 * text result lands on `resultJson`; an isError result throws so the route
 * captures it on `errorMessage`.
 */
async function executeMcpToolApproval(approval: Approval): Promise<void> {
  const payload = parseMcpToolPayload(approval.payloadJson);
  const row = await AppDataSource.getRepository(McpServer).findOneBy({
    id: payload.mcpServerId,
  });
  if (!row) throw new Error("MCP server no longer exists");
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: row.employeeId,
  });
  if (!employee || employee.companyId !== approval.companyId) {
    throw new Error("MCP server belongs to a different company");
  }
  const spec = specForMcpServerRow(row);
  if (!spec) throw new Error("MCP server has no runnable transport config");

  const bridged = await connectMcpServer(row.name, spec, "");
  try {
    const wanted = nativeToolName(payload.toolName);
    const tool = bridged.tools.find((t) => t.name === wanted);
    if (!tool) {
      throw new Error(`Tool "${payload.toolName}" no longer exists on MCP server "${row.name}"`);
    }
    const result = await tool.run(payload.args);
    if (result.isError) {
      throw new Error(result.content || "Tool call failed");
    }
    approval.resultJson = JSON.stringify({ content: result.content });
    await AppDataSource.getRepository(Approval).save(approval);
  } finally {
    await bridged.close();
  }
}

async function executeRoutineApproval(approval: Approval): Promise<void> {
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: approval.routineId,
  });
  if (!routine) throw new Error("Routine no longer exists");
  // Fire-and-forget — the routine runner persists progress to the Run
  // table. The HTTP caller doesn't wait for completion.
  runRoutine(routine, { triggerKind: "approval" }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[approvals] routine ${routine.id} failed post-approval:`, err);
  });
}

async function executeLightningPaymentApproval(approval: Approval): Promise<void> {
  const payload = parsePaymentPayload(approval.payloadJson);
  const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: payload.connectionId,
  });
  if (!conn) throw new Error("Lightning connection no longer exists");
  if (conn.companyId !== approval.companyId) {
    throw new Error("Connection belongs to a different company");
  }

  const provider = getProvider(conn.provider);
  if (!provider) throw new Error(`Unknown provider: ${conn.provider}`);

  const credentialSnapshot = conn.encryptedConfig;
  const cfg = decryptConnectionConfig(conn);
  let refreshed: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: conn.authMode,
    config: cfg,
    setConfig(next) {
      refreshed = next;
    },
    connectionId: conn.id,
    companyId: conn.companyId,
    employeeId: approval.employeeId || undefined,
    bypassApprovalGate: true,
  };

  const result = await provider.invokeTool(payload.toolName, payload.args, ctx);
  if (refreshed) {
    await persistConnectionConfigIfCurrent({
      connectionId: conn.id,
      companyId: conn.companyId,
      previousEncryptedConfig: credentialSnapshot,
      config: refreshed,
      healthy: true,
    });
  }
  approval.resultJson = JSON.stringify(result);
  await AppDataSource.getRepository(Approval).save(approval);
}

// --------------------------------------------------------------------------
// Reject hook
// --------------------------------------------------------------------------

export async function recordApprovalRejection(approval: Approval): Promise<void> {
  switch (approval.kind) {
    case "routine": {
      const routine = await AppDataSource.getRepository(Routine).findOneBy({
        id: approval.routineId,
      });
      if (!routine) return;
      await AppDataSource.getRepository(JournalEntry).save(
        AppDataSource.getRepository(JournalEntry).create({
          employeeId: approval.employeeId,
          kind: "system",
          title: `Approval rejected for routine "${routine.name}"`,
          body: "No run was performed.",
          routineId: routine.id,
          runId: null,
          authorUserId: approval.decidedByUserId,
        }),
      );
      return;
    }
    case "lightning_payment": {
      const summary = approval.summary
        ? `Payment rejected: ${redactApprovalSummary(approval.summary)}`
        : "Lightning payment rejected.";
      await AppDataSource.getRepository(JournalEntry).save(
        AppDataSource.getRepository(JournalEntry).create({
          employeeId: approval.employeeId,
          kind: "system",
          title: redactApprovalSummary(approval.title) ?? "Lightning payment rejected",
          body: summary,
          routineId: null,
          runId: null,
          authorUserId: approval.decidedByUserId,
        }),
      );
      return;
    }
    case "browser_action": {
      const summary = approval.summary
        ? `Browser action rejected: ${redactApprovalSummary(approval.summary)}`
        : "Browser action rejected.";
      await AppDataSource.getRepository(JournalEntry).save(
        AppDataSource.getRepository(JournalEntry).create({
          employeeId: approval.employeeId,
          kind: "system",
          title: redactApprovalSummary(approval.title) ?? "Browser action rejected",
          body: summary,
          routineId: null,
          runId: null,
          authorUserId: approval.decidedByUserId,
        }),
      );
      return;
    }
    case "mcp_tool": {
      await AppDataSource.getRepository(JournalEntry).save(
        AppDataSource.getRepository(JournalEntry).create({
          employeeId: approval.employeeId,
          kind: "system",
          title: redactApprovalSummary(approval.title) ?? "Guarded MCP tool call rejected",
          body: "The guarded tool call was rejected by a human. It was not executed.",
          routineId: null,
          runId: null,
          authorUserId: approval.decidedByUserId,
        }),
      );
      return;
    }
    case "ad_spend": {
      const summary = approval.summary
        ? `Ad spend change rejected: ${redactApprovalSummary(approval.summary)}`
        : "Ad spend change rejected. No mutation was applied.";
      await AppDataSource.getRepository(JournalEntry).save(
        AppDataSource.getRepository(JournalEntry).create({
          employeeId: approval.employeeId,
          kind: "system",
          title: redactApprovalSummary(approval.title) ?? "Ad spend change rejected",
          body: summary,
          routineId: null,
          runId: null,
          authorUserId: approval.decidedByUserId,
        }),
      );
      return;
    }
  }
}
