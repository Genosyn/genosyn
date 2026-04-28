import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { getProvider, listCatalog } from "../integrations/index.js";
import {
  createApiKeyConnection,
  createServiceAccountConnection,
  deleteConnection,
  getConnection,
  grantAccess,
  listConnections,
  listGrantsForConnection,
  listGrantsForEmployee,
  refreshConnectionStatus,
  revokeAccess,
  serializeConnection,
  updateApiKeyCredentials,
  updateConnectionLabel,
  updateServiceAccountCredentials,
} from "../services/integrations.js";
import { startOauth, startOauthReconnect } from "../services/oauth.js";
import { recordAudit } from "../services/audit.js";

/**
 * Company-scoped routes for the Integrations + Connections feature.
 * Mounted under `/api/companies/:cid/integrations`.
 *
 * Sub-routes:
 *   GET  /catalog                               — available integration types
 *   GET  /connections                           — list connections
 *   POST /connections                           — create API-key connection
 *   POST /connections/:connId/check             — refresh status
 *   DELETE /connections/:connId                 — remove connection + grants
 *   POST /oauth/start                           — begin OAuth handshake
 *   GET  /connections/:connId/grants            — list employees granted on a connection
 *   GET  /employees/:eid/grants                 — list an employee's grants
 *   POST /employees/:eid/grants                 — grant connection to employee
 *   DELETE /employees/:eid/grants/:connId       — revoke grant
 *
 * The *public* OAuth callback (`/api/integrations/oauth/callback/:app`) is
 * mounted separately on purpose — Google redirects the user's browser there
 * without our session cookie, so it can't be gated by `requireAuth`.
 */
export const integrationsRouter = Router({ mergeParams: true });
integrationsRouter.use(requireAuth);
integrationsRouter.use(requireCompanyMember);

integrationsRouter.get("/catalog", async (_req, res) => {
  res.json(listCatalog());
});

integrationsRouter.get("/connections", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const conns = await listConnections(cid);
  res.json(conns.map(serializeConnection));
});

const createConnectionSchema = z.object({
  provider: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  fields: z.record(z.string().max(20_000)),
});

integrationsRouter.post(
  "/connections",
  validateBody(createConnectionSchema),
  async (req, res) => {
    const { cid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof createConnectionSchema>;
    const provider = getProvider(body.provider);
    if (!provider) return res.status(400).json({ error: "Unknown integration" });
    if (provider.catalog.authMode !== "apikey") {
      return res.status(400).json({
        error: `${provider.catalog.name} must be connected via OAuth — call /oauth/start instead.`,
      });
    }
    try {
      const row = await createApiKeyConnection({
        companyId: cid,
        provider: body.provider,
        label: body.label,
        fields: body.fields,
      });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "connection.create",
        targetType: "connection",
        targetId: row.id,
        targetLabel: `${provider.catalog.name} · ${row.label}`,
        metadata: { provider: row.provider, authMode: "apikey" },
      });
      res.json(serializeConnection(row));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to create connection",
      });
    }
  },
);

const updateConnectionSchema = z.object({
  label: z.string().min(1).max(80),
});

integrationsRouter.patch(
  "/connections/:connId",
  validateBody(updateConnectionSchema),
  async (req, res) => {
    const { cid, connId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof updateConnectionSchema>;
    const updated = await updateConnectionLabel(cid, connId, body.label);
    if (!updated) return res.status(404).json({ error: "Connection not found" });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "connection.update",
      targetType: "connection",
      targetId: updated.id,
      targetLabel: `${updated.provider} · ${updated.label}`,
      metadata: { provider: updated.provider, label: updated.label },
    });
    res.json(serializeConnection(updated));
  },
);

integrationsRouter.post("/connections/:connId/check", async (req, res) => {
  const { cid, connId } = req.params as Record<string, string>;
  const existing = await getConnection(cid, connId);
  if (!existing) return res.status(404).json({ error: "Connection not found" });
  const updated = await refreshConnectionStatus(existing);
  res.json(serializeConnection(updated));
});

integrationsRouter.delete("/connections/:connId", async (req, res) => {
  const { cid, connId } = req.params as Record<string, string>;
  const existing = await getConnection(cid, connId);
  if (!existing) return res.status(404).json({ error: "Connection not found" });
  await deleteConnection(cid, connId);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "connection.delete",
    targetType: "connection",
    targetId: existing.id,
    targetLabel: `${existing.provider} · ${existing.label}`,
    metadata: { provider: existing.provider },
  });
  res.json({ ok: true });
});

