import { AppDataSource } from "../db/datasource.js";
import { AuditEvent, AuditActorKind } from "../db/entities/AuditEvent.js";

/**
 * Append-only audit log. Called at the route seam (and from a few services —
 * cron, webhooks, approvals) whenever state changes within a company. Never
 * throws: a failed audit write must not break the mutation it was observing.
 */
export async function recordAudit(params: {
  companyId: string;
  actorKind?: AuditActorKind;
  actorUserId?: string | null;
  actorEmployeeId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  targetLabel?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(AuditEvent);
    const resolvedKind: AuditActorKind =
      params.actorKind ??
      (params.actorEmployeeId
        ? "ai"
        : params.actorUserId
          ? "user"
          : "system");
    const row = repo.create({
      companyId: params.companyId,
      actorKind: resolvedKind,
      actorUserId: params.actorUserId ?? null,
      actorEmployeeId: params.actorEmployeeId ?? null,
      action: params.action,
      targetType: params.targetType ?? "",
      targetId: params.targetId ?? null,
      targetLabel: params.targetLabel ?? "",
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : "",
    });
    await repo.save(row);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[audit] failed to record event", params.action, err);
  }
}
