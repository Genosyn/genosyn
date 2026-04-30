import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { Routine } from "../db/entities/Routine.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { runRoutine } from "./runner.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
} from "./integrations.js";
import { getProvider } from "../integrations/index.js";
import type {
  IntegrationConfig,
  IntegrationRuntimeContext,
} from "../integrations/types.js";

/**
 * Approval dispatch. Each `ApprovalKind` has its own create-helper and
 * its own `execute…` function; the route layer just calls
 * `executeApproval(approval)` after marking the row approved.
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
// Create helpers
// --------------------------------------------------------------------------

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
  const approval = repo.create({
    companyId: args.companyId,
    kind: "lightning_payment",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title: args.title,
    summary: args.summary ?? null,
    payloadJson: JSON.stringify({
      connectionId: args.connectionId,
      toolName: args.toolName,
      args: args.toolArgs,
      amountSats: args.amountSats,
      description: args.summary ?? undefined,
    } satisfies LightningPaymentPayload),
  });
  return repo.save(approval);
}

// --------------------------------------------------------------------------
// Execute (called from the route after a human approves)
// --------------------------------------------------------------------------

/**
 * Run the side-effect of an approval. Throws on failure — callers should
 * persist the error to `approval.errorMessage` and surface it.
 */
export async function executeApproval(approval: Approval): Promise<void> {
  switch (approval.kind) {
    case "routine":
      await executeRoutineApproval(approval);
      return;
    case "lightning_payment":
      await executeLightningPaymentApproval(approval);
      return;
    default:
      throw new Error(`Unknown approval kind: ${approval.kind}`);
  }
}

async function executeRoutineApproval(approval: Approval): Promise<void> {
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: approval.routineId,
  });
  if (!routine) throw new Error("Routine no longer exists");
  // Fire-and-forget — the routine runner persists progress to the Run
  // table. The HTTP caller doesn't wait for completion.
  runRoutine(routine).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[approvals] routine ${routine.id} failed post-approval:`,
      err,
    );
  });
}

async function executeLightningPaymentApproval(
  approval: Approval,
): Promise<void> {
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
    conn.encryptedConfig = encryptConnectionConfig(refreshed);
    conn.lastCheckedAt = new Date();
    conn.status = "connected";
    conn.statusMessage = "";
    await AppDataSource.getRepository(IntegrationConnection).save(conn);
  }
  approval.resultJson = JSON.stringify(result);
  await AppDataSource.getRepository(Approval).save(approval);
}

// --------------------------------------------------------------------------
// Reject hook
// --------------------------------------------------------------------------

export async function recordApprovalRejection(
  approval: Approval,
): Promise<void> {
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
        ? `Payment rejected: ${approval.summary}`
        : "Lightning payment rejected.";
      await AppDataSource.getRepository(JournalEntry).save(
        AppDataSource.getRepository(JournalEntry).create({
          employeeId: approval.employeeId,
          kind: "system",
          title: approval.title ?? "Lightning payment rejected",
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
