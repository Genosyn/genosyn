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
import { decryptSecretWithStrongKeys, encryptSecret } from "../lib/secret.js";
import { getEffectiveInstanceSecrets } from "../lib/instanceSecrets.js";
import { Membership } from "../db/entities/Membership.js";

export { approvalArgsPreview, redactApprovalSummary } from "./approvalRedaction.js";

/**
 * Whether this row is a Vault password capture — the one approval kind that is
 * owner/admin-only to even *see*, because its summary names the origin and item
 * a stored credential would be written to.
 *
 * Lives here rather than beside a single reader: both the approvals inbox and
 * the Home roll-up have to apply it, and two copies of a visibility predicate
 * is how one of them ends up out of date.
 */
export function isVaultCaptureApproval(approval: Approval): boolean {
  if (approval.kind !== "browser_action") return false;
  try {
    const payload = JSON.parse(approval.payloadJson || "{}") as { action?: unknown };
    return payload.action === "vault_capture";
  } catch {
    return false;
  }
}

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
 * flag is on, and always by a sensitive Vault password capture. The MCP child
 * holds the live page state — the server only
 * stores enough metadata for the approver to make an informed call. On
 * approve, the model retries via `browser_resume(approvalId)` and the MCP
 * re-executes the action against the still-live browser context.
 *
 * Server side never re-fires this. The execute path for `browser_action`
 * is a no-op because we don't have access to the browser session; the
 * model is the only thing that can drive it.
 */
export type BrowserApprovalTargetDescriptor = {
  /** Safe DOM element category. No values or text content are persisted. */
  tagName: string;
  inputType: string | null;
  /** Origin + path only; query, fragment, and userinfo are discarded. */
  frameUrl: string;
  formAction: string | null;
  formMethod: string | null;
  submitsForm: boolean;
};

type BrowserExecutionState = {
  version: 1;
  state: "claimed" | "executed" | "failed";
  claimTokenHash: string;
  claimedAt: string;
  completedAt?: string;
};

export type BrowserApprovalExecution = {
  state: "claimed" | "failed" | "executed";
  claimId: string;
  browserSessionId: string;
  claimedAt: string;
  completedAt?: string;
};

export type BrowserActionPayload = {
  action: "submit" | "vault_capture";
  selector: string;
  /** Optional key to press (e.g. "Enter") — null when the action is a click. */
  key: string | null;
  /** Page URL captured at queue time. Surfaced to the approver. */
  pageUrl: string;
  browserSessionId?: string;
  /** Keyed proof of the exact live target; opaque outside the App process. */
  targetFingerprint?: string;
  targetDescriptor?: BrowserApprovalTargetDescriptor;
  expiresAt?: string;
  vaultTitle?: string;
  vaultUsername?: string;
  vaultNotes?: string;
  execution?: BrowserApprovalExecution;
};

type StoredBrowserActionPayload = Partial<BrowserActionPayload> & {
  action?: "submit" | "vault_capture";
  encryptedVaultCapture?: string;
  executedAt?: string;
};

export class BrowserApprovalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "BrowserApprovalError";
  }
}

function vaultCaptureApprovalScope(approval: Pick<Approval, "id" | "companyId">): string {
  return `company:${approval.companyId}:vault-capture-approval:${approval.id}`;
}

function ciphertextHasScope(ciphertext: string, expectedScope: string): boolean {
  const parts = ciphertext.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return false;
  try {
    return Buffer.from(parts[1], "base64url").toString("utf8") === expectedScope;
  } catch {
    return false;
  }
}

function parseStoredBrowserActionPayload(approval: Approval): StoredBrowserActionPayload {
  let stored: StoredBrowserActionPayload;
  try {
    stored = JSON.parse(approval.payloadJson || "{}") as StoredBrowserActionPayload;
  } catch {
    throw new Error("Browser approval payload is not valid JSON");
  }
  if (!stored || typeof stored !== "object") {
    throw new Error("Browser approval payload has an invalid shape");
  }
  return stored;
}

