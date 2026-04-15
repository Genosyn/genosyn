import { Router } from "express";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { User } from "../db/entities/User.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";

/**
 * Company audit trail. Read-only — events are written by {@link recordAudit}
 * at the route seam. The list endpoint hydrates actor user info so the UI
 * can render "Alice approved routine X" without extra round-trips.
 */
export const auditRouter = Router({ mergeParams: true });
auditRouter.use(requireAuth);
auditRouter.use(requireCompanyMember);

auditRouter.get("/audit", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const take = Math.min(500, Math.max(1, parseInt(String(req.query.take ?? "200"), 10) || 200));
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: cid },
    order: { createdAt: "DESC" },
    take,
  });
  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const users = userIds.length
    ? await AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  res.json(
    rows.map((r) => {
      const u = r.actorUserId ? byId.get(r.actorUserId) : null;
      let metadata: Record<string, unknown> | null = null;
      if (r.metadataJson) {
        try {
          metadata = JSON.parse(r.metadataJson);
        } catch {
          metadata = null;
        }
      }
      return {
        id: r.id,
        companyId: r.companyId,
        actorKind: r.actorKind,
        actorUserId: r.actorUserId,
        actor: u ? { id: u.id, name: u.name, email: u.email } : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        targetLabel: r.targetLabel,
        metadata,
        createdAt: r.createdAt,
      };
    }),
  );
});