const oauthStartSchema = z.object({
  provider: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(512),
  scopeGroups: z.array(z.string().min(1).max(64)).max(64).default([]),
});

integrationsRouter.post(
  "/oauth/start",
  validateBody(oauthStartSchema),
  async (req, res) => {
    const { cid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof oauthStartSchema>;
    try {
      const out = startOauth({
        companyId: cid,
        userId: req.userId!,
        provider: body.provider,
        label: body.label,
        clientId: body.clientId.trim(),
        clientSecret: body.clientSecret.trim(),
        scopeGroups: body.scopeGroups,
      });
      res.json(out);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to start OAuth",
      });
    }
  },
);

const serviceAccountSchema = z.object({
  provider: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  // The full JSON the user downloaded from Google Cloud Console. Pasted as
  // a string and parsed server-side so we can reject malformed JSON with a
  // clean error.
  keyJson: z.string().min(1).max(20_000),
  impersonationEmail: z.string().email().max(254).optional(),
  scopeGroups: z.array(z.string().min(1).max(64)).max(64).default([]),
});

integrationsRouter.post(
  "/connections/service-account",
  validateBody(serviceAccountSchema),
  async (req, res) => {
    const { cid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof serviceAccountSchema>;
    let keyJson: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body.keyJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected an object");
      }
      keyJson = parsed as Record<string, unknown>;
    } catch (err) {
      return res.status(400).json({
        error: `Could not parse service-account JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const provider = getProvider(body.provider);
    if (!provider) {
      return res.status(400).json({ error: "Unknown integration" });
    }
    if (!provider.catalog.serviceAccount) {
      return res.status(400).json({
        error: `${provider.catalog.name} does not support service accounts.`,
      });
    }
    try {
      const row = await createServiceAccountConnection({
        companyId: cid,
        provider: body.provider,
        label: body.label,
        keyJson,
        impersonationEmail: body.impersonationEmail,
        scopeGroups: body.scopeGroups,
      });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "connection.create",
        targetType: "connection",
        targetId: row.id,
        targetLabel: `${provider.catalog.name} · ${row.label}`,
        metadata: { provider: row.provider, authMode: "service_account" },
      });
      res.json(serializeConnection(row));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to add service account",
      });
    }
  },
);

// ---------- Reconnect ----------
//
// Reconnect = replace credentials on an existing connection in place.
// Keeping the row id stable preserves every employee grant and the audit
// history; deleting + recreating would silently revoke access for the
// whole team. Three sub-routes, one per auth mode.

const reconnectOauthSchema = z.object({
  scopeGroups: z.array(z.string().min(1).max(64)).max(64).optional(),
});

integrationsRouter.post(
  "/connections/:connId/reconnect/oauth",
  validateBody(reconnectOauthSchema),
  async (req, res) => {
    const { cid, connId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof reconnectOauthSchema>;
    try {
      const out = await startOauthReconnect({
        companyId: cid,
        userId: req.userId!,
        connectionId: connId,
        scopeGroups: body.scopeGroups,
      });
      res.json(out);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to start reconnect",
      });
    }
  },
);

const reconnectApiKeySchema = z.object({
  fields: z.record(z.string().max(20_000)),
});

integrationsRouter.put(
  "/connections/:connId/credentials",
  validateBody(reconnectApiKeySchema),
  async (req, res) => {
    const { cid, connId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof reconnectApiKeySchema>;
    try {
      const updated = await updateApiKeyCredentials({
        companyId: cid,
        connectionId: connId,
        fields: body.fields,
      });
      if (!updated) return res.status(404).json({ error: "Connection not found" });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "connection.reconnect",
        targetType: "connection",
        targetId: updated.id,
        targetLabel: `${updated.provider} · ${updated.label}`,
        metadata: { provider: updated.provider, authMode: "apikey" },
      });
      res.json(serializeConnection(updated));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to reconnect",
      });
    }
  },
);

const reconnectServiceAccountSchema = z.object({
  keyJson: z.string().min(1).max(20_000),
  impersonationEmail: z.string().email().max(254).optional(),
  scopeGroups: z.array(z.string().min(1).max(64)).max(64).optional(),
});

integrationsRouter.put(
  "/connections/:connId/service-account",
  validateBody(reconnectServiceAccountSchema),
  async (req, res) => {
    const { cid, connId } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof reconnectServiceAccountSchema>;
    let keyJson: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body.keyJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected an object");
      }
      keyJson = parsed as Record<string, unknown>;
    } catch (err) {
      return res.status(400).json({
        error: `Could not parse service-account JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      // If the client didn't send scopeGroups, fall back to whatever was
      // last persisted on this connection (so reconnect can be a pure
      // key-rotation without needing to re-pick scopes).
      let scopeGroups = body.scopeGroups;
      if (!scopeGroups) {
        const existing = await getConnection(cid, connId);
        if (!existing) return res.status(404).json({ error: "Connection not found" });
        const dto = serializeConnection(existing);
        scopeGroups = dto.scopeGroups;
      }
      const updated = await updateServiceAccountCredentials({
        companyId: cid,
        connectionId: connId,
        keyJson,
        impersonationEmail: body.impersonationEmail,
        scopeGroups,
      });
      if (!updated) return res.status(404).json({ error: "Connection not found" });
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "connection.reconnect",
        targetType: "connection",
        targetId: updated.id,
        targetLabel: `${updated.provider} · ${updated.label}`,
        metadata: { provider: updated.provider, authMode: "service_account" },
      });
      res.json(serializeConnection(updated));
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "Failed to reconnect",
      });
    }
  },
);

