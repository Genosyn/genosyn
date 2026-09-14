import { In, Not, type FindOptionsSelect } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Approval } from "../db/entities/Approval.js";

/** Expose only the server-recorded Run identity, never arbitrary approval results. */
export function proactiveWorkRunId(approval: Approval): string | null {
  if (approval.kind !== "proactive_work") return null;
  try {
    const result = JSON.parse(approval.resultJson ?? "null") as { runId?: unknown } | null;
    return typeof result?.runId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.runId)
      ? result.runId
      : null;
  } catch {
    return null;
  }
}

/** Keep waiting work visible even when newer completed reviews fill the history. */
export type ApprovalInboxFilter = "proactive_work" | "mail_send" | "decision_stack" | "other";

/**
 * Approval payloads are replay material, not list data. In particular, one
 * mail review may carry several megabytes of exact attachment bytes. Keep the
 * inbox query lightweight; callers that need kind-specific details hydrate
 * and serialize one row at a time so a full stack never retains every raw
 * payload in process memory.
 */
export const approvalInboxSelect = {
  id: true,
  companyId: true,
  kind: true,
  routineId: true,
  employeeId: true,
  title: true,
  summary: true,
  errorMessage: true,
  status: true,
  requestedAt: true,
  decidedAt: true,
  decidedByUserId: true,
} satisfies FindOptionsSelect<Approval>;

export async function listApprovalInbox(companyId: string, kind?: ApprovalInboxFilter) {
  const repo = AppDataSource.getRepository(Approval);
  if (!kind)
    return repo.find({
      where: { companyId },
      select: approvalInboxSelect,
      order: { requestedAt: "DESC" },
      take: 200,
    });
  const kindWhere =
    kind === "other"
      ? Not(In(["proactive_work", "mail_send"]))
      : In(kind === "decision_stack" ? ["proactive_work", "mail_send"] : [kind]);
  const [pending, history] = await Promise.all([
    repo.find({
      where: { companyId, kind: kindWhere, status: "pending" },
      select: approvalInboxSelect,
      order: { requestedAt: "ASC" },
      take: 200,
    }),
    repo.find({
      where: { companyId, kind: kindWhere, status: Not("pending") },
      select: approvalInboxSelect,
      order: { requestedAt: "DESC" },
      take: 50,
    }),
  ]);
  return [...pending, ...history];
}