function validBrowserTargetDescriptor(value: unknown): value is BrowserApprovalTargetDescriptor {
  if (!value || typeof value !== "object") return false;
  const descriptor = value as Partial<BrowserApprovalTargetDescriptor>;
  return (
    typeof descriptor.tagName === "string" &&
    descriptor.tagName.length > 0 &&
    descriptor.tagName.length <= 32 &&
    (descriptor.inputType === null ||
      (typeof descriptor.inputType === "string" && descriptor.inputType.length <= 32)) &&
    typeof descriptor.frameUrl === "string" &&
    descriptor.frameUrl.length > 0 &&
    descriptor.frameUrl === safeBrowserApprovalPageUrl(descriptor.frameUrl) &&
    (descriptor.formAction === null ||
      (typeof descriptor.formAction === "string" &&
        descriptor.formAction.length > 0 &&
        descriptor.formAction === safeBrowserApprovalPageUrl(descriptor.formAction))) &&
    (descriptor.formMethod === null ||
      (typeof descriptor.formMethod === "string" && descriptor.formMethod.length <= 16)) &&
    typeof descriptor.submitsForm === "boolean"
  );
}

function validBrowserApprovalExecution(value: unknown): value is BrowserApprovalExecution {
  if (!value || typeof value !== "object") return false;
  const execution = value as Partial<BrowserApprovalExecution>;
  return (
    (execution.state === "claimed" ||
      execution.state === "failed" ||
      execution.state === "executed") &&
    typeof execution.claimId === "string" &&
    /^[0-9a-f-]{36}$/i.test(execution.claimId) &&
    typeof execution.browserSessionId === "string" &&
    typeof execution.claimedAt === "string" &&
    (execution.completedAt === undefined || typeof execution.completedAt === "string")
  );
}

/**
 * Produce an opaque proof of a live browser target. Sensitive values (most
 * importantly a captured password) may be included in `targetMaterial`, but
 * only the HMAC is returned or persisted. Company, employee, BrowserSession,
 * selector, and action identity are all domain-separated into the proof.
 */
