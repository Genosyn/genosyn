import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { encryptSecret, decryptSecret } from "../lib/secret.js";
import { getProvider } from "../integrations/index.js";
import type {
  IntegrationConfig,
  IntegrationRuntimeContext,
} from "../integrations/types.js";

/**
 * Service layer for Integration Connections + Grants.
 *
 * Wraps the two entities with:
 *  - Encrypt / decrypt of the JSON config blob (reusing the same
 *    sessionSecret-derived AES-256-GCM key as `secrets` and AIModel apikeys).
 *  - Status refresh via the provider's `checkStatus` hook.
 *  - Tool invocation with automatic re-persist if the provider refreshes
 *    tokens inside the handler (Gmail's OAuth flow depends on this).
 */

export type ConnectionDTO = {
  id: string;
  companyId: string;
  provider: string;
  label: string;
  authMode: "apikey" | "oauth2";
  accountHint: string;
  status: "connected" | "error" | "expired";
  statusMessage: string;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeConnection(c: IntegrationConnection): ConnectionDTO {
  return {
    id: c.id,
    companyId: c.companyId,
    provider: c.provider,
    label: c.label,
    authMode: c.authMode,
    accountHint: c.accountHint,
    status: c.status,
    statusMessage: c.statusMessage,
    lastCheckedAt: c.lastCheckedAt ? c.lastCheckedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function listConnections(companyId: string): Promise<IntegrationConnection[]> {
  return AppDataSource.getRepository(IntegrationConnection).find({
    where: { companyId },
    order: { createdAt: "ASC" },
  });
}

export async function getConnection(
  companyId: string,
  id: string,
): Promise<IntegrationConnection | null> {
  return AppDataSource.getRepository(IntegrationConnection).findOneBy({
    companyId,
    id,
  });
}

export function decryptConnectionConfig(c: IntegrationConnection): IntegrationConfig {
  const raw = decryptSecret(c.encryptedConfig);
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IntegrationConfig;
    }
  } catch {
    // fall through
  }
  throw new Error("Integration config is corrupted or was encrypted with a different sessionSecret.");
}

export function encryptConnectionConfig(cfg: IntegrationConfig): string {
  return encryptSecret(JSON.stringify(cfg));
}

/**
 * Create a new API-key connection. Validates with the provider, encrypts,
 * persists. Returns the stored row.
 */
export async function createApiKeyConnection(args: {
  companyId: string;
  provider: string;
  label: string;
  fields: Record<string, string>;
}): Promise<IntegrationConnection> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (provider.catalog.authMode !== "apikey") {
    throw new Error(`${provider.catalog.name} is not an API-key integration`);
  }
  if (!provider.validateApiKey) {
    throw new Error(`${provider.catalog.name} has no API-key validator`);
  }
  const { config, accountHint } = await provider.validateApiKey(args.fields);
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const row = repo.create({
    companyId: args.companyId,
    provider: args.provider,
    label: args.label.trim() || provider.catalog.name,
    authMode: "apikey",
    encryptedConfig: encryptConnectionConfig(config),
    accountHint,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await repo.save(row);
  return row;
}

/**
 * Persist a freshly-completed OAuth handshake. Called from the oauth
 * callback once we have tokens + userInfo.
 */
export async function createOauthConnection(args: {
  companyId: string;
  provider: string;
  label: string;
  config: IntegrationConfig;
  accountHint: string;
}): Promise<IntegrationConnection> {
  const provider = getProvider(args.provider);
  if (!provider) throw new Error(`Unknown integration: ${args.provider}`);
  if (provider.catalog.authMode !== "oauth2") {
    throw new Error(`${provider.catalog.name} is not an OAuth integration`);
  }
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const row = repo.create({
    companyId: args.companyId,
    provider: args.provider,
    label: args.label.trim() || provider.catalog.name,
    authMode: "oauth2",
    encryptedConfig: encryptConnectionConfig(args.config),
    accountHint: args.accountHint,
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await repo.save(row);
  return row;
}

export async function deleteConnection(
  companyId: string,
  id: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(IntegrationConnection);
  const existing = await repo.findOneBy({ companyId, id });
  if (!existing) return false;
  // Grants cascade via the orphan cleanup below — SQLite FK enforcement is
  // off by default so we delete manually.
  await AppDataSource.getRepository(EmployeeConnectionGrant).delete({
    connectionId: id,
  });
  await repo.delete({ id });
  return true;
}

/**
 * Run the provider's cheap health check. Updates `status` + `lastCheckedAt`.
 * Returns the updated row (fresh from the repo after save).
 */
export async function refreshConnectionStatus(
  conn: IntegrationConnection,
): Promise<IntegrationConnection> {
  const provider = getProvider(conn.provider);
  if (!provider || !provider.checkStatus) {
    conn.lastCheckedAt = new Date();
    conn.status = "connected";
    conn.statusMessage = "";
    await AppDataSource.getRepository(IntegrationConnection).save(conn);
    return conn;
  }
  let cfg: IntegrationConfig;
  try {
    cfg = decryptConnectionConfig(conn);
  } catch (err) {
    conn.status = "error";
    conn.statusMessage = err instanceof Error ? err.message : String(err);
    conn.lastCheckedAt = new Date();
    await AppDataSource.getRepository(IntegrationConnection).save(conn);
    return conn;
  }
  let refreshed: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    config: cfg,
    setConfig(next) {
      refreshed = next;
    },
  };
  const result = await provider.checkStatus(ctx);
  if (refreshed) {
    conn.encryptedConfig = encryptConnectionConfig(refreshed);
  }
  conn.lastCheckedAt = new Date();
  if (result.ok) {
    conn.status = "connected";
    conn.statusMessage = "";
  } else {
    conn.status = "error";
    conn.statusMessage = result.message ?? "Unknown error";
  }
  await AppDataSource.getRepository(IntegrationConnection).save(conn);
  return conn;
}

// -------- Grants --------

export type GrantDTO = {
  id: string;
  employeeId: string;
  connectionId: string;
  createdAt: string;
  connection: ConnectionDTO;
};

export async function listGrantsForEmployee(
  employeeId: string,
): Promise<Array<EmployeeConnectionGrant & { connection: IntegrationConnection }>> {
  const grants = await AppDataSource.getRepository(EmployeeConnectionGrant).find({
    where: { employeeId },
    order: { createdAt: "ASC" },
  });
  if (grants.length === 0) return [];
  const conns = await AppDataSource.getRepository(IntegrationConnection).find({
    where: { id: In(grants.map((g) => g.connectionId)) },
  });
  const byId = new Map(conns.map((c) => [c.id, c] as const));
  return grants
    .filter((g) => byId.has(g.connectionId))
    .map((g) => Object.assign(g, { connection: byId.get(g.connectionId)! }));
}

export async function grantAccess(
  employeeId: string,
  connectionId: string,
): Promise<EmployeeConnectionGrant> {
  const repo = AppDataSource.getRepository(EmployeeConnectionGrant);
  const existing = await repo.findOneBy({ employeeId, connectionId });
  if (existing) return existing;
  const row = repo.create({ employeeId, connectionId });
  await repo.save(row);
  return row;
}

export async function revokeAccess(
  employeeId: string,
  connectionId: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(EmployeeConnectionGrant);
  const existing = await repo.findOneBy({ employeeId, connectionId });
  if (!existing) return false;
  await repo.delete({ id: existing.id });
  return true;
}

export async function getGrantWithConnection(
  employeeId: string,
  connectionId: string,
): Promise<
  { grant: EmployeeConnectionGrant; connection: IntegrationConnection } | null
> {
  const grant = await AppDataSource.getRepository(EmployeeConnectionGrant).findOneBy({
    employeeId,
    connectionId,
  });
  if (!grant) return null;
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy(
    { id: connectionId },
  );
  if (!connection) return null;
  return { grant, connection };
}

/**
 * Load every {connection, provider} pair an employee has been granted. The
 * MCP dispatcher uses this to advertise tools to the AI CLI.
 */
export async function loadEmployeeConnections(
  employee: AIEmployee,
): Promise<
  Array<{
    grant: EmployeeConnectionGrant;
    connection: IntegrationConnection;
  }>
> {
  const grants = await listGrantsForEmployee(employee.id);
  return grants
    .filter((g) => g.connection.companyId === employee.companyId)
    .map(({ connection, ...rest }) => ({
      grant: rest as EmployeeConnectionGrant,
      connection,
    }));
}

/**
 * Invoke one tool on behalf of an employee. Handles:
 *   - authorization (employee must have an active grant on the connection)
 *   - decrypt → provider.invokeTool → re-encrypt if the provider rotated
 *     credentials (OAuth refresh)
 *   - status bookkeeping (tool error ≠ connection error; connection error
 *     only when decrypt / auth fails)
 */
export async function invokeConnectionTool(args: {
  employee: AIEmployee;
  connectionId: string;
  toolName: string;
  toolArgs: unknown;
}): Promise<unknown> {
  const pair = await getGrantWithConnection(args.employee.id, args.connectionId);
  if (!pair) {
    throw new Error("No grant: you do not have access to this connection.");
  }
  if (pair.connection.companyId !== args.employee.companyId) {
    throw new Error("Connection belongs to a different company.");
  }
  const provider = getProvider(pair.connection.provider);
  if (!provider) throw new Error(`Unknown provider: ${pair.connection.provider}`);
  const tool = provider.tools.find((t) => t.name === args.toolName);
  if (!tool) throw new Error(`Unknown tool: ${args.toolName}`);

  const cfg = decryptConnectionConfig(pair.connection);
  let refreshed: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    config: cfg,
    setConfig(next) {
      refreshed = next;
    },
  };

  const result = await provider.invokeTool(args.toolName, args.toolArgs, ctx);
  if (refreshed) {
    pair.connection.encryptedConfig = encryptConnectionConfig(refreshed);
    pair.connection.lastCheckedAt = new Date();
    pair.connection.status = "connected";
    pair.connection.statusMessage = "";
    await AppDataSource.getRepository(IntegrationConnection).save(pair.connection);
  }
  return result;
}
