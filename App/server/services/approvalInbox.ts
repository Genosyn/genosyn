import { Not } from "typeorm";
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
export async function listApprovalInbox(companyId: string, kind?: "proactive_work") {
  const repo = AppDataSource.getRepository(Approval);
  if (!kind)
    return repo.find({
      where: { companyId },
      order: { requestedAt: "DESC" },
      take: 200,
    });
  const [pending, history] = await Promise.all([
    repo.find({
      where: { companyId, kind, status: "pending" },
      order: { requestedAt: "ASC" },
      take: 200,
    }),
    repo.find({
      where: { companyId, kind, status: Not("pending") },
      order: { requestedAt: "DESC" },
      take: 50,
    }),
  ]);
  return [...pending, ...history];
}
