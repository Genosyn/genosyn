import { IsNull, MoreThan } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { recordAudit } from "./audit.js";

/**
 * How long one actor's edits to one record collapse into a single History
 * entry. A note autosaves every couple of seconds while someone types; the
 * History should say "Ada edited this note", once, not two hundred times.
 */
export const AUDIT_COALESCE_WINDOW_MS = 10 * 60 * 1000;

type CoalescedAuditParams = Parameters<typeof recordAudit>[0] & {
  targetType: string;
  targetId: string;
};

/**
 * {@link recordAudit} for high-frequency edit endpoints (autosaving editors):
 * skipped when the same actor already logged the same action on the same
 * record inside the window. The lookup rides the
 * (companyId, targetType, targetId, createdAt) index, so it reads at most a
 * handful of recent rows for one record.
 */
export async function recordCoalescedAudit(params: CoalescedAuditParams): Promise<void> {
  try {
    const since = new Date(Date.now() - AUDIT_COALESCE_WINDOW_MS);
    const recent = await AppDataSource.getRepository(AuditEvent).findOne({
      where: {
        companyId: params.companyId,
        targetType: params.targetType,
        targetId: params.targetId,
        action: params.action,
        actorUserId: params.actorUserId ? params.actorUserId : IsNull(),
        actorEmployeeId: params.actorEmployeeId ? params.actorEmployeeId : IsNull(),
        createdAt: MoreThan(since),
      },
      select: { id: true },
    });
    if (recent) return;
  } catch {
    // Fall through: a missed coalesce costs one extra row, a missed audit
    // costs the History its truth.
  }
  await recordAudit(params);
}