// ---------- Grants ----------

async function loadEmployee(companyId: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({
    id: eid,
    companyId,
  });
}

integrationsRouter.get("/connections/:connId/grants", async (req, res) => {
  const { cid, connId } = req.params as Record<string, string>;
  const conn = await getConnection(cid, connId);
  if (!conn) return res.status(404).json({ error: "Connection not found" });
  const rows = await listGrantsForConnection(conn.id);
  res.json(
    rows
      .filter((r) => r.employee.companyId === cid)
      .map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        connectionId: r.connectionId,
        createdAt: r.createdAt.toISOString(),
        employee: {
          id: r.employee.id,
          name: r.employee.name,
          slug: r.employee.slug,
          role: r.employee.role,
          avatarKey: r.employee.avatarKey,
        },
      })),
  );
});

integrationsRouter.get("/employees/:eid/grants", async (req, res) => {
  const { cid, eid } = req.params as Record<string, string>;
  const emp = await loadEmployee(cid, eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const rows = await listGrantsForEmployee(emp.id);
  res.json(
    rows
      .filter((r) => r.connection.companyId === cid)
      .map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        connectionId: r.connectionId,
        createdAt: r.createdAt.toISOString(),
        connection: serializeConnection(r.connection),
      })),
  );
});

const createGrantSchema = z.object({
  connectionId: z.string().uuid(),
});

integrationsRouter.post(
  "/employees/:eid/grants",
  validateBody(createGrantSchema),
  async (req, res) => {
    const { cid, eid } = req.params as Record<string, string>;
    const body = req.body as z.infer<typeof createGrantSchema>;
    const emp = await loadEmployee(cid, eid);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const conn = await getConnection(cid, body.connectionId);
    if (!conn) return res.status(404).json({ error: "Connection not found" });
    const grant = await grantAccess(emp.id, conn.id);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "grant.create",
      targetType: "connection",
      targetId: conn.id,
      targetLabel: `${conn.provider} · ${conn.label} → ${emp.name}`,
      metadata: { employeeId: emp.id, connectionId: conn.id },
    });
    res.json({
      id: grant.id,
      employeeId: grant.employeeId,
      connectionId: grant.connectionId,
      createdAt: grant.createdAt.toISOString(),
      connection: serializeConnection(conn),
    });
  },
);

integrationsRouter.delete(
  "/employees/:eid/grants/:connId",
  async (req, res) => {
    const { cid, eid, connId } = req.params as Record<string, string>;
    const emp = await loadEmployee(cid, eid);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const conn = await getConnection(cid, connId);
    if (!conn) return res.status(404).json({ error: "Connection not found" });
    const ok = await revokeAccess(emp.id, conn.id);
    if (!ok) return res.status(404).json({ error: "Grant not found" });
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "grant.delete",
      targetType: "connection",
      targetId: conn.id,
      targetLabel: `${conn.provider} · ${conn.label} → ${emp.name}`,
      metadata: { employeeId: emp.id, connectionId: conn.id },
    });
    res.json({ ok: true });
  },
);
