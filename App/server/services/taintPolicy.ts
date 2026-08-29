import { config } from "../../config.js";
import { getAgentSettings } from "./runtimeSettings.js";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";
import { isTokenTainted } from "./mcpTokens.js";
import { notifyApprovalPending } from "./notifications.js";
import { approvalArgsPreview, redactApprovalSummary } from "./approvalRedaction.js";

/**
 * The taint-aware turn policy (M53) — M50's named deferral, in its narrowest
 * honest cut. The open web is where hostile content meets side effects: a
 * page an employee fetched can address the model directly, and the two
 * things such content most wants are an outbound email and a persistent
 * foothold (a Routine that re-runs the injected instructions on a schedule).
 *
 * So: the web tools mark the turn's MCP token tainted, and the sink tools —
 * `send_mail` and the Routine writers — queue an Approval (kind
 * `tainted_tool`) instead of executing when the turn is tainted. Approving
 * replays the verbatim call server-side through a fresh internal token, so
 * the handler that runs is exactly the one that would have run, audits and
 * all. There is no untaint: the model has already read whatever the page
 * said.
 *
 * Deliberately NOT covered yet (each a named roadmap follow-up): mail read
 * as a taint source (it would gate every send-grant employee's every send),
 * and the connector compose tools (`gmail_send_message`), which dispatch
 * through the Integration surface rather than the static catalogue.
 */

/** The sinks a tainted turn may not fire directly. A closed allowlist on
 * both ends: the gate consults it, and the replay refuses anything else so a
 * forged payload cannot become an arbitrary-tool trampoline. */
export const TAINT_SINK_TOOLS = new Set([
  "send_mail",
  "create_routine",
  "update_routine",
  "delete_routine",
]);

/** The sources that taint a turn. Marked at dispatch rather than on success —
 * strictly more conservative, and one seam instead of three handlers. */
export const WEB_TAINT_SOURCES = new Set(["search_web", "fetch_web_page", "download_web_file"]);

export type TaintedToolPayload = {
  tool: string;
  args: Record<string, unknown>;
  employeeId: string;
};

export function parseTaintedToolPayload(raw: string | null): TaintedToolPayload {
  if (!raw) throw new Error("Tainted-tool payload is missing");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Tainted-tool payload is malformed");
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.tool !== "string" || !TAINT_SINK_TOOLS.has(p.tool)) {
    throw new Error("Tainted-tool payload names a tool the policy does not cover");
  }
  if (typeof p.args !== "object" || p.args === null) {
    throw new Error("Tainted-tool payload is missing the call");
  }
  if (typeof p.employeeId !== "string" || !p.employeeId) {
    throw new Error("Tainted-tool payload is missing the employee");
  }
  return { tool: p.tool, args: p.args as Record<string, unknown>, employeeId: p.employeeId };
}

/** Whether this turn's call to `toolName` must queue instead of execute. */
export function taintGateApplies(token: string | undefined, toolName: string): boolean {
  if (getAgentSettings().taintPolicy === "off") return false;
  if (!token) return false;
  if (!TAINT_SINK_TOOLS.has(toolName)) return false;
  return isTokenTainted(token);
}

/**
 * Queue the held call. Mirrors `createMcpToolApproval`: title/summary are
 * scrubbed at creation; the raw call lives only in `payloadJson`, which no
 * read boundary returns.
 */
export async function createTaintedToolApproval(args: {
  companyId: string;
  employeeId: string;
  tool: string;
  toolArgs: Record<string, unknown>;
}): Promise<Approval> {
  const repo = AppDataSource.getRepository(Approval);
  const approval = repo.create({
    companyId: args.companyId,
    kind: "tainted_tool",
    routineId: "",
    employeeId: args.employeeId,
    status: "pending",
    title: redactApprovalSummary(`Tainted turn · ${args.tool}`),
    summary: redactApprovalSummary(
      `This turn read web content before calling ${args.tool}. Held for review: ` +
        approvalArgsPreview(args.toolArgs).slice(0, 300),
    ),
    payloadJson: JSON.stringify({
      tool: args.tool,
      args: args.toolArgs,
      employeeId: args.employeeId,
    } satisfies TaintedToolPayload),
  });
  const saved = await repo.save(approval);
  void notifyApprovalPending(saved).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[taint] failed to notify approval ${saved.id}:`, err);
  });
  return saved;
}

/**
 * The executor behind an approved `tainted_tool`: replay the verbatim call
 * through the loopback internal API with a fresh employee-authority token —
 * the exact handler, audits, journals, and grant checks that would have run,
 * minus the taint. Throwing marks the Approval `execution_failed`.
 */
export async function executeTaintedToolApproval(approval: Approval): Promise<void> {
  const payload = parseTaintedToolPayload(approval.payloadJson);
  if (payload.employeeId !== approval.employeeId) {
    throw new Error("Tainted-tool payload does not match the approval's employee");
  }
  const { issueMcpToken, revokeMcpToken } = await import("./mcpTokens.js");
  // Employee authority: the replay carries exactly what the employee's own
  // Routine Runs carry — the authority the original call would have had.
  const token = issueMcpToken(payload.employeeId, approval.companyId, {
    authority: "employee",
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.port}/api/internal/mcp/tools/${payload.tool}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload.args),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // keep raw text
      }
      throw new Error(`The approved call failed: ${message.slice(0, 500)}`);
    }
    approval.resultJson = text.slice(0, 16_000);
    await AppDataSource.getRepository(Approval).save(approval);
  } finally {
    revokeMcpToken(token);
  }
}