export function computeBrowserActionTargetFingerprint(args: {
  companyId: string;
  employeeId: string;
  browserSessionId: string;
  action: "submit" | "vault_capture";
  selector: string;
  key: string | null;
  pageUrl: string;
  targetMaterial: Record<string, unknown>;
}): string {
  const fingerprintKey = crypto
    .createHmac("sha256", getEffectiveInstanceSecrets().encryptionSecret)
    .update("genosyn/browser-approval-target/v1", "utf8")
    .digest();
  return crypto
    .createHmac("sha256", fingerprintKey)
    .update(
      JSON.stringify({
        companyId: args.companyId,
        employeeId: args.employeeId,
        browserSessionId: args.browserSessionId,
        action: args.action,
        selector: args.selector,
        key: args.key,
        pageUrl: args.pageUrl,
        targetMaterial: args.targetMaterial,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Decode a browser approval while keeping Vault-capture metadata encrypted at rest. */
export function readBrowserActionPayload(approval: Approval): BrowserActionPayload {
  const stored = parseStoredBrowserActionPayload(approval);
  if (stored.action === undefined) {
    if (
      typeof stored.selector !== "string" ||
      stored.selector.length === 0 ||
      (stored.key !== null && typeof stored.key !== "string") ||
      typeof stored.pageUrl !== "string"
    ) {
      throw new Error("Browser approval payload has an invalid legacy shape");
    }
    return {
      action: "submit",
      selector: stored.selector,
      key: stored.key,
      pageUrl: stored.pageUrl,
    };
  }
  if (stored.action !== "submit" && stored.action !== "vault_capture") {
    throw new Error("Browser approval payload has an invalid action");
  }
  if (
    typeof stored.browserSessionId !== "string" ||
    !/^[0-9a-f]{64}$/.test(stored.targetFingerprint ?? "") ||
    !validBrowserTargetDescriptor(stored.targetDescriptor) ||
    (stored.execution !== undefined && !validBrowserApprovalExecution(stored.execution))
  ) {
    throw new Error("Browser approval payload has an invalid target binding");
  }
  if (stored.action !== "vault_capture") {
    if (typeof stored.selector !== "string" || typeof stored.pageUrl !== "string") {
      throw new Error("Browser approval payload has an invalid shape");
    }
    return stored as BrowserActionPayload;
  }
  if (
    typeof stored.encryptedVaultCapture !== "string" ||
    !ciphertextHasScope(stored.encryptedVaultCapture, vaultCaptureApprovalScope(approval))
  ) {
    throw new Error("Vault capture approval payload is invalid");
  }
  let details: BrowserActionPayload;
  try {
    details = JSON.parse(
      decryptSecretWithStrongKeys(stored.encryptedVaultCapture),
    ) as BrowserActionPayload;
  } catch {
    throw new Error("Vault capture approval payload could not be decrypted");
  }
  if (
    details.action !== "vault_capture" ||
    typeof details.selector !== "string" ||
    typeof details.pageUrl !== "string" ||
    typeof details.browserSessionId !== "string" ||
    typeof details.expiresAt !== "string" ||
    typeof details.vaultTitle !== "string" ||
    typeof details.vaultUsername !== "string" ||
    typeof details.vaultNotes !== "string"
  ) {
    throw new Error("Vault capture approval payload has an invalid shape");
  }
  return {
    ...details,
    browserSessionId: stored.browserSessionId,
    targetFingerprint: stored.targetFingerprint!,
    targetDescriptor: stored.targetDescriptor!,
    execution: stored.execution,
  };
}

/**
 * Approval rows are durable and company-visible. Persist only the URL parts
 * needed to bind a resumed browser action, never userinfo, query parameters,
 * or fragments that may contain reset tokens or OAuth codes.
 */
export function safeBrowserApprovalPageUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function browserApprovalPageLabel(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
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

function browserPayloadExecutionState(approval: Approval): BrowserApprovalExecution["state"] | null {
  try {
    const stored = parseStoredBrowserActionPayload(approval);
    return validBrowserApprovalExecution(stored.execution) ? stored.execution.state : null;
  } catch {
    return null;
  }
}

export function browserApprovalWasExecuted(approval: Approval): boolean {
  const payloadState = browserPayloadExecutionState(approval);
  return (
    hasLegacyBrowserExecutionStamp(approval) ||
    parseBrowserExecutionState(approval.resultJson)?.state === "executed" ||
    payloadState === "claimed" ||
    payloadState === "executed"
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
 * Preserve the durable claim protocol used by pre-bound browser approvals.
 * New target-bound approvals are consumed at the Browser RPC boundary, where
 * the live DOM target can be revalidated immediately before Chromium acts.
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
    action = readBrowserActionPayload(approval);
  } catch {
    return { outcome: "invalid_payload", approval };
  }
  // A bound payload must use claimBrowserActionApproval so target identity is
  // checked against the live page. The legacy callback must never bypass it.
  if (action.browserSessionId || action.targetFingerprint || action.targetDescriptor) {
    return { outcome: "conflict", approval };
  }
  if (
    hasLegacyBrowserExecutionStamp(approval) ||
    browserPayloadExecutionState(approval) !== null
  ) {
    return { outcome: "conflict", approval };
  }

  const claimToken = crypto.randomBytes(32).toString("base64url");
  const claimState: BrowserExecutionState = {
    version: 1,
    state: "claimed",
    claimTokenHash: browserClaimTokenHash(claimToken),
    claimedAt: new Date().toISOString(),
  };
  const previousPayloadJson = approval.payloadJson || "";
  const updated = await repo.update(
    {
      id: approval.id,
      companyId: args.companyId,
      employeeId: args.employeeId,
      kind: "browser_action",
      status: "approved",
      payloadJson: previousPayloadJson,
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
  action?: "submit" | "vault_capture";
  selector: string;
  key: string | null;
  pageUrl: string;
  browserSessionId?: string;
  targetFingerprint?: string;
  targetDescriptor?: BrowserApprovalTargetDescriptor;
  summary: string;
  vaultTitle?: string;
  vaultUsername?: string;
  vaultNotes?: string;
}): Promise<Approval> {
  const repo = AppDataSource.getRepository(Approval);
  const id = crypto.randomUUID();
  const action = args.action ?? "submit";
  const bindingValues = [args.browserSessionId, args.targetFingerprint, args.targetDescriptor];
  const hasAnyBinding = bindingValues.some((value) => value !== undefined);
  const hasCompleteBinding =
    typeof args.browserSessionId === "string" &&
    typeof args.targetFingerprint === "string" &&
    args.targetDescriptor !== undefined;
  if (hasAnyBinding && !hasCompleteBinding) {
    throw new Error("Browser approval target binding is incomplete");
  }
  if (action === "vault_capture" && !hasCompleteBinding) {
    throw new Error("Vault capture approvals require a bound Browser target");
  }

  const rawSummary =
    action === "vault_capture"
      ? "Save the current password field as a restricted Vault login"
      : args.summary;
  const safeSummary = redactApprovalSummary(rawSummary) ?? "Browser action";
  const title = safeSummary.length > 80 ? safeSummary.slice(0, 77) + "..." : safeSummary;
  let summary: string;
  let payload: StoredBrowserActionPayload;

  if (hasCompleteBinding) {
    const browserSessionId = args.browserSessionId!;
    const targetFingerprint = args.targetFingerprint!;
    const suppliedDescriptor = args.targetDescriptor!;
    const pageUrl = safeBrowserApprovalPageUrl(args.pageUrl);
    if (!browserSessionId || !/^[0-9a-f]{64}$/.test(targetFingerprint)) {
      throw new Error("Browser approvals require a BrowserSession and target fingerprint");
    }
    const targetDescriptor: BrowserApprovalTargetDescriptor = {
      tagName: suppliedDescriptor.tagName.toLowerCase(),
      inputType: suppliedDescriptor.inputType?.toLowerCase() ?? null,
      frameUrl: safeBrowserApprovalPageUrl(suppliedDescriptor.frameUrl),
      formAction: suppliedDescriptor.formAction
        ? safeBrowserApprovalPageUrl(suppliedDescriptor.formAction)
        : null,
      formMethod: suppliedDescriptor.formMethod?.toUpperCase() ?? null,
      submitsForm: suppliedDescriptor.submitsForm,
    };
    if (!validBrowserTargetDescriptor(targetDescriptor)) {
      throw new Error("Browser approval target descriptor is invalid");
    }
    if (action === "vault_capture" && !args.vaultTitle) {
      throw new Error("Vault capture approvals require a title");
    }
    const expiresAt =
      action === "vault_capture"
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
        : undefined;
    payload =
      action === "vault_capture"
        ? {
            action,
            browserSessionId,
            targetFingerprint,
            targetDescriptor,
            encryptedVaultCapture: encryptSecret(
              JSON.stringify({
                action,
                selector: args.selector,
                key: args.key,
                pageUrl,
                browserSessionId,
                expiresAt,
                vaultTitle: args.vaultTitle ?? "",
                vaultUsername: args.vaultUsername ?? "",
                vaultNotes: args.vaultNotes ?? "",
              }),
              vaultCaptureApprovalScope({ id, companyId: args.companyId }),
            ),
          }
        : {
            action,
            selector: args.selector,
            key: args.key,
            pageUrl,
            browserSessionId,
            targetFingerprint,
            targetDescriptor,
          };
    const pageLabel = browserApprovalPageLabel(pageUrl);
    summary = pageLabel ? `${safeSummary}  ·  ${pageLabel}` : safeSummary;
  } else {
    payload = {
      selector: args.selector,
      key: args.key,
      pageUrl: args.pageUrl,
    };
    summary = args.pageUrl
      ? `${safeSummary}  ·  ${approvalPageUrlPreview(args.pageUrl)}`
      : safeSummary;
  }

  const approval = repo.create({
    id,
    companyId: args.companyId,
    kind: "browser_action",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title,
    summary,
    payloadJson: JSON.stringify(payload),
  });
  const saved = await repo.save(approval);
  notifyPending(saved);
  return saved;
}

function browserFingerprintsMatch(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export type ClaimBrowserActionApprovalArgs = {
  approvalId: string;
  companyId: string;
  employeeId: string;
  browserSessionId: string;
  action: "submit" | "vault_capture";
  selector: string;
  key: string | null;
  targetFingerprint: string;
  targetDescriptor: BrowserApprovalTargetDescriptor;
  vaultTitle?: string;
  vaultUsername?: string;
  vaultNotes?: string;
};

/**
 * Atomically reserve an approved browser action immediately before the App
 * drives Chromium. The exact previous payload is part of the UPDATE predicate,
 * so concurrent resumes cannot both claim the same approval on SQLite or
 * Postgres. A caught execution failure can be settled as `failed` and retried;
 * a process crash remains `claimed` and therefore fails closed.
 */
export async function claimBrowserActionApproval(
  args: ClaimBrowserActionApprovalArgs,
): Promise<{ claimId: string; payload: BrowserActionPayload }> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = await repo.findOneBy({ id: args.approvalId });
  if (
    !approval ||
    approval.kind !== "browser_action" ||
    approval.companyId !== args.companyId ||
    approval.employeeId !== args.employeeId
  ) {
    throw new BrowserApprovalError("Browser approval not found", 404);
  }
  if (approval.status !== "approved" || !approval.decidedByUserId) {
    throw new BrowserApprovalError("Browser action has not been approved", 403);
  }

  let payload: BrowserActionPayload;
  let stored: StoredBrowserActionPayload;
  try {
    stored = parseStoredBrowserActionPayload(approval);
    payload = readBrowserActionPayload(approval);
  } catch {
    throw new BrowserApprovalError("Browser approval payload is invalid", 409);
  }
  if (
    approval.resultJson !== null ||
    payload.execution?.state === "executed" ||
    payload.execution?.state === "claimed"
  ) {
    throw new BrowserApprovalError("This browser approval has already been used", 409);
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
    throw new BrowserApprovalError("Browser approval has expired", 409);
  }
  const normalizedDescriptor: BrowserApprovalTargetDescriptor = {
    tagName: args.targetDescriptor.tagName.toLowerCase(),
    inputType: args.targetDescriptor.inputType?.toLowerCase() ?? null,
    frameUrl: safeBrowserApprovalPageUrl(args.targetDescriptor.frameUrl),
    formAction: args.targetDescriptor.formAction
      ? safeBrowserApprovalPageUrl(args.targetDescriptor.formAction)
      : null,
    formMethod: args.targetDescriptor.formMethod?.toUpperCase() ?? null,
    submitsForm: args.targetDescriptor.submitsForm,
  };
  const actionMatches =
    payload.action === args.action &&
    payload.browserSessionId === args.browserSessionId &&
    payload.selector === args.selector &&
    (payload.key ?? null) === args.key &&
    typeof payload.targetFingerprint === "string" &&
    browserFingerprintsMatch(payload.targetFingerprint, args.targetFingerprint) &&
    payload.targetDescriptor !== undefined &&
    JSON.stringify(payload.targetDescriptor) === JSON.stringify(normalizedDescriptor) &&
    (payload.action !== "vault_capture" ||
      (payload.vaultTitle === (args.vaultTitle ?? "") &&
        payload.vaultUsername === (args.vaultUsername ?? "") &&
        payload.vaultNotes === (args.vaultNotes ?? "")));
  if (!actionMatches) {
    throw new BrowserApprovalError("Browser target no longer matches the approved action", 409);
  }
  if (payload.action === "vault_capture") {
    const approver = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: args.companyId,
      userId: approval.decidedByUserId,
    });
    if (!approver || (approver.role !== "owner" && approver.role !== "admin")) {
      throw new BrowserApprovalError("Vault capture requires owner or admin approval", 403);
    }
  }

  const claimId = crypto.randomUUID();
  const execution: BrowserApprovalExecution = {
    state: "claimed",
    claimId,
    browserSessionId: args.browserSessionId,
    claimedAt: new Date().toISOString(),
  };
  const previousPayloadJson = approval.payloadJson || "";
  const nextPayloadJson = JSON.stringify({ ...stored, execution });
  const updated = await repo
    .createQueryBuilder()
    .update(Approval)
    .set({ payloadJson: nextPayloadJson })
    .where("id = :id", { id: approval.id })
    .andWhere("status = :status", { status: "approved" })
    .andWhere('"resultJson" IS NULL')
    .andWhere('"payloadJson" = :previousPayloadJson', { previousPayloadJson })
    .execute();
  if (updated.affected !== 1) {
    throw new BrowserApprovalError("This browser approval was claimed concurrently", 409);
  }
  return { claimId, payload: { ...payload, execution } };
}

/** Settle only the matching live claim. Failed actions may be reclaimed. */
export async function settleBrowserActionApproval(args: {
  approvalId: string;
  claimId: string;
  succeeded: boolean;
}): Promise<void> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = await repo.findOneBy({ id: args.approvalId });
  if (!approval || approval.kind !== "browser_action") {
    throw new BrowserApprovalError("Browser approval not found", 404);
  }
  let stored: StoredBrowserActionPayload;
  try {
    stored = parseStoredBrowserActionPayload(approval);
  } catch {
    throw new BrowserApprovalError("Browser approval payload is invalid", 409);
  }
  if (
    !validBrowserApprovalExecution(stored.execution) ||
    stored.execution.state !== "claimed" ||
    stored.execution.claimId !== args.claimId
  ) {
    throw new BrowserApprovalError("Browser approval claim is no longer active", 409);
  }
  const execution: BrowserApprovalExecution = {
    ...stored.execution,
    state: args.succeeded ? "executed" : "failed",
    completedAt: new Date().toISOString(),
  };
  const previousPayloadJson = approval.payloadJson || "";
  const updated = await repo
    .createQueryBuilder()
    .update(Approval)
    .set({ payloadJson: JSON.stringify({ ...stored, execution }) })
    .where("id = :id", { id: approval.id })
    .andWhere("status = :status", { status: "approved" })
    .andWhere('"resultJson" IS NULL')
    .andWhere('"payloadJson" = :previousPayloadJson', { previousPayloadJson })
    .execute();
  if (updated.affected !== 1) {
    throw new BrowserApprovalError("Browser approval claim changed concurrently", 409);
  }
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
